export const SERA_VERSION = '1.0.0';

export type MediaKind = 'video' | 'audio' | 'image' | 'gif' | 'unknown';

export type MediaInfoType = 'single' | 'collection' | 'playlist';

export type ContainerFormat =
  | 'mp4'
  | 'webm'
  | 'mov'
  | 'mkv'
  | 'mp3'
  | 'm4a'
  | 'aac'
  | 'opus'
  | 'ogg'
  | 'wav'
  | 'flac'
  | 'gif'
  | 'jpg'
  | 'png'
  | 'webp'
  | 'avif'
  | 'zip'
  | 'bin';

export interface DownloadOption {
  readonly id: string;
  readonly itemId: string;
  readonly kind: Exclude<MediaKind, 'unknown'>;
  readonly container: ContainerFormat;
  readonly label: string;
  readonly detail?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly audioBitrateKbps?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly filesizeBytes?: number;
  readonly filesizeIsApproximate?: boolean;
  readonly requiresConversion: boolean;
  readonly recommended: boolean;
}

export interface MediaItem {
  readonly id: string;
  readonly index: number;
  readonly kind: MediaKind;
  readonly title?: string;
  readonly thumbnail?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly container?: ContainerFormat;
  readonly filesizeBytes?: number;
  readonly isLive?: boolean;
  readonly subtitles?: readonly SubtitleTrack[];
  readonly options: readonly DownloadOption[];
}

export interface MediaInfo {
  readonly id: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly url: string;
  readonly type: MediaInfoType;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  readonly thumbnail?: string;
  readonly duration?: number;
  readonly createdAt?: string;
  readonly items: readonly MediaItem[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly expiresIn: number;
}

export type JobState =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'merging'
  | 'converting'
  | 'packaging'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const TERMINAL_JOB_STATES = ['ready', 'failed', 'cancelled', 'expired'] as const;

export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];

export function isTerminalJobState(state: JobState): state is TerminalJobState {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export interface JobProgress {
  readonly percent: number;
  readonly bytesDownloaded?: number;
  readonly bytesTotal?: number;
  readonly speedBytesPerSecond?: number;
  readonly etaSeconds?: number;
  readonly currentFile?: number;
  readonly totalFiles?: number;
}

export interface JobResultFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly downloadPath: string;
}

export interface JobDelivery {
  readonly backend: string;
  readonly substituted?: readonly { readonly requested: string; readonly actual: string }[];
}

export interface JobResult {
  readonly downloadPath: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly isArchive: boolean;
  readonly files?: readonly JobResultFile[];
  readonly expiresAt: string;
  readonly delivery?: JobDelivery;
}

export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SOURCE'
  | 'PRIVATE_CONTENT'
  | 'MEDIA_UNAVAILABLE'
  | 'GEO_RESTRICTED'
  | 'AGE_RESTRICTED'
  | 'LOGIN_REQUIRED'
  | 'SOURCE_BLOCKED'
  | 'PROVIDER_AUTH_REQUIRED'
  | 'PROVIDER_CONFIGURATION_ERROR'
  | 'ROBOTS_DISALLOWED'
  | 'DRM_PROTECTED'
  | 'LIVE_IN_PROGRESS'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TOO_LARGE'
  | 'TOO_LONG'
  | 'CONVERSION_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'BLOCKED_ADDRESS'
  | 'QUEUE_FULL'
  | 'INTERNAL';

export interface JobError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

export interface Job {
  readonly id: string;
  readonly state: JobState;
  readonly step: string;
  readonly progress: JobProgress;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: JobResult;
  readonly error?: JobError;
}

export interface ResolveRequest {
  readonly url: string;
}

export interface ImportedCandidate {
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ImportedPostNode {
  readonly id?: string;
  readonly code?: string;
  readonly media_type?: number;
  readonly carousel_media?: readonly ImportedPostNode[];
  readonly image_versions2?: { readonly candidates?: readonly ImportedCandidate[] };
  readonly video_versions?: readonly ImportedCandidate[];
  readonly video_duration?: number;
  readonly accessibility_caption?: string;
  readonly user?: { readonly username?: string; readonly full_name?: string };
  readonly caption?: { readonly text?: string };
}

export interface ImportRequest {
  readonly url: string;
  readonly node: ImportedPostNode;
}

export type PackagingMode = 'auto' | 'zip' | 'individual';

export interface CreateJobRequest {
  readonly infoId: string;
  readonly optionIds: readonly string[];
  readonly packaging?: PackagingMode;
  readonly filename?: string;
  readonly trim?: TrimRequest;
  readonly subtitles?: SubtitleRequest;
}

export interface SubtitleTrack {
  readonly lang: string;
  readonly label: string;
  readonly auto: boolean;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'embed';

export interface SubtitleRequest {
  readonly lang: string;
  readonly auto?: boolean;
  readonly format: SubtitleFormat;
  readonly only?: boolean;
}

export const SUBTITLE_EMBED_CONTAINERS: readonly ContainerFormat[] = ['mp4', 'mkv', 'webm'];

export interface TrimRequest {
  readonly start?: string;
  readonly end?: string;
}

export interface TrimRange {
  readonly start: number;
  readonly end?: number;
}

export const TIMECODE_PATTERN = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

export function parseTimecode(text: string): number | undefined {
  const match = TIMECODE_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function formatTimecode(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

export const MIN_TRIM_SECONDS = 1;

export function checkTrim(
  trim: TrimRequest,
  durationSeconds?: number,
):
  | { readonly ok: true; readonly range: TrimRange }
  | { readonly ok: false; readonly message: string } {
  const start = trim.start?.trim() ? parseTimecode(trim.start) : 0;
  const end = trim.end?.trim() ? parseTimecode(trim.end) : undefined;
  if (start === undefined || (trim.end?.trim() && end === undefined)) {
    return { ok: false, message: 'Use m:ss or h:mm:ss for the trim times.' };
  }
  if (!trim.start?.trim() && !trim.end?.trim()) {
    return { ok: false, message: 'Give a start or an end time to trim.' };
  }
  const known = durationSeconds !== undefined && durationSeconds > 0;
  if (known && start >= durationSeconds) {
    return {
      ok: false,
      message: `The start is past the end of the media (${formatTimecode(durationSeconds)}).`,
    };
  }
  if (known && end !== undefined && end > Math.ceil(durationSeconds) + 1) {
    return {
      ok: false,
      message: `The end is past the end of the media (${formatTimecode(durationSeconds)}).`,
    };
  }
  const effectiveEnd = end ?? (known ? durationSeconds : undefined);
  if (effectiveEnd !== undefined && effectiveEnd - start < MIN_TRIM_SECONDS) {
    return { ok: false, message: 'The start has to come before the end.' };
  }
  if (start === 0 && (end === undefined || (known && end >= durationSeconds))) {
    return { ok: false, message: 'That keeps the whole thing; there is nothing to trim.' };
  }
  const clippedEnd = known && end !== undefined ? Math.min(end, durationSeconds) : end;
  return {
    ok: true,
    range: {
      start,
      ...(clippedEnd !== undefined && !(known && clippedEnd >= durationSeconds)
        ? { end: clippedEnd }
        : {}),
    },
  };
}

export function trimSuffix(range: TrimRange, durationSeconds?: number): string {
  const part = (seconds: number) => {
    const whole = Math.round(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return h
      ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
      : `${m}m${String(s).padStart(2, '0')}s`;
  };
  const end = range.end ?? durationSeconds;
  return `-trim-${part(range.start)}${end !== undefined ? `-${part(end)}` : '-end'}`;
}

export type JobEvent =
  | { readonly type: 'state'; readonly job: Job }
  | { readonly type: 'progress'; readonly job: Job }
  | { readonly type: 'done'; readonly job: Job }
  | { readonly type: 'error'; readonly job: Job }
  | { readonly type: 'ping' };

export interface ProviderCapabilities {
  readonly video: boolean;
  readonly image: boolean;
  readonly audio: boolean;
  readonly audioExtraction: boolean;
  readonly carousel: boolean;
  readonly gallery: boolean;
  readonly gif: boolean;
  readonly live: boolean;

  readonly authenticatedMode: boolean;
  readonly requiresOauth: boolean;

  readonly residentialFallback: boolean;
  readonly cloudExtraction: boolean;

  readonly browserImport: boolean;

  readonly authRequiredFor?: readonly string[];
}

export interface ProviderSummary {
  readonly id: string;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly capabilities: ProviderCapabilities;
}

export interface ServiceInfo {
  readonly name: string;
  readonly version: string;
  readonly providers: readonly ProviderSummary[];
  readonly limits: {
    readonly maxFilesizeBytes: number;
    readonly maxDurationSeconds: number;
    readonly maxItemsPerJob: number;
    readonly retentionSeconds: number;
  };
}

export interface HealthCheck {
  readonly name: string;
  readonly status: 'ok' | 'error';
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checks: readonly HealthCheck[];
}

export interface ApiErrorBody {
  readonly error: JobError;
}
