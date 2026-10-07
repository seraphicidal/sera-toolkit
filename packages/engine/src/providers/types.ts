import type { NodeFeature } from '../extract/remote.js';
import type { SubtitleTrack } from '@sera/contracts/types';
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

export interface MediaProvider {
  readonly id: string;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly priority: number;

  readonly capabilities: ProviderCapabilities;
  readonly nodeSession?: NodeFeature;
  readonly withNodeSession?: Partial<ProviderCapabilities>;

  canHandle(url: URL, host: string): boolean;

  normalize?(url: URL): URL;

  resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia>;
}

export interface ProviderContext {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly allowDegraded?: boolean;
  readonly probe: (
    url: string,
    options?: {
      readonly playlist?: boolean;
      readonly flatPlaylist?: boolean;
      readonly extractorArgs?: readonly string[];
      readonly timeoutMs?: number;
      readonly proxy?: string;
    },
  ) => Promise<YtdlpInfo>;
  readonly fetchText: (
    url: URL,
    maxBytes?: number,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly keepCookies?: boolean;
    },
  ) => Promise<{ body: string; url: string }>;
  readonly head: (
    url: URL,
  ) => Promise<{ status: number; contentType?: string; contentLength?: number; url: string }>;
}

export type FetchPlan =
  | {
      readonly via: 'ytdlp';
      readonly selector: string;
      readonly merge?: ContainerFormat;
      readonly audio?: { readonly format: string; readonly quality?: string };
      readonly remux?: ContainerFormat;
      readonly extractorArgs?: readonly string[];
    }
  | {
      readonly via: 'direct';
      readonly url: string;
    };

export interface DownloadPlan {
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
  readonly fetch: FetchPlan;
  readonly convert?: ConversionSpec;
}

export interface ResolvedItem {
  readonly sourceId?: string;
  readonly index: number;
  readonly kind: MediaKind;
  readonly title?: string;
  readonly thumbnailUrl?: string;
  readonly thumbnailFallbackUrl?: string;
  readonly subtitles?: readonly SubtitleTrack[];
  readonly tags?: { readonly artist?: string; readonly album?: string; readonly track?: string };
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly container?: ContainerFormat;
  readonly filesizeBytes?: number;
  readonly isLive?: boolean;
  readonly plans: readonly DownloadPlan[];
}

export interface ResolvedMedia {
  readonly provider: string;
  readonly providerLabel: string;
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
  readonly remoteBackend?: string;
}

export function planKey(plan: DownloadPlan): string {
  return `${plan.kind}/${plan.container}/${plan.label}`;
}
