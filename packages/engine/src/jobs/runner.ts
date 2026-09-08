import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { JobProgress, JobResult, JobState, PackagingMode } from '@sera/contracts/types';
import type { EngineConfig } from '../config.js';
import { convert, probe, type ConversionSpec } from '../convert/ffmpeg.js';
import { seraError, SeraError } from '../errors.js';
import { downloadDirect } from '../extract/direct-download.js';
import { download as ytdlpDownload } from '../extract/ytdlp.js';
import { classifyFailure } from '../extract/failure.js';
import { logSafeUrl, type Logger } from '../logging.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from '../providers/types.js';
import { planKey } from '../providers/types.js';
import { contradicts, sniffContainer, sniffTextImposter, SNIFF_BYTES } from '../util/sniff.js';
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
    /** Anything the visitor asked for that had to be met with something else. */
    const delivered: { requested: string; actual: string }[] = [];

    // A resolution the local network could not produce cannot be downloaded here
    // either: YouTube binds a media URL to the address that asked for it. The node that
    // resolved this owns the whole job.
    const remoteBackend = resolved.remoteBackend;
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
      // The upload directory is empty now. Leaving it would mean one stray directory per
      // remote job until the reaper's retention window came round to it.
      //
      // Only a directory the upload endpoint itself created is removed. Deducing "the
      // parent of the file" and deleting that would be one wrong assumption away from
      // deleting a workspace, which is exactly what it did the first time it was written.
      const uploads = [...new Set(files.map((file) => dirname(file.path)))].filter((directory) =>
        basename(directory).startsWith('remote-'),
      );
      for (const directory of uploads) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }

      logger.info(
        {
          jobId: spec.jobId,
          provider: spec.provider,
          strategy: remoteBackend,
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

        const { path: downloaded, plan: used } = await this.fetchWithFallback({
          workspace,
          resolved,
          item,
          plan,
          index,
          report,
          fileProgress,
          ...(signal ? { signal } : {}),
        });
        if (used !== plan) delivered.push({ requested: plan.label, actual: used.label });

        const converted = used.convert
          ? await this.convertOne({
              input: downloaded,
              spec: used.convert,
              workspace,
              index,
              report,
              fileProgress,
              ...(item.duration !== undefined ? { durationSeconds: item.duration } : {}),
              ...(signal ? { signal } : {}),
            })
          : downloaded;

        const name = dedupeFilename(
          this.nameFor(spec, resolved, item, used, converted, totalFiles),
          taken,
        );
        const destination = workspace.outputPath(name);
        await rename(converted, destination);
        produced.push({ path: destination, name });
      }
    }

    const packaged = await this.package(spec, resolved, workspace, produced, report, signal);
    // Said out loud rather than left for someone to notice in the pixels: which backend
    // produced this, and anything that had to be met with a different rendition.
    const result: JobResult = {
      ...packaged,
      delivery: {
        backend: remoteBackend ?? 'local',
        ...(delivered.length ? { substituted: delivered } : {}),
      },
    };

    await workspace.clearScratch();
    await this.validate(produced, result);

    logger.info(
      {
        jobId: spec.jobId,
        provider: spec.provider,
        source: logSafeUrl(spec.url),
        strategy: remoteBackend ?? 'local',
        ...(delivered.length ? { substituted: delivered } : {}),
        mediaType: resolved.type,
        mediaKinds: [...new Set(matched.map(({ item }) => item.kind))],
        outputFormat: result.isArchive
          ? 'zip'
          : [...new Set(matched.map(({ plan }) => plan.container))].join(','),
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

  /**
   * The requested format, and then the next best one this item actually has.
   *
   * A format list is a snapshot. Between the moment it was read and the moment the
   * bytes are asked for, the one that was picked can stop being available — a signed
   * URL expires, a CDN refuses, a client's list changes underneath it. Failing the whole
   * job at that point throws away a perfectly good 720p because the 1080p went missing.
   *
   * Only for the failures a different format is an answer to, and only downward through
   * options this item already published: no re-resolving, no different media, and never
   * a different kind — someone who asked for video does not want an MP3 instead. Each
   * candidate is tried once, so this is a ladder and not a retry loop.
   */
  private async fetchWithFallback(args: {
    workspace: Workspace;
    resolved: ResolvedMedia;
    item: ResolvedItem;
    plan: DownloadPlan;
    index: number;
    report: ReportFn;
    fileProgress: (fraction: number, extra?: Partial<JobProgress>) => JobProgress;
    signal?: AbortSignal;
  }): Promise<{ path: string; plan: DownloadPlan }> {
    const candidates = [args.plan, ...lowerQualityAlternatives(args.item, args.plan)];

    for (const [attempt, plan] of candidates.entries()) {
      try {
        return { path: await this.fetchOne({ ...args, plan }), plan };
      } catch (error) {
        const failure = classifyFailure(error);
        const next = candidates[attempt + 1];
        if (!next || !FORMAT_FALLBACK_ANSWERS.has(failure)) throw error;

        this.deps.logger.info(
          {
            jobId: args.workspace.jobId,
            provider: args.resolved.provider,
            failureClass: failure,
            requested: plan.label,
            fallingBackTo: next.label,
          },
          'the requested format could not be fetched; stepping down',
        );
      }
    }

    /* istanbul ignore next -- the loop always returns or throws. */
    throw seraError('MEDIA_UNAVAILABLE', { detail: 'no format could be fetched' });
  }

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
      maxOutputBytes: config.maxFilesizeBytes,
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
      // A re-encode can be larger than what it was given, so the bound on the input is
      // not a bound on the output. FFmpeg is told to stop at the same ceiling; this is
      // what turns the truncated file it leaves behind into an answer that says why.
      if (info.size >= config.maxFilesizeBytes) {
        throw seraError('TOO_LARGE', {
          message: 'The converted file is larger than this server allows.',
          hint: 'Try a lower quality.',
          detail: `${info.size} bytes: ${file.name}`,
        });
      }

      // A refusal that arrived as a 200. A login page, a consent wall or a JSON error
      // saved under the extension the plan asked for is a .jpg that opens to "Log in to
      // continue" — and nothing else here would catch it, because it has no magic number
      // to contradict and no audio or video track to probe.
      const imposter = sniffTextImposter(await headOf(file.path));
      if (imposter) {
        throw seraError('MEDIA_UNAVAILABLE', {
          message: 'The source returned a page instead of the media.',
          hint: 'The post may have become private, or the site may be asking for a login.',
          detail: `${file.name} is ${imposter}, not media`,
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
        if (probed?.durationSeconds !== undefined && probed.durationSeconds <= 0) {
          throw seraError('CONVERSION_FAILED', {
            message: 'The download finished but the file has no playable content.',
            detail: `zero duration: ${file.name}`,
          });
        }
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
/**
 * Failures a different format is an answer to.
 *
 * A missing format and a refused or truncated stream are about *this* rendition. A bot
 * challenge, a private post or a login wall are about the whole request, and stepping
 * down the quality list would ask the same question in a smaller voice.
 */
const FORMAT_FALLBACK_ANSWERS = new Set([
  'FORMAT_UNAVAILABLE',
  'STREAM_403',
  'CDN_DOWNLOAD_FAILURE',
  'SOURCE_ERROR',
]);

/**
 * The same kind of thing, smaller, from what this item already published.
 *
 * Ordered by height descending so the step down is one step, not a fall to the bottom.
 * Plans with no height sort last: an audio rendition or a still has no ladder to walk,
 * and putting them behind the sized ones keeps "the next best video" meaning that.
 */
function lowerQualityAlternatives(
  item: ResolvedItem,
  chosen: DownloadPlan,
): readonly DownloadPlan[] {
  const ceiling = chosen.height ?? Number.POSITIVE_INFINITY;
  return item.plans
    .filter(
      (plan) =>
        plan !== chosen &&
        plan.kind === chosen.kind &&
        planKey(plan) !== planKey(chosen) &&
        (plan.height ?? 0) < ceiling,
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

/** The first bytes of a file, or nothing when it cannot be read. */
async function headOf(path: string): Promise<Buffer> {
  try {
    const handle = await open(path, 'r');
    try {
      const head = Buffer.alloc(SNIFF_BYTES);
      await handle.read(head, 0, SNIFF_BYTES, 0);
      return head;
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.alloc(0);
  }
}

async function renameToActualFormat(path: string, claimed: string): Promise<string> {
  const head = await headOf(path);
  if (!head.length) return path;

  const actual = sniffContainer(head);
  if (!actual || !contradicts(claimed, actual)) return path;

  const corrected = path.replace(/.[^.]+$/, `.${actual}`);
  await rename(path, corrected);
  return corrected;
}
