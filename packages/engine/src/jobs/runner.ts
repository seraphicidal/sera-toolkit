import { mkdir, open, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobProgress, JobResult, JobState, PackagingMode } from '@sera/contracts/types';
import type { EngineConfig } from '../config.js';
import { convert, probe, type ConversionSpec } from '../convert/ffmpeg.js';
import { seraError, SeraError } from '../errors.js';
import { downloadDirect } from '../extract/direct-download.js';
import { download as ytdlpDownload } from '../extract/ytdlp.js';
import { logSafeUrl, type Logger } from '../logging.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from '../providers/types.js';
import { planKey } from '../providers/types.js';
import { contradicts, sniffContainer, SNIFF_BYTES } from '../util/sniff.js';
import type { MediaResolver } from '../resolver.js';
import type { ExtractionNodeRegistry } from '../extract/remote.js';
import { mimeTypeFor, type Workspace, type WorkspaceManager } from '../storage/workspace.js';
import { dedupeFilename, mediaFilename, sanitizeStem } from '../util/filename.js';
import { createZip } from './zip.js';

/**
 * The download pipeline.
 *
 * One job may produce one file or fifty, from one URL, in mixed formats. The steps are
 * always the same — re-resolve, fetch, convert, name, package, validate — and progress
 * is reported as a single number across all of it, because "file 3 of 7 at 62%" is what
 * the person waiting actually wants to know.
 */

export interface JobSelection {
  /** Item index within the resolution, 0-based. */
  readonly itemIndex: number;
  /** The provider's id for that item, used to detect a shifted collection. */
  readonly sourceId?: string;
  /** `kind/container/label`, matched against the re-resolved plan list. */
  readonly planKey: string;
}

export interface JobSpec {
  readonly jobId: string;
  readonly provider: string;
  /** Canonical URL, exactly as the resolver produced it. */
  readonly url: string;
  readonly selections: readonly JobSelection[];
  readonly packaging: PackagingMode;
  /** User-supplied filename stem. Sanitized before use. */
  readonly filename?: string;
}

export interface JobUpdate {
  readonly state: JobState;
  readonly step: string;
  readonly progress: JobProgress;
}

export type ReportFn = (update: JobUpdate) => void;

export interface JobRunnerDependencies {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly resolver: MediaResolver;
  readonly workspaces: WorkspaceManager;
  /**
   * Extraction nodes on other networks.
   *
   * Only consulted for a resolution that came from one. A media URL signed for one
   * address is refused from another, so a job whose plans were made elsewhere has to be
   * carried out elsewhere too.
   */
  readonly remote?: ExtractionNodeRegistry;
}

/** Share of a single file's progress attributed to the download, versus conversion. */
const DOWNLOAD_SHARE = 0.85;

export class JobRunner {
  constructor(private readonly deps: JobRunnerDependencies) {}

  async run(spec: JobSpec, report: ReportFn, signal?: AbortSignal): Promise<JobResult> {
    const startedAt = Date.now();
    const { config, logger, resolver, workspaces } = this.deps;

    if (spec.selections.length > config.maxItemsPerJob) {
      throw seraError('TOO_LARGE', {
        message: `A single download can include at most ${config.maxItemsPerJob} items.`,
        detail: `${spec.selections.length} selections`,
      });
    }

    report({ state: 'resolving', step: 'Reading the link', progress: { percent: 0 } });

    // Re-resolving rather than trusting a URL from the client is what keeps expired CDN
    // links, and forged ones, out of the pipeline.
    const resolved = await resolver.resolveCanonical(new URL(spec.url), spec.provider, signal);
    const matched = spec.selections.map((selection) => matchSelection(resolved, selection));

    assertWithinLimits(matched, config);

    const workspace = await workspaces.create(spec.jobId);
    const totalFiles = matched.length;
    const produced: { path: string; name: string }[] = [];
    const taken = new Set<string>();

    // A resolution the local network could not produce cannot be downloaded here
    // either: YouTube binds a media URL to the address that asked for it. The node that
    // resolved this owns the whole job.
    const remoteBackend = resolved.metadata?.extractionBackend;
    if (remoteBackend && this.deps.remote) {
      report({ state: 'downloading', step: 'Downloading', progress: { percent: 0 } });
      const files = await this.deps.remote.dispatchJob(
        {
          kind: 'job',
          url: spec.url,
          providerId: spec.provider,
          planKeys: matched.map(({ plan }) => planKey(plan)),
          ...(spec.filename ? { filename: spec.filename } : {}),
        },
        {
          onProgress: (progress) =>
            report({
              state: 'downloading',
              step: progress.step,
              // Capped below 100 so the terminal states remain the runner's to set.
              progress: { percent: Math.min(99, progress.percent) },
            }),
          ...(signal ? { signal } : {}),
        },
      );

      for (const file of files) {
        const destination = workspace.outputPath(file.name);
        await rename(file.path, destination);
        produced.push({ path: destination, name: file.name });
      }

      logger.info(
        {
          jobId: spec.jobId,
          provider: spec.provider,
          extractionBackend: remoteBackend,
          files: produced.length,
        },
        'job completed on a remote extraction backend',
      );
    } else {
      for (const [index, { item, plan }] of matched.entries()) {
        if (signal?.aborted) throw seraError('CANCELLED');

        const fileProgress = (fraction: number, extra: Partial<JobProgress> = {}): JobProgress => ({
          percent: Math.min(99, ((index + Math.min(fraction, 1)) / totalFiles) * 100),
          ...(totalFiles > 1 ? { currentFile: index + 1, totalFiles } : {}),
          ...extra,
        });

        const downloaded = await this.fetchOne({
          workspace,
          resolved,
          item,
          plan,
          index,
          report,
          fileProgress,
          ...(signal ? { signal } : {}),
        });

        const converted = plan.convert
          ? await this.convertOne({
              input: downloaded,
              spec: plan.convert,
              workspace,
              index,
              report,
              fileProgress,
              ...(item.duration !== undefined ? { durationSeconds: item.duration } : {}),
              ...(signal ? { signal } : {}),
            })
          : downloaded;

        const name = dedupeFilename(
          this.nameFor(spec, resolved, item, plan, converted, totalFiles),
          taken,
        );
        const destination = workspace.outputPath(name);
        await rename(converted, destination);
        produced.push({ path: destination, name });
      }
    }

    const result = await this.package(spec, resolved, workspace, produced, report, signal);

    await workspace.clearScratch();
    await this.validate(produced, result);

    logger.info(
      {
        jobId: spec.jobId,
        provider: spec.provider,
        source: logSafeUrl(spec.url),
        files: produced.length,
        bytes: result.sizeBytes,
        durationMs: Date.now() - startedAt,
        outcome: 'success',
      },
      'job complete',
    );

    return result;
  }

  /* ------------------------------------------------------------------ */

  private async fetchOne(args: {
    workspace: Workspace;
    resolved: ResolvedMedia;
    item: ResolvedItem;
    plan: DownloadPlan;
    index: number;
    report: ReportFn;
    fileProgress: (fraction: number, extra?: Partial<JobProgress>) => JobProgress;
    signal?: AbortSignal;
  }): Promise<string> {
    const { config } = this.deps;
    const { workspace, plan, item, index, report, fileProgress, signal } = args;

    const scratch = join(workspace.scratchDir, `sel-${index}`);
    await mkdir(scratch, { recursive: true });

    const step = args.resolved.items.length > 1 ? `Downloading ${index + 1}` : 'Downloading';
    report({ state: 'downloading', step, progress: fileProgress(0) });

    if (plan.fetch.via === 'direct') {
      const destination = join(scratch, `media.${plan.container}`);
      await downloadDirect({
        url: plan.fetch.url,
        destination,
        dispatcher: this.deps.resolver.dispatcher,
        maxBytes: config.maxFilesizeBytes,
        timeoutMs: config.jobTimeoutSeconds * 1000,
        ...(signal ? { signal } : {}),
        onProgress: (progress) => {
          const fraction = progress.bytesTotal
            ? (progress.bytesDownloaded / progress.bytesTotal) * DOWNLOAD_SHARE
            : 0;
          report({
            state: 'downloading',
            step,
            progress: fileProgress(fraction, {
              bytesDownloaded: progress.bytesDownloaded,
              ...(progress.bytesTotal ? { bytesTotal: progress.bytesTotal } : {}),
              ...(progress.speedBytesPerSecond
                ? { speedBytesPerSecond: progress.speedBytesPerSecond }
                : {}),
              ...(progress.etaSeconds !== undefined ? { etaSeconds: progress.etaSeconds } : {}),
            }),
          });
        },
      });
      // The provider named this format before it had the file, from a URL or a header,
      // and either can be wrong — Bluesky's CDN serves WebP from URLs ending in `@jpeg`.
      // Renaming here is enough to correct everything downstream, because the produced
      // file's own extension is what names the download.
      return renameToActualFormat(destination, plan.container);
    }

    const fetchPlan = plan.fetch;
    let sawPostprocessor: string | undefined;

    await ytdlpDownload({
      binary: config.ytdlpPath,
      ffmpegPath: config.ffmpegPath,
      timeoutMs: config.jobTimeoutSeconds * 1000,
      url: args.resolved.url,
      format: fetchPlan.selector,
      workdir: scratch,
      // yt-dlp appends the real extension; a fixed stem makes the output easy to find.
      outputTemplate: 'media.%(ext)s',
      maxFilesizeBytes: config.maxFilesizeBytes,
      ...(fetchPlan.merge ? { mergeContainer: fetchPlan.merge } : {}),
      ...(fetchPlan.remux ? { remuxContainer: fetchPlan.remux } : {}),
      ...(fetchPlan.audio
        ? {
            audioFormat: fetchPlan.audio.format,
            ...(fetchPlan.audio.quality ? { audioQuality: fetchPlan.audio.quality } : {}),
          }
        : {}),
      ...(args.resolved.items.length > 1 ? { playlistItem: item.index + 1 } : {}),
      ...(plan.filesizeBytes ? { expectedTotalBytes: plan.filesizeBytes } : {}),
      ...(fetchPlan.extractorArgs ? { extractorArgs: fetchPlan.extractorArgs } : {}),
      ...(signal ? { signal } : {}),
      onProgress: (progress) => {
        if (progress.postprocessor && progress.postprocessor !== sawPostprocessor) {
          sawPostprocessor = progress.postprocessor;
        }
        const state: JobState = sawPostprocessor
          ? sawPostprocessor === 'ExtractAudio'
            ? 'converting'
            : 'merging'
          : 'downloading';
        report({
          state,
          step: sawPostprocessor ? stepForPostprocessor(sawPostprocessor, plan) : step,
          progress: fileProgress((progress.percent / 100) * DOWNLOAD_SHARE, {
            bytesDownloaded: progress.bytesDownloaded,
            ...(progress.bytesTotal ? { bytesTotal: progress.bytesTotal } : {}),
            ...(progress.speedBytesPerSecond
              ? { speedBytesPerSecond: progress.speedBytesPerSecond }
              : {}),
            ...(progress.etaSeconds !== undefined ? { etaSeconds: progress.etaSeconds } : {}),
          }),
        });
      },
    });

    return findSingleFile(scratch);
  }

  private async convertOne(args: {
    input: string;
    spec: ConversionSpec;
    workspace: Workspace;
    index: number;
    report: ReportFn;
    fileProgress: (fraction: number, extra?: Partial<JobProgress>) => JobProgress;
    durationSeconds?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const { config } = this.deps;
    const target = targetExtension(args.spec);
    const output = join(args.workspace.scratchDir, `sel-${args.index}`, `converted.${target}`);
    const step = `Converting to ${target.toUpperCase()}`;

    args.report({
      state: 'converting',
      step,
      progress: args.fileProgress(DOWNLOAD_SHARE),
    });

    await convert({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: config.jobTimeoutSeconds * 1000,
      input: args.input,
      output,
      spec: args.spec,
      ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      onProgress: (percent) => {
        args.report({
          state: 'converting',
          step,
          progress: args.fileProgress(DOWNLOAD_SHARE + (percent / 100) * (1 - DOWNLOAD_SHARE)),
        });
      },
    });

    return output;
  }

  private nameFor(
    spec: JobSpec,
    resolved: ResolvedMedia,
    item: ResolvedItem,
    plan: DownloadPlan,
    producedPath: string,
    totalFiles: number,
  ): string {
    const extension = producedPath.split('.').pop() ?? plan.container;
    if (spec.filename && totalFiles === 1) {
      return `${sanitizeStem(spec.filename)}.${extension}`;
    }
    return mediaFilename({
      author: resolved.author,
      title: item.title ?? resolved.title,
      container: extension,
      // A collection numbers its parts; a single file does not need a "(1)".
      ...(totalFiles > 1 || resolved.items.length > 1 ? { index: item.index + 1 } : {}),
    });
  }

  private async package(
    spec: JobSpec,
    resolved: ResolvedMedia,
    workspace: Workspace,
    produced: readonly { path: string; name: string }[],
    report: ReportFn,
    signal?: AbortSignal,
  ): Promise<JobResult> {
    const { config } = this.deps;
    const expiresAt = new Date(Date.now() + config.retentionSeconds * 1000).toISOString();

    const shouldZip =
      spec.packaging === 'zip' || (spec.packaging === 'auto' && produced.length > 1);

    const files = await Promise.all(
      produced.map(async (file) => ({
        name: file.name,
        sizeBytes: (await stat(file.path)).size,
        mimeType: mimeTypeFor(file.name),
        downloadPath: `/api/jobs/${spec.jobId}/files/${encodeURIComponent(file.name)}`,
      })),
    );

    if (!shouldZip) {
      const primary = files[0]!;
      await workspace.writeManifest({
        jobId: spec.jobId,
        createdAt: new Date().toISOString(),
        expiresAt,
        primary: primary.name,
        isArchive: false,
        files: files.map(({ name, sizeBytes, mimeType }) => ({ name, sizeBytes, mimeType })),
      });
      return {
        downloadPath: `/api/jobs/${spec.jobId}/download`,
        filename: primary.name,
        sizeBytes: primary.sizeBytes,
        mimeType: primary.mimeType,
        isArchive: false,
        ...(files.length > 1 ? { files } : {}),
        expiresAt,
      };
    }

    report({
      state: 'packaging',
      step: `Packaging ${produced.length} files`,
      progress: { percent: 99, totalFiles: produced.length },
    });

    const archiveName = `${sanitizeStem(
      spec.filename ?? [resolved.author, resolved.title].filter(Boolean).join(' - '),
      'media',
    )}.zip`;
    const archivePath = workspace.outputPath(archiveName);

    const { sizeBytes } = await createZip({
      entries: produced.map((file) => ({ path: file.path, name: file.name })),
      destination: archivePath,
      ...(signal ? { signal } : {}),
      onProgress: (percent, currentFile, totalFiles) => {
        report({
          state: 'packaging',
          step: `Packaging ${currentFile} of ${totalFiles}`,
          progress: { percent: 99, currentFile, totalFiles },
        });
      },
    });

    await workspace.writeManifest({
      jobId: spec.jobId,
      createdAt: new Date().toISOString(),
      expiresAt,
      primary: archiveName,
      isArchive: true,
      files: [
        { name: archiveName, sizeBytes, mimeType: 'application/zip' },
        ...files.map(({ name, sizeBytes: size, mimeType }) => ({
          name,
          sizeBytes: size,
          mimeType,
        })),
      ],
    });

    return {
      downloadPath: `/api/jobs/${spec.jobId}/download`,
      filename: archiveName,
      sizeBytes,
      mimeType: 'application/zip',
      isArchive: true,
      files,
      expiresAt,
    };
  }

  /**
   * Confirms the outputs are real media before the job is reported as ready.
   *
   * A zero-byte file or a truncated container is the difference between "your download
   * failed" and "your download succeeded and then did not play", and the second is much
   * worse. Images are checked for size only; ffprobe has nothing useful to say about a
   * JPEG that a byte count does not.
   */
  private async validate(
    produced: readonly { path: string; name: string }[],
    result: JobResult,
  ): Promise<void> {
    const { config } = this.deps;
    for (const file of produced) {
      const info = await stat(file.path).catch(() => undefined);
      if (!info || info.size === 0) {
        throw seraError('CONVERSION_FAILED', {
          message: 'The download finished but produced an empty file.',
          detail: `empty output: ${file.name}`,
        });
      }
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (
        ['mp4', 'webm', 'mov', 'mkv', 'mp3', 'm4a', 'opus', 'wav', 'flac', 'ogg'].includes(
          extension,
        )
      ) {
        const probed = await probe(file.path, {
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          timeoutMs: 30_000,
        }).catch(() => undefined);
        if (!probed || (!probed.video && !probed.audio)) {
          throw seraError('CONVERSION_FAILED', {
            message: 'The download finished but the file could not be verified.',
            detail: `unreadable output: ${file.name}`,
          });
        }
      }
    }
    if (result.sizeBytes <= 0) {
      throw seraError('CONVERSION_FAILED', { detail: 'result has no bytes' });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

interface MatchedSelection {
  readonly item: ResolvedItem;
  readonly plan: DownloadPlan;
}

/**
 * Finds the item and plan a token refers to in a fresh resolution.
 *
 * The provider's own item id is trusted over the index, so a carousel that gained a
 * slide overnight still downloads the slide the person picked. When the plan itself is
 * gone — a quality that stopped being published — the job fails with a message that says
 * so, rather than quietly substituting something else.
 */
export function matchSelection(resolved: ResolvedMedia, selection: JobSelection): MatchedSelection {
  const item =
    (selection.sourceId
      ? resolved.items.find((candidate) => candidate.sourceId === selection.sourceId)
      : undefined) ?? resolved.items[selection.itemIndex];

  if (!item) {
    throw seraError('EXPIRED', {
      message: 'That item is no longer part of this post.',
      detail: `item ${selection.itemIndex} not found among ${resolved.items.length}`,
    });
  }

  const plan = item.plans.find((candidate) => planKey(candidate) === selection.planKey);
  if (!plan) {
    throw seraError('EXPIRED', {
      message: 'The quality you chose is no longer available.',
      hint: 'Analyze the link again to see the current options.',
      detail: `plan ${selection.planKey} missing`,
    });
  }
  return { item, plan };
}

function assertWithinLimits(matched: readonly MatchedSelection[], config: EngineConfig): void {
  let total = 0;
  for (const { item, plan } of matched) {
    if (item.isLive) {
      throw seraError('LIVE_IN_PROGRESS');
    }
    if (item.duration && item.duration > config.maxDurationSeconds) {
      throw seraError('TOO_LONG', {
        message: `This server accepts media up to ${Math.round(config.maxDurationSeconds / 60)} minutes.`,
        detail: `${Math.round(item.duration)}s exceeds limit`,
      });
    }
    total += plan.filesizeBytes ?? 0;
  }
  if (total > config.maxFilesizeBytes) {
    throw seraError('TOO_LARGE', { detail: `${total} bytes across ${matched.length} items` });
  }
}

function targetExtension(spec: ConversionSpec): string {
  switch (spec.kind) {
    case 'audio':
      return spec.container;
    case 'remux':
      return spec.container;
    case 'video':
      return spec.container;
    case 'gif':
      return 'gif';
  }
}

function stepForPostprocessor(name: string, plan: DownloadPlan): string {
  switch (name) {
    case 'Merger':
      return 'Merging video and audio';
    case 'ExtractAudio':
      return `Converting to ${plan.container.toUpperCase()}`;
    case 'VideoRemuxer':
      return `Remuxing to ${plan.container.toUpperCase()}`;
    case 'MoveFiles':
      return 'Finishing up';
    default:
      return 'Processing';
  }
}

/** Locates the one media file yt-dlp produced in a per-selection scratch directory. */
async function findSingleFile(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
    .map((entry) => entry.name);

  if (!files.length) {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'The download completed without producing a file.',
      detail: `empty scratch dir ${directory}`,
    });
  }
  if (files.length === 1) return join(directory, files[0]!);

  // A merge can leave the source streams behind; the largest file is the merged result.
  const sized = await Promise.all(
    files.map(async (name) => ({
      name,
      size: await stat(join(directory, name))
        .then((s) => s.size)
        .catch(() => 0),
    })),
  );
  sized.sort((a, b) => b.size - a.size);
  return join(directory, sized[0]!.name);
}

export { SeraError };

/**
 * Corrects a downloaded file's extension to whatever its bytes say it is.
 *
 * Returns the path to use. A file whose format cannot be recognised keeps the name it
 * was given: guessing wrong twice is worse than guessing wrong once.
 */
async function renameToActualFormat(path: string, claimed: string): Promise<string> {
  let head: Buffer;
  try {
    const handle = await open(path, 'r');
    try {
      head = Buffer.alloc(SNIFF_BYTES);
      await handle.read(head, 0, SNIFF_BYTES, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return path;
  }

  const actual = sniffContainer(head);
  if (!actual || !contradicts(claimed, actual)) return path;

  const corrected = path.replace(/.[^.]+$/, `.${actual}`);
  await rename(path, corrected);
  return corrected;
}
