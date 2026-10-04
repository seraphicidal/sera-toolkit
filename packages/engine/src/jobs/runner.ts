import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type {
  JobProgress,
  JobResult,
  JobState,
  PackagingMode,
  TrimRange,
} from '@sera/contracts/types';
import { trimSuffix } from '@sera/contracts/types';
import type { EngineConfig } from '../config.js';
import { convert, probe, type ConversionSpec } from '../convert/ffmpeg.js';
import { squareCover, tagAudio, TAGGABLE_AUDIO } from '../convert/tags.js';
import { trimMedia } from '../convert/trim.js';
import { seraError, SeraError } from '../errors.js';
import { downloadDirect } from '../extract/direct-download.js';
import { download as ytdlpDownload, downloadSubtitles } from '../extract/ytdlp.js';
import { classifyFailure } from '../extract/failure.js';
import { logSafeUrl, type Logger } from '../logging.js';
import {
  importExpired,
  importRefused,
  isAllowedMediaUrl,
  mediaFromImport,
  type ImportedEntry,
} from '../providers/instagram-media.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from '../providers/types.js';
import { planKey } from '../providers/types.js';
import { contradicts, sniffContainer, sniffTextImposter, SNIFF_BYTES } from '../util/sniff.js';
import type { MediaResolver } from '../resolver.js';
import type { RemoteExtraction } from '../extract/remote.js';
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
  /** Keep only this part of the one item, in seconds. Single-item video and audio only. */
  readonly trim?: TrimRange;
  /** A subtitle track to embed or deliver as a file. Single item only. */
  readonly subtitles?: JobSubtitles;
  /**
   * Present when the job came from a post the visitor's own browser read.
   *
   * A job like that fetches these and never re-resolves: nothing on this side can read the
   * post again, which is the point — there is no session here to read it with.
   */
  readonly imported?: ImportedJob;
}

/** `SubtitleRequest`, with its defaults filled in. */
export interface JobSubtitles {
  readonly lang: string;
  readonly auto: boolean;
  readonly format: 'srt' | 'vtt' | 'embed';
  readonly only: boolean;
}

/** A post the visitor's browser read, as the server approved and signed it. */
export interface ImportedJob {
  /** The media to fetch, exactly as signed. */
  readonly entries: readonly ImportedEntry[];
  /** For naming the files. */
  readonly title: string;
  readonly author?: string;
  /** When Instagram stops honouring the earliest of those URLs, epoch seconds. */
  readonly expiresAt?: number;
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
  readonly remote?: RemoteExtraction;
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
    // links, and forged ones, out of the pipeline. An imported post is the exception, and not
    // a hole in that rule: it cannot be re-read, so its media was checked against Instagram's
    // hosts when it arrived and signed into the token this spec came from. The client has had
    // no chance to change a byte of it since.
    const resolved = spec.imported
      ? mediaFromImport({
          url: spec.url,
          title: spec.imported.title,
          ...(spec.imported.author ? { author: spec.imported.author } : {}),
          entries: spec.imported.entries,
        })
      : await resolver.resolveCanonical(new URL(spec.url), spec.provider, signal);
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
          // The node cuts the file itself: shipping the whole thing to cut it here would
          // spend its upload on what is thrown away.
          ...(spec.trim ? { trim: spec.trim } : {}),
          // So are subtitles: the track is fetched on the same network as the media.
          ...(spec.subtitles ? { subtitles: spec.subtitles } : {}),
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
        if (spec.imported) assertImportFresh(spec.imported);

        const fileProgress = (fraction: number, extra: Partial<JobProgress> = {}): JobProgress => ({
          percent: Math.min(99, ((index + Math.min(fraction, 1)) / totalFiles) * 100),
          ...(totalFiles > 1 ? { currentFile: index + 1, totalFiles } : {}),
          ...extra,
        });

        if (spec.subtitles) assertSubtitlesOffered(item, spec.subtitles);

        // The subtitle file alone: no media is fetched at all.
        if (spec.subtitles?.only) {
          report({
            state: 'downloading',
            step: 'Downloading subtitles',
            progress: fileProgress(0),
          });
          const path = await this.fetchSubtitles({
            resolved,
            item,
            workspace,
            index,
            subtitles: spec.subtitles,
            signal,
          });
          const name = dedupeFilename(
            subtitleName(
              this.nameFor(spec, resolved, item, plan, path, totalFiles),
              spec.subtitles.lang,
            ),
            taken,
          );
          const destination = workspace.outputPath(name);
          await rename(path, destination);
          produced.push({ path: destination, name });
          continue;
        }

        const { path: downloaded, plan: used } = await this.fetchWithFallback({
          workspace,
          resolved,
          item,
          plan,
          index,
          report,
          fileProgress,
          ...(spec.imported ? { imported: true } : {}),
          ...(spec.trim ? { trim: spec.trim } : {}),
          ...(spec.subtitles?.format === 'embed' ? { embedSubtitles: spec.subtitles } : {}),
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
        const finished =
          used.kind === 'audio'
            ? await this.tagOne({
                input: converted,
                resolved,
                item,
                workspace,
                index,
                ...(spec.imported ? { imported: true } : {}),
                ...(signal ? { signal } : {}),
              })
            : converted;

        const name = dedupeFilename(
          this.nameFor(spec, resolved, item, used, finished, totalFiles),
          taken,
        );
        const destination = workspace.outputPath(name);
        await rename(finished, destination);
        produced.push({ path: destination, name });

        // A subtitle file beside the media, named after it: "Title.en.srt" next to "Title.mp4".
        if (spec.subtitles && spec.subtitles.format !== 'embed') {
          report({
            state: 'downloading',
            step: 'Downloading subtitles',
            progress: fileProgress(0.99),
          });
          const path = await this.fetchSubtitles({
            resolved,
            item,
            workspace,
            index,
            subtitles: spec.subtitles,
            signal,
          });
          const subtitle = dedupeFilename(
            subtitleName(
              name.replace(/\.[^.]+$/, `.${spec.subtitles.format}`),
              spec.subtitles.lang,
            ),
            taken,
          );
          const subtitleDestination = workspace.outputPath(subtitle);
          await rename(path, subtitleDestination);
          produced.push({ path: subtitleDestination, name: subtitle });
        }
      }
    }

    const packaged = await this.package(spec, resolved, workspace, produced, report, signal);
    // Said out loud rather than left for someone to notice in the pixels: which backend
    // produced this, and anything that had to be met with a different rendition. An imported
    // post names the visitor's browser, because that is where the post was read.
    const backend = spec.imported ? 'visitor-browser' : (remoteBackend ?? 'local');
    const result: JobResult = {
      ...packaged,
      delivery: {
        backend,
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
        strategy: backend,
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
    /** The item came from a post the visitor's browser read. */
    imported?: boolean;
    trim?: TrimRange;
    embedSubtitles?: JobSubtitles;
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
    imported?: boolean;
    trim?: TrimRange;
    embedSubtitles?: JobSubtitles;
    signal?: AbortSignal;
  }): Promise<string> {
    const { config } = this.deps;
    const { workspace, plan, item, index, report, fileProgress, signal } = args;

    const scratch = join(workspace.scratchDir, `sel-${index}`);
    await mkdir(scratch, { recursive: true });

    const step = args.resolved.items.length > 1 ? `Downloading ${index + 1}` : 'Downloading';
    report({ state: 'downloading', step, progress: fileProgress(0) });

    if (plan.fetch.via === 'direct') {
      if (args.embedSubtitles) {
        throw seraError('MEDIA_UNAVAILABLE', {
          message: 'Subtitles cannot be embedded in this file.',
          detail: 'embed requested on a direct download',
        });
      }
      const destination = join(scratch, `media.${plan.container}`);
      const importHosts = args.imported ? this.deps.resolver.importHosts : undefined;
      await downloadDirect({
        url: plan.fetch.url,
        destination,
        dispatcher: this.deps.resolver.dispatcher,
        maxBytes: config.maxFilesizeBytes,
        timeoutMs: config.jobTimeoutSeconds * 1000,
        // Every hop, not only the first. A redirect is a new destination, and following one
        // off Instagram's hosts would undo the check the import passed on arrival.
        ...(importHosts ? { allowUrl: (url: URL) => isAllowedMediaUrl(url, importHosts) } : {}),
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
      }).catch((error: unknown) => {
        // Instagram's CDN answers a link whose signature has run out with a 403, which would
        // otherwise reach the visitor as "we couldn't retrieve this media".
        throw importHosts && isForbidden(error)
          ? importRefused('import: the cdn answered 403')
          : error;
      });
      // The provider named this format before it had the file, from a URL or a header,
      // and either can be wrong — Bluesky's CDN serves WebP from URLs ending in `@jpeg`.
      // Renaming here is enough to correct everything downstream, because the produced
      // file's own extension is what names the download.
      const fetched = await renameToActualFormat(destination, plan.container);
      if (!args.trim) return fetched;

      // A direct file is cut after it arrives; yt-dlp, below, only fetches the part asked for.
      report({ state: 'converting', step: 'Trimming', progress: fileProgress(DOWNLOAD_SHARE) });
      const trimmed = join(scratch, `trimmed${extname(fetched)}`);
      await trimMedia({
        input: fetched,
        output: trimmed,
        range: args.trim,
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        timeoutMs: config.jobTimeoutSeconds * 1000,
        ...(signal ? { signal } : {}),
      });
      await rm(fetched, { force: true });
      return trimmed;
    }

    const fetchPlan = plan.fetch;
    let sawPostprocessor: string | undefined;

    const download = (
      sections?: { start: number; end?: number; forceKeyframes: boolean },
      downloadSignal = signal,
    ) =>
      ytdlpDownload({
        binary: config.ytdlpPath,
        ffmpegPath: config.ffmpegPath,
        timeoutMs: config.jobTimeoutSeconds * 1000,
        url: args.resolved.url,
        format: fetchPlan.selector,
        workdir: scratch,
        // yt-dlp appends the real extension; a fixed stem makes the output easy to find.
        outputTemplate: 'media.%(ext)s',
        maxFilesizeBytes: config.maxFilesizeBytes,
        // The resolve and the download are separate invocations. A proxy that applied to
        // only one of them would produce a format list from one address and ask another to
        // fetch it, which for a signed URL is the 403 this exists to avoid.
        ...(config.proxyFor(args.resolved.provider)
          ? { proxy: config.proxyFor(args.resolved.provider) }
          : {}),
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
        ...(args.embedSubtitles
          ? { subtitles: { lang: args.embedSubtitles.lang, auto: args.embedSubtitles.auto } }
          : {}),
        ...(sections ? { sections } : {}),
        ...(downloadSignal ? { signal: downloadSignal } : {}),
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

    if (!args.trim) {
      await download();
      return findSingleFile(scratch);
    }

    // Only the part asked for, where yt-dlp and FFmpeg manage it. A copy can only begin
    // where the stream lets it: a video's keyframe, possibly seconds early, and — measured on
    // YouTube's audio-only streams, where a copy from 0:03 came back starting at 0:00 — an
    // audio stream's fragment. A cut from the very start is accurate as a copy; any other is
    // re-encoded around the cut.
    const range = args.trim;
    // yt-dlp hands a section to FFmpeg as one long request, and YouTube throttles that to a
    // trickle: measured, a 1080p section wrote nothing in 75 s where the full download ran
    // at 4 MB/s. A section that stops growing is abandoned for the full file.
    const stalled = new AbortController();
    const stopWatching = watchGrowth(scratch, SECTION_STALL_MS, () => stalled.abort());
    try {
      await download(
        {
          start: range.start,
          ...(range.end !== undefined ? { end: range.end } : {}),
          forceKeyframes: range.start > 0,
        },
        signal ? AbortSignal.any([signal, stalled.signal]) : stalled.signal,
      );
      stopWatching();
      const cut = await findSingleFile(scratch);
      const probed = await probe(cut, {
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      }).catch(() => undefined);
      if (sectionIsUsable(probed, range, item.duration)) return cut;
      this.deps.logger.warn(
        { jobId: workspace.jobId, provider: args.resolved.provider, got: probed?.durationSeconds },
        'section download came back wrong; cutting the full file instead',
      );
    } catch (error) {
      stopWatching();
      if (signal?.aborted) throw error;
      this.deps.logger.warn(
        {
          jobId: workspace.jobId,
          provider: args.resolved.provider,
          ...(stalled.signal.aborted ? { stalledMs: SECTION_STALL_MS } : { err: error }),
        },
        stalled.signal.aborted
          ? 'section download stalled; cutting the full file instead'
          : 'section download failed; cutting the full file instead',
      );
    }

    // The section did not come back usable — measured on Debian's FFmpeg 5.1 with Vimeo's
    // DASH streams, it is unreadable with forced keyframes and a second long without. The
    // whole file, cut here, is what a direct link gets: slower, and right.
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    sawPostprocessor = undefined;
    await download();
    const full = await findSingleFile(scratch);
    report({ state: 'converting', step: 'Trimming', progress: fileProgress(DOWNLOAD_SHARE) });
    const trimmed = join(scratch, `trimmed${extname(full)}`);
    await trimMedia({
      input: full,
      output: trimmed,
      range,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: config.jobTimeoutSeconds * 1000,
      ...(signal ? { signal } : {}),
    });
    await rm(full, { force: true });
    return trimmed;
  }

  /**
   * Titles, artist, album and cover art for an audio file (see convert/tags.ts).
   *
   * Best effort: a thumbnail that will not download or a tag FFmpeg refuses leaves the file
   * as it was, because a working MP3 without its cover is still the thing that was asked
   * for. An imported post gets tags but no cover; its pictures are Instagram's, fetched
   * only under the rules the import was signed with.
   */
  private async tagOne(args: {
    input: string;
    resolved: ResolvedMedia;
    item: ResolvedItem;
    workspace: Workspace;
    index: number;
    imported?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const { config, logger } = this.deps;
    const extension = extname(args.input).slice(1).toLowerCase();
    if (!TAGGABLE_AUDIO.has(extension)) return args.input;

    const dir = join(args.workspace.scratchDir, `sel-${args.index}`);
    const tools = {
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: config.jobTimeoutSeconds * 1000,
      ...(args.signal ? { signal: args.signal } : {}),
    };
    const { item, resolved } = args;
    const artist = item.tags?.artist ?? resolved.author;
    const title = item.tags?.track ?? item.title ?? resolved.title;

    // The picked thumbnail first, then the one yt-dlp verified, then the post's own: the
    // first that downloads and crops becomes the cover.
    const candidates = args.imported
      ? []
      : [...new Set([item.thumbnailUrl, item.thumbnailFallbackUrl, resolved.thumbnailUrl])].filter(
          (url): url is string => Boolean(url),
        );
    let coverPath: string | undefined;
    for (const [attempt, thumbnail] of candidates.entries()) {
      try {
        const source = join(dir, `thumbnail-${attempt}.img`);
        await downloadDirect({
          url: thumbnail,
          destination: source,
          dispatcher: this.deps.resolver.dispatcher,
          maxBytes: 10 * 1024 * 1024,
          timeoutMs: 30_000,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        coverPath = join(dir, 'cover.jpg');
        await squareCover(source, coverPath, tools);
        break;
      } catch (error) {
        coverPath = undefined;
        logger.info(
          { jobId: args.workspace.jobId, attempt, err: SeraError.from(error).detail },
          'a thumbnail could not be used as cover art',
        );
      }
    }

    const output = join(dir, `tagged.${extension}`);
    try {
      await tagAudio({
        ...tools,
        input: args.input,
        output,
        scratchDir: dir,
        tags: {
          ...(title ? { title } : {}),
          ...(artist ? { artist } : {}),
          ...(item.tags?.album ? { album: item.tags.album } : {}),
        },
        ...(coverPath ? { coverPath } : {}),
      });
      return output;
    } catch (error) {
      logger.warn(
        { jobId: args.workspace.jobId, err: SeraError.from(error).detail },
        'audio left untagged: tagging failed',
      );
      return args.input;
    }
  }

  /** One subtitle track as a file, fetched with yt-dlp from the item's own page. */
  private async fetchSubtitles(args: {
    resolved: ResolvedMedia;
    item: ResolvedItem;
    workspace: Workspace;
    index: number;
    subtitles: JobSubtitles;
    signal?: AbortSignal;
  }): Promise<string> {
    const { config } = this.deps;
    const workdir = join(args.workspace.scratchDir, `subs-${args.index}`);
    await mkdir(workdir, { recursive: true });
    const proxy = config.proxyFor(args.resolved.provider);
    return downloadSubtitles({
      binary: config.ytdlpPath,
      ffmpegPath: config.ffmpegPath,
      timeoutMs: Math.min(config.jobTimeoutSeconds * 1000, 120_000),
      url: args.resolved.url,
      workdir,
      lang: args.subtitles.lang,
      auto: args.subtitles.auto,
      format: args.subtitles.format === 'vtt' ? 'vtt' : 'srt',
      ...(args.resolved.items.length > 1 ? { playlistItem: args.item.index + 1 } : {}),
      ...(proxy ? { proxy } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
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
    // A trimmed file says which part it is, so two cuts of one video do not look alike.
    const suffix = spec.trim ? trimSuffix(spec.trim, item.duration) : '';
    if (spec.filename && totalFiles === 1) {
      return `${sanitizeStem(spec.filename)}${suffix}.${extension}`;
    }
    const name = mediaFilename({
      author: resolved.author,
      title: item.title ?? resolved.title,
      container: extension,
      // A collection numbers its parts; a single file does not need a "(1)".
      ...(totalFiles > 1 || resolved.items.length > 1 ? { index: item.index + 1 } : {}),
    });
    if (!suffix) return name;
    const dot = name.lastIndexOf('.');
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
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

/**
 * Refuses to start a fetch Instagram is going to refuse.
 *
 * A job can wait in the queue past the moment the signed URLs in it run out, and asking the
 * CDN anyway turns a clear answer into a 403 that reads like a network fault.
 */
function assertImportFresh(imported: ImportedJob, now = Date.now()): void {
  if (imported.expiresAt !== undefined && imported.expiresAt * 1000 <= now) {
    throw importExpired('import: the media urls expired before the job reached them');
  }
}

function isForbidden(error: unknown): boolean {
  return error instanceof SeraError && error.code === 'NETWORK_ERROR' && error.detail === 'GET 403';
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
/**
 * Whether the item still offers the track asked for. The resolution the job was created
 * from listed it; a re-resolution that no longer does means the site took it down.
 */
function assertSubtitlesOffered(item: ResolvedItem, subtitles: JobSubtitles): void {
  const offered = item.subtitles?.some(
    (track) => track.lang === subtitles.lang && track.auto === subtitles.auto,
  );
  if (!offered) {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'Those subtitles are not available any more.',
      detail: `subtitles ${subtitles.lang}${subtitles.auto ? ' (auto)' : ''} not offered`,
    });
  }
}

/** "Title.srt" → "Title.en.srt": the language before the extension, as players expect. */
function subtitleName(name: string, lang: string): string {
  const dot = name.lastIndexOf('.');
  // `en-orig` is YouTube's key for the original-language automatic track; a player looks
  // for the language itself.
  const safe = lang.replace(/-orig$/, '').replace(/[^A-Za-z0-9_-]/g, '');
  return `${name.slice(0, dot)}.${safe}${name.slice(dot)}`;
}

/** How long a section download may write nothing before the full file is fetched instead. */
export const SECTION_STALL_MS = 20_000;

/**
 * Calls `onStall` once if the files under `directory` stop growing for `stallMs`, checking
 * every second (a quarter of `stallMs` when that is shorter). Returns a function that stops
 * watching.
 */
export function watchGrowth(directory: string, stallMs: number, onStall: () => void): () => void {
  let size = -1;
  let since = Date.now();
  let checking = false;
  const timer = setInterval(
    () => {
      if (checking) return;
      checking = true;
      void directorySize(directory)
        .then((current) => {
          if (current !== size) {
            size = current;
            since = Date.now();
          } else if (Date.now() - since >= stallMs) {
            clearInterval(timer);
            onStall();
          }
        })
        .finally(() => (checking = false));
    },
    Math.min(1000, Math.max(10, stallMs / 4)),
  );
  timer.unref();
  return () => clearInterval(timer);
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    total += await stat(join(directory, entry.name)).then(
      (info) => info.size,
      () => 0,
    );
  }
  return total;
}

/**
 * Whether a section yt-dlp cut is the part asked for: readable, with a track, and within a
 * second (or a tenth, for a long cut) of the length the range implies — when that length is
 * known, from the range's end or the item's duration.
 */
export function sectionIsUsable(
  probed:
    | { readonly durationSeconds?: number; readonly video?: unknown; readonly audio?: unknown }
    | undefined,
  range: TrimRange,
  itemDuration?: number,
): boolean {
  if (!probed || (!probed.video && !probed.audio)) return false;
  const end = range.end ?? itemDuration;
  if (end === undefined) return probed.durationSeconds === undefined || probed.durationSeconds > 0;
  if (probed.durationSeconds === undefined) return false;
  const expected = end - range.start;
  return Math.abs(probed.durationSeconds - expected) <= Math.max(1, expected * 0.1);
}

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
