import type {
  ContainerFormat,
  MediaInfoType,
  MediaKind,
  ProviderCapabilities,
} from '@sera/contracts/types';
import type { ConversionSpec } from '../convert/ffmpeg.js';
import type { EngineConfig } from '../config.js';
import type { Logger } from '../logging.js';
import type { YtdlpInfo } from '../extract/ytdlp-types.js';

/**
 * The provider contract.
 *
 * A provider's only job is to turn a URL into `ResolvedMedia`. It never downloads, never
 * touches the filesystem, and never decides how a file is named or packaged — which is
 * why adding a platform means adding one file and one registry line, and why a broken
 * provider degrades to a message about that source rather than taking the service down.
 */
export interface MediaProvider {
  /** Stable identifier, used in tokens, logs and the About page. */
  readonly id: string;
  /** Human name shown in the UI. */
  readonly label: string;
  /** Hostnames this provider claims. Doubles as the allowlist for the extractor. */
  readonly hosts: readonly string[];
  /**
   * Lower runs first. The generic and direct fallbacks sit at the end so a dedicated
   * provider always wins for a host it knows.
   */
  readonly priority: number;

  /**
   * What this provider can produce, as this installation is configured.
   *
   * It is not what builds the format picker — an item's own options do that — but it is
   * what lets a client say "photos here need credentials this server does not have"
   * before anyone pastes a link.
   */
  readonly capabilities: ProviderCapabilities;

  /** Whether this provider handles the URL. Must be cheap and side-effect free. */
  canHandle(url: URL, host: string): boolean;

  /** Rewrites a URL into the canonical form the extractor prefers. */
  normalize?(url: URL): URL;

  /** Resolves the URL to media. Throws a `SeraError` when it cannot. */
  resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia>;
}

/** Everything a provider is allowed to reach. Injected so tests can supply fakes. */
export interface ProviderContext {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** Runs yt-dlp's metadata dump. */
  readonly probe: (
    url: string,
    options?: {
      readonly playlist?: boolean;
      readonly flatPlaylist?: boolean;
      /** `--extractor-args` entries. Was declared on providers and never reached yt-dlp. */
      readonly extractorArgs?: readonly string[];
      /** Overrides the shared ceiling, so one slow source cannot hold the worker. */
      readonly timeoutMs?: number;
    },
  ) => Promise<YtdlpInfo>;
  /** Fetches a URL through the SSRF-guarded client. */
  readonly fetchText: (url: URL, maxBytes?: number) => Promise<{ body: string; url: string }>;
  /** Issues a HEAD request through the SSRF-guarded client. */
  readonly head: (
    url: URL,
  ) => Promise<{ status: number; contentType?: string; contentLength?: number; url: string }>;
}

/** How the pipeline should obtain a plan's bytes. */
export type FetchPlan =
  | {
      readonly via: 'ytdlp';
      /** A yt-dlp format selector, e.g. `137+140`, `bestaudio`. */
      readonly selector: string;
      /** `--merge-output-format`, when the selector combines streams. */
      readonly merge?: ContainerFormat;
      /** Delegates audio extraction to yt-dlp's postprocessor. */
      readonly audio?: { readonly format: string; readonly quality?: string };
      /** `--remux-video`, for a container change with no re-encode. */
      readonly remux?: ContainerFormat;
      /** Extra `--extractor-args` values for this specific fetch. */
      readonly extractorArgs?: readonly string[];
    }
  | {
      readonly via: 'direct';
      /** Absolute media URL, fetched through the guarded client. */
      readonly url: string;
    };

/** One thing the user can choose, plus everything needed to deliver it. */
export interface DownloadPlan {
  readonly kind: Exclude<MediaKind, 'unknown'>;
  readonly container: ContainerFormat;
  /** Short label; also the stable half of the plan key, so keep it deterministic. */
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
  readonly fetch: FetchPlan;
  /** Applied after the download, when yt-dlp cannot produce the target itself. */
  readonly convert?: ConversionSpec;
}

/** One downloadable piece of media in a resolution. */
export interface ResolvedItem {
  /**
   * The provider's own id for this item. Used to re-find it when the job re-resolves,
   * so a carousel that gained an item overnight cannot shift the selection.
   */
  readonly sourceId?: string;
  readonly index: number;
  readonly kind: MediaKind;
  readonly title?: string;
  /** Absolute thumbnail URL. Proxied before it reaches the browser. */
  readonly thumbnailUrl?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly container?: ContainerFormat;
  readonly filesizeBytes?: number;
  readonly isLive?: boolean;
  readonly plans: readonly DownloadPlan[];
}

/** A provider's answer: normalized, but not yet signed or client-facing. */
export interface ResolvedMedia {
  readonly provider: string;
  readonly providerLabel: string;
  /** Canonical URL that was resolved. Jobs re-resolve exactly this. */
  readonly url: string;
  readonly type: MediaInfoType;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  readonly thumbnailUrl?: string;
  readonly duration?: number;
  readonly createdAt?: string;
  readonly items: readonly ResolvedItem[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The identity of a plan across resolutions.
 *
 * A job token stores this rather than an array index, so if a provider's format list
 * shifts between resolve and download, the pipeline still selects what the user picked —
 * or reports that the choice is gone, instead of silently downloading something else.
 */
export function planKey(plan: DownloadPlan): string {
  return `${plan.kind}/${plan.container}/${plan.label}`;
}
