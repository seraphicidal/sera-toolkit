import { seraError, type SeraError } from '../errors.js';
import { run } from '../util/spawn.js';
import type { YtdlpInfo } from './ytdlp-types.js';

/**
 * Adapter over the yt-dlp binary.
 *
 * Two things are deliberate here. Every invocation passes `--ignore-config`, so a config
 * file left on the host cannot inject options — `--exec` in particular would otherwise
 * be a remote code execution path. And the URL is always the last argument, after a
 * bare `--`, so a link beginning with a dash is a positional argument rather than a flag.
 */

export interface YtdlpOptions {
  readonly binary: string;
  readonly ffmpegPath?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Passed through as `--extractor-args`; providers use it for site-specific tuning. */
  readonly extractorArgs?: readonly string[];
}

export interface DownloadRequest extends YtdlpOptions {
  readonly url: string;
  /** A yt-dlp format selector, e.g. `137+140` or `bestaudio`. */
  readonly format: string;
  /** Absolute directory the download is confined to. */
  readonly workdir: string;
  /** Output template, relative to `workdir`. */
  readonly outputTemplate: string;
  /** Aborts the download once the file exceeds this size. */
  readonly maxFilesizeBytes?: number;
  /** Container to remux into after download, when the selection needs merging. */
  readonly mergeContainer?: string;
  /** `--remux-video` target, for a container change with no re-encode. */
  readonly remuxContainer?: string;
  /** Delegates audio extraction to yt-dlp's own postprocessor. */
  readonly audioFormat?: string;
  /** `--audio-quality`: a bitrate such as `320K`, or `0` for best. */
  readonly audioQuality?: string;
  /**
   * Selects one entry of a multi-item post, 1-based.
   *
   * This is how a single slide of a carousel is fetched without downloading the rest:
   * the resolution already knows the entry's position, so the download asks for exactly
   * that one.
   */
  readonly playlistItem?: number;
  /** Total bytes the caller expects, used to turn per-stream counters into one number. */
  readonly expectedTotalBytes?: number;
  readonly onProgress?: (progress: YtdlpProgress) => void;
}

export interface YtdlpProgress {
  /** 0-100 across every stream in the download. */
  readonly percent: number;
  readonly bytesDownloaded: number;
  readonly bytesTotal?: number;
  readonly speedBytesPerSecond?: number;
  readonly etaSeconds?: number;
  /** Set while a postprocessor is running, e.g. `Merger`, `ExtractAudio`. */
  readonly postprocessor?: string;
}

/** Field separator for the machine-readable progress template. Chosen to never appear in values. */
const SEP = '\u0001';
const PROGRESS_PREFIX = 'SERA-PROGRESS';
const POSTPROCESS_PREFIX = 'SERA-POSTPROCESS';

const DOWNLOAD_TEMPLATE = [
  `download:${PROGRESS_PREFIX}`,
  '%(progress.status)s',
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
  '%(info.format_id)s',
].join(SEP);

const POSTPROCESS_TEMPLATE = [
  `postprocess:${POSTPROCESS_PREFIX}`,
  '%(progress.status)s',
  '%(progress.postprocessor)s',
].join(SEP);

/** Options every invocation gets: no config files, no cookies, bounded retries. */
function baseArgs(options: YtdlpOptions): string[] {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-colors',
    '--no-playlist',
    '--no-mtime',
    '--socket-timeout',
    '15',
    '--retries',
    '3',
    '--fragment-retries',
    '5',
    '--extractor-retries',
    '2',
  ];
  if (options.ffmpegPath) args.push('--ffmpeg-location', options.ffmpegPath);
  for (const extractorArg of options.extractorArgs ?? []) {
    args.push('--extractor-args', extractorArg);
  }
  return args;
}

/** Reads metadata without downloading anything. */
export async function dumpInfo(
  url: string,
  options: YtdlpOptions & { readonly playlist?: boolean; readonly flatPlaylist?: boolean },
): Promise<YtdlpInfo> {
  const args = baseArgs(options);
  if (options.playlist) {
    const index = args.indexOf('--no-playlist');
    if (index >= 0) args.splice(index, 1);
    args.push('--yes-playlist');
    // Playlists are capped so one paste cannot enumerate an entire channel.
    args.push('--playlist-end', '100');
  }
  if (options.flatPlaylist) args.push('--flat-playlist');

  args.push('--dump-single-json', '--', url);

  const result = await run(options.binary, {
    args,
    timeoutMs: options.timeoutMs,
    captureStdout: true,
    maxStdoutBytes: 48 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (result.code !== 0) throw classifyYtdlpFailure(result.stderrTail, result.code);

  try {
    return JSON.parse(result.stdout) as YtdlpInfo;
  } catch (cause) {
    throw seraError('PROVIDER_UNAVAILABLE', {
      detail: 'yt-dlp produced unparseable JSON',
      cause,
    });
  }
}

/** Downloads a selection into `workdir`, reporting progress as it goes. */
export async function download(request: DownloadRequest): Promise<void> {
  const args = baseArgs(request);

  if (request.playlistItem !== undefined) {
    const index = args.indexOf('--no-playlist');
    if (index >= 0) args.splice(index, 1);
    args.push('--yes-playlist', '--playlist-items', String(request.playlistItem));
  }

  args.push(
    '--newline',
    '--progress',
    '--progress-template',
    DOWNLOAD_TEMPLATE,
    '--progress-template',
    POSTPROCESS_TEMPLATE,
    '--paths',
    `temp:${request.workdir}`,
    '--paths',
    `home:${request.workdir}`,
    '--output',
    request.outputTemplate,
    '--format',
    request.format,
    '--no-overwrites',
    '--no-post-overwrites',
  );
  if (request.mergeContainer) args.push('--merge-output-format', request.mergeContainer);
  if (request.remuxContainer) args.push('--remux-video', request.remuxContainer);
  if (request.audioFormat) {
    args.push('--extract-audio', '--audio-format', request.audioFormat);
    args.push('--audio-quality', request.audioQuality ?? '0');
  }
  if (request.maxFilesizeBytes) args.push('--max-filesize', String(request.maxFilesizeBytes));

  args.push('--', request.url);

  // Byte counters restart for every stream in a selection, so the totals are tracked per
  // format id and summed. Without this a video+audio download reports 0-100% twice.
  const bytesByFormat = new Map<string, number>();
  let lastPercent = 0;

  const emit = (line: string): void => {
    if (line.startsWith(POSTPROCESS_PREFIX)) {
      const [, status, name] = line.split(SEP);
      if (status === 'started' && name && name !== 'NA') {
        request.onProgress?.({
          percent: lastPercent,
          bytesDownloaded: sum(bytesByFormat),
          postprocessor: name,
        });
      }
      return;
    }
    if (!line.startsWith(PROGRESS_PREFIX)) return;

    const [, status, downloaded, total, totalEstimate, speed, eta, formatId] = line.split(SEP);
    const done = parseNumeric(downloaded);
    if (done === undefined) return;

    bytesByFormat.set(formatId && formatId !== 'NA' ? formatId : 'default', done);
    const bytesDownloaded = sum(bytesByFormat);

    const totalForStream = parseNumeric(total) ?? parseNumeric(totalEstimate);
    const bytesTotal =
      request.expectedTotalBytes ??
      (bytesByFormat.size === 1 && totalForStream !== undefined ? totalForStream : undefined);

    if (bytesTotal && bytesTotal > 0) {
      // Never regress: a later stream reporting a smaller estimate must not move the bar back.
      lastPercent = Math.max(lastPercent, Math.min(99.5, (bytesDownloaded / bytesTotal) * 100));
    } else if (status === 'finished') {
      lastPercent = Math.max(lastPercent, 99);
    }

    const progress: {
      percent: number;
      bytesDownloaded: number;
      bytesTotal?: number;
      speedBytesPerSecond?: number;
      etaSeconds?: number;
    } = { percent: lastPercent, bytesDownloaded };
    if (bytesTotal !== undefined) progress.bytesTotal = bytesTotal;
    const speedValue = parseNumeric(speed);
    if (speedValue !== undefined) progress.speedBytesPerSecond = speedValue;
    const etaValue = parseNumeric(eta);
    if (etaValue !== undefined) progress.etaSeconds = etaValue;
    request.onProgress?.(progress);
  };

  const result = await run(request.binary, {
    args,
    cwd: request.workdir,
    timeoutMs: request.timeoutMs,
    onStdoutLine: emit,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (result.code !== 0) throw classifyYtdlpFailure(result.stderrTail, result.code);
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

/** Progress fields render as the literal string `NA` when yt-dlp has no value. */
function parseNumeric(value: string | undefined): number | undefined {
  if (!value || value === 'NA') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reports the installed yt-dlp version, or throws if the binary is unusable. */
export async function version(binary: string, timeoutMs = 10_000): Promise<string> {
  const result = await run(binary, { args: ['--version'], timeoutMs, captureStdout: true });
  if (result.code !== 0) {
    throw seraError('INTERNAL', { detail: `yt-dlp --version exited ${result.code}` });
  }
  return result.stdout.trim();
}

/**
 * Maps yt-dlp's stderr onto something a user can act on.
 *
 * Matching on message text is inherently brittle, which is why the fallback is
 * `PROVIDER_UNAVAILABLE` rather than a generic crash: when an extractor changes and the
 * wording moves, the user is told this source needs updating instead of seeing a 500.
 */
export function classifyYtdlpFailure(stderr: string, exitCode: number): SeraError {
  const text = stderr.toLowerCase();
  const detail = `yt-dlp exit ${exitCode}: ${stderr.slice(-600)}`;

  const has = (...needles: string[]): boolean => needles.some((n) => text.includes(n));

  if (has('is private', 'private video', 'private account', 'this post is private')) {
    return seraError('PRIVATE_CONTENT', { detail });
  }
  if (
    has(
      'sign in to confirm your age',
      'age-restricted',
      'age restricted',
      'inappropriate for some users',
    )
  ) {
    return seraError('AGE_RESTRICTED', { detail });
  }
  if (has('drm', 'protected by widevine', 'encrypted')) {
    return seraError('DRM_PROTECTED', { detail });
  }
  // Checked before the sign-in branch below, whose phrases this text also contains.
  // "Sign in to confirm you're not a bot" is not a statement about the media: the link is
  // public and resolves fine from a residential connection. It is the platform refusing
  // the address the request came from, and telling the visitor their video needs an
  // account sends them looking for the wrong thing.
  if (
    has(
      "you're not a bot",
      'you’re not a bot',
      'not a bot',
      'confirm you are not a bot',
      'unusual traffic',
      'suspicious activity',
    )
  ) {
    return seraError('SOURCE_BLOCKED', { detail });
  }
  if (
    has(
      'sign in to confirm',
      'login required',
      'requires authentication',
      'use --cookies',
      'account is required',
      "you're not signed in",
    )
  ) {
    return seraError('LOGIN_REQUIRED', { detail });
  }
  if (
    has(
      'not available in your country',
      // YouTube's own phrasing, which does not contain "not available in your country".
      'available in your country',
      'not available from your location',
      'geo restricted',
      'geo-restricted',
      'geo restriction',
      'blocked in your country',
      'blocked it in your country',
    )
  ) {
    return seraError('GEO_RESTRICTED', { detail });
  }
  if (
    has('live event will begin', 'is not yet available', 'premieres in', 'live stream is offline')
  ) {
    return seraError('LIVE_IN_PROGRESS', { detail });
  }
  if (has('http error 429', 'too many requests', 'rate-limit', 'rate limit')) {
    return seraError('RATE_LIMITED', { detail });
  }
  // The extractor ran, understood the page, and found nothing it handles — which on
  // most social platforms means the post is photos rather than video. That is a gap in
  // *this* extractor, not a missing post, so it is reported as an unsupported source and
  // the resolver retries through the page reader, which does read images.
  if (
    has(
      'no video could be found',
      'no video formats found',
      'there is no video in this post',
      'no media found',
      'unable to find any media',
    )
  ) {
    return seraError('UNSUPPORTED_SOURCE', {
      detail: detail ? `no extractable video: ${detail}` : 'no extractable video',
    });
  }
  if (
    has(
      'unsupported url',
      'no suitable inforextractor',
      'no suitable extractor',
      'is not a valid url',
    )
  ) {
    return seraError('UNSUPPORTED_SOURCE', { detail });
  }
  if (
    has(
      'video unavailable',
      'this video is not available',
      'has been removed',
      'no longer available',
      'http error 404',
      'not found',
      'page does not exist',
      'account has been suspended',
    )
  ) {
    return seraError('MEDIA_UNAVAILABLE', { detail });
  }
  if (has('requested format is not available', 'no video formats found', 'no formats found')) {
    return seraError('MEDIA_UNAVAILABLE', {
      message: 'The requested quality is no longer available.',
      hint: 'Analyze the link again to refresh the format list.',
      detail,
    });
  }
  if (has('file is larger than max-filesize', 'exceeds --max-filesize')) {
    return seraError('TOO_LARGE', { detail });
  }
  if (
    has(
      'unable to download webpage',
      'connection reset',
      'connection refused',
      'temporary failure in name resolution',
      'timed out',
      'unable to connect',
      'ssl',
    )
  ) {
    return seraError('NETWORK_ERROR', { detail });
  }
  if (has('unable to extract', 'failed to parse', 'unable to recognize', 'extractor')) {
    return seraError('PROVIDER_UNAVAILABLE', {
      hint: 'This usually clears once the extractor is updated.',
      detail,
    });
  }
  return seraError('PROVIDER_UNAVAILABLE', { detail });
}
