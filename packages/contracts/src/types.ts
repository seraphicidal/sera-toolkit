/**
 * SERA.toolkit — normalized media contracts.
 *
 * This module is intentionally dependency-free so the browser bundle can import it
 * without pulling a validation library in. The runtime schemas that validate the same
 * shapes live in `./schemas.ts` and are proven to match at compile time.
 */

/**
 * The application version, shown in the UI and reported by `/api/info`.
 *
 * It lives in the contracts package because both the browser bundle and the server
 * display it, and the browser cannot import the engine.
 */
export const SERA_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/*  Media model                                                               */
/* -------------------------------------------------------------------------- */

/** What a piece of media fundamentally is, independent of container or codec. */
export type MediaKind = 'video' | 'audio' | 'image' | 'gif' | 'unknown';

/** The overall shape of a resolved link. */
export type MediaInfoType =
  /** A single piece of media (one video, one track, one photo). */
  | 'single'
  /** Several media items published together (carousel, gallery, multi-image post). */
  | 'collection'
  /** An ordered list of separately publishable entries (playlist, channel page). */
  | 'playlist';

/** Container formats SERA can hand back. */
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

/**
 * A concrete thing the user can ask for.
 *
 * Options are computed by the engine from whatever the provider actually exposes —
 * the UI never reasons about codecs, itags or stream lists. Every option is
 * self-describing and directly submittable as a job.
 */
export interface DownloadOption {
  /** Opaque, provider-independent handle. Submit this to create a job. */
  readonly id: string;
  /** Which item of a collection this option belongs to. */
  readonly itemId: string;
  readonly kind: Exclude<MediaKind, 'unknown'>;
  readonly container: ContainerFormat;
  /** Short primary label, e.g. `1080p`, `320 kbps`, `Original`. */
  readonly label: string;
  /** Secondary descriptor, e.g. `MP4 · H.264 + AAC`. Never duplicates `label`. */
  readonly detail?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  /** Audio bitrate in kbps, when meaningful. */
  readonly audioBitrateKbps?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  /** Exact size in bytes when the provider reports one. */
  readonly filesizeBytes?: number;
  /** Set when `filesizeBytes` is an estimate rather than a reported value. */
  readonly filesizeIsApproximate?: boolean;
  /** True when FFmpeg must re-encode, as opposed to stream-copy or a direct fetch. */
  readonly requiresConversion: boolean;
  /** At most one option per kind is marked as the smart default. */
  readonly recommended: boolean;
}

/** One downloadable piece of media inside a resolved link. */
export interface MediaItem {
  readonly id: string;
  /** Position within the post, 1-based, as published. */
  readonly index: number;
  readonly kind: MediaKind;
  readonly title?: string;
  /** Proxied thumbnail path on the SERA API, never a third-party URL. */
  readonly thumbnail?: string;
  readonly width?: number;
  readonly height?: number;
  /** Seconds. */
  readonly duration?: number;
  /** Best-guess container of the source media. */
  readonly container?: ContainerFormat;
  readonly filesizeBytes?: number;
  readonly isLive?: boolean;
  /** Everything the user may request for this item. Never empty. */
  readonly options: readonly DownloadOption[];
}

/** The normalized result of resolving a URL. The UI consumes only this. */
export interface MediaInfo {
  /** Stable id for this resolution, used to submit jobs. */
  readonly id: string;
  readonly provider: string;
  readonly providerLabel: string;
  /** The normalized URL that was actually resolved. */
  readonly url: string;
  readonly type: MediaInfoType;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  readonly thumbnail?: string;
  /** Seconds, for the primary item. */
  readonly duration?: number;
  /** ISO-8601. */
  readonly createdAt?: string;
  readonly items: readonly MediaItem[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Seconds until this resolution and its option ids stop being valid. */
  readonly expiresIn: number;
}

/* -------------------------------------------------------------------------- */
/*  Jobs                                                                      */
/* -------------------------------------------------------------------------- */

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

/** Terminal states — a job in one of these will never change again. */
export const TERMINAL_JOB_STATES = ['ready', 'failed', 'cancelled', 'expired'] as const;

export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];

export function isTerminalJobState(state: JobState): state is TerminalJobState {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export interface JobProgress {
  /** 0-100 across the whole job, monotonically non-decreasing. */
  readonly percent: number;
  /** Bytes fetched so far across every stream in the job. */
  readonly bytesDownloaded?: number;
  /** Total bytes expected, when it can be determined up front. */
  readonly bytesTotal?: number;
  /** Bytes per second, smoothed. */
  readonly speedBytesPerSecond?: number;
  /** Seconds remaining, when it can be estimated. */
  readonly etaSeconds?: number;
  /** For multi-file jobs: 1-based index of the file being worked on. */
  readonly currentFile?: number;
  readonly totalFiles?: number;
}

export interface JobResultFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  /** Path on the SERA API to fetch this individual file. */
  readonly downloadPath: string;
}

export interface JobResult {
  /** Path on the SERA API for the primary download (a file, or the ZIP). */
  readonly downloadPath: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly isArchive: boolean;
  /** Individually addressable files, present when the job produced more than one. */
  readonly files?: readonly JobResultFile[];
  /** ISO-8601 instant after which the files are deleted. */
  readonly expiresAt: string;
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
  /** This installation has no credentials for a source that now requires them. */
  | 'PROVIDER_AUTH_REQUIRED'
  /** Credentials exist but the source rejected them, or a setting is wrong. */
  | 'PROVIDER_CONFIGURATION_ERROR'
  /** The site's robots.txt asks automated clients not to read the page. */
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

/** A user-facing failure. `message` is safe to render; no stack traces ever cross the wire. */
export interface JobError {
  readonly code: ErrorCode;
  /** One human sentence, already in plain English. */
  readonly message: string;
  /** What the user can do about it, if anything. */
  readonly hint?: string;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean;
}

export interface Job {
  readonly id: string;
  readonly state: JobState;
  /** Short present-tense description of the current step, e.g. `Converting to MP3`. */
  readonly step: string;
  readonly progress: JobProgress;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: JobResult;
  readonly error?: JobError;
}

/* -------------------------------------------------------------------------- */
/*  Requests                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolveRequest {
  readonly url: string;
}

export type PackagingMode = 'auto' | 'zip' | 'individual';

export interface CreateJobRequest {
  /** The `MediaInfo.id` returned by a prior resolve. */
  readonly infoId: string;
  /** One or more `DownloadOption.id`s from that same resolution. */
  readonly optionIds: readonly string[];
  /** `auto` zips when more than one file is produced. Defaults to `auto`. */
  readonly packaging?: PackagingMode;
  /** Override the generated filename stem. Sanitized server-side regardless. */
  readonly filename?: string;
}

/* -------------------------------------------------------------------------- */
/*  Server-sent events                                                        */
/* -------------------------------------------------------------------------- */

export type JobEvent =
  | { readonly type: 'state'; readonly job: Job }
  | { readonly type: 'progress'; readonly job: Job }
  | { readonly type: 'done'; readonly job: Job }
  | { readonly type: 'error'; readonly job: Job }
  /** Keep-alive so intermediaries do not close an idle stream. */
  | { readonly type: 'ping' };

/* -------------------------------------------------------------------------- */
/*  Meta                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a source can actually produce here.
 *
 * The picker is built from an item's own options, so this is not what decides which
 * buttons appear — it is what lets a client say "Instagram photos need credentials this
 * server does not have" before anyone pastes a link, and what keeps the About page
 * honest about a provider that is only half available.
 */
export interface ProviderCapabilities {
  /* ---- what the platform serves ---- */

  readonly video: boolean;
  readonly image: boolean;
  /** Audio as media in its own right — a track, not a soundtrack lifted off a video. */
  readonly audio: boolean;
  /** An audio-only file can be produced from this provider's video. */
  readonly audioExtraction: boolean;
  /** More than one media item behind a single link, in a fixed order: a post's slides. */
  readonly carousel: boolean;
  /** More than one media item behind a link that is a container, not a post: a board. */
  readonly gallery: boolean;
  readonly gif: boolean;
  /** Streams still in progress. Refused everywhere so far, and declared so on purpose. */
  readonly live: boolean;

  /* ---- what it takes to reach it ---- */

  /**
   * The provider has an operator-credential mode at all — a session or an app
   * registration the operator may configure. Says nothing about whether one is set.
   */
  readonly authenticatedMode: boolean;
  /** Nothing works without operator credentials, as opposed to some of it. */
  readonly requiresOauth: boolean;

  /* ---- where extraction can run ---- */

  /**
   * Whether a node on a residential connection could succeed where a datacentre did
   * not. False is the interesting value: it means the refusal is about credentials or
   * the content, so spending someone's home connection on it would reach the same
   * answer more slowly. Measured per provider, not assumed.
   */
  readonly residentialFallback: boolean;
  /**
   * Whether extraction from a datacentre address is expected to work. False routes to a
   * node first when one is connected, instead of paying for a refusal that has already
   * been measured. With no node connected it changes nothing — the attempt is made
   * anyway, because a wrong guess must never turn into a refusal SERA invented.
   */
  readonly cloudExtraction: boolean;

  /**
   * Present when part of this provider needs credentials the installation lacks. Names
   * the part, so "Reels work, photos do not" can be said plainly.
   */
  readonly authRequiredFor?: readonly string[];
}

export interface ProviderSummary {
  readonly id: string;
  readonly label: string;
  /** Example hostnames the provider claims, for the About page. */
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

/** Envelope for every non-2xx API response. */
export interface ApiErrorBody {
  readonly error: JobError;
}
