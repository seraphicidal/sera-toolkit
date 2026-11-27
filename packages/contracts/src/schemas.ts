import { z } from 'zod';
import { checkTrim, TIMECODE_PATTERN } from './types.js';
import type {
  AndroidNodeAppUpdateInfo,
  ApiErrorBody,
  ContainerFormat,
  CreateJobRequest,
  DownloadOption,
  ExtractionNodeClaim,
  ExtractionNodeDispatch,
  ExtractionNodeFailed,
  ImportRequest,
  InstagramHotConfig,
  JobError,
  MediaInfoType,
  MediaKind,
  NodeAvailability,
  NodeFeature,
  NodeNetworkClass,
  NodeRole,
  NodeStatus,
  NodeTransport,
  NodeUpdateManifest,
  PackagingMode,
  ProviderCapabilities,
  ProviderHotConfig,
  ProviderSummary,
  RemoteProgress,
  RemoteResolvedBody,
  RemoteResolvedItem,
  RemoteResolvedMedia,
  RemoteResolvedPlan,
  RemoteTask,
  RemoteTaskItem,
  RemoteTaskKind,
  RemoteTaskSubtitles,
  ResolveRequest,
  ServiceInfo,
  YoutubeHotConfig,
  YtdlpUpdateInfo,
} from './types.js';

export const mediaKindSchema = z.enum(['video', 'audio', 'image', 'gif', 'file', 'unknown']);

export const mediaInfoTypeSchema = z.enum(['single', 'collection', 'playlist']);

export const containerFormatSchema = z.enum([
  'mp4',
  'webm',
  'mov',
  'mkv',
  'mp3',
  'm4a',
  'aac',
  'opus',
  'ogg',
  'wav',
  'flac',
  'gif',
  'jpg',
  'png',
  'webp',
  'avif',
  'pdf',
  'iso',
  'tar',
  '7z',
  'apk',
  'dmg',
  'exe',
  'epub',
  'zip',
  'bin',
]);

export const errorCodeSchema = z.enum([
  'INVALID_URL',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNSUPPORTED_SOURCE',
  'PRIVATE_CONTENT',
  'MEDIA_UNAVAILABLE',
  'GEO_RESTRICTED',
  'AGE_RESTRICTED',
  'LOGIN_REQUIRED',
  'SOURCE_BLOCKED',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_CONFIGURATION_ERROR',
  'ROBOTS_DISALLOWED',
  'DRM_PROTECTED',
  'LIVE_IN_PROGRESS',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_ERROR',
  'TOO_LARGE',
  'TOO_LONG',
  'CONVERSION_FAILED',
  'TIMEOUT',
  'CANCELLED',
  'NOT_FOUND',
  'EXPIRED',
  'BLOCKED_ADDRESS',
  'QUEUE_FULL',
  'INTERNAL',
]);

export const packagingModeSchema = z.enum(['auto', 'zip', 'individual']);

export const jobErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean(),
});

export const apiErrorBodySchema = z.object({
  error: jobErrorSchema,
});

export const downloadOptionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: z.enum(['video', 'audio', 'image', 'gif', 'file']),
  container: containerFormatSchema,
  label: z.string(),
  detail: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  audioBitrateKbps: z.number().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  filesizeBytes: z.number().optional(),
  filesizeIsApproximate: z.boolean().optional(),
  requiresConversion: z.boolean(),
  recommended: z.boolean(),
});

export const MAX_URL_LENGTH = 2048;

export const MAX_FILENAME_LENGTH = 200;

export const MAX_TOKEN_LENGTH = 4096;

export const MAX_INFO_TOKEN_LENGTH = 40_000;

export const MAX_IMPORTED_ITEMS = 50;

export const MAX_OPTIONS_PER_JOB = 200;

export const resolveRequestSchema = z.object({
  url: z.string().trim().min(1, 'Enter a link.').max(MAX_URL_LENGTH, 'That link is too long.'),
});

function stripNulls(value: unknown, depth: number): unknown {
  if (value === null) return undefined;
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripNulls(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, entry]) =>
            key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && entry !== null,
        )
        .map(([key, entry]) => [key, stripNulls(entry, depth + 1)]),
    );
  }
  return value;
}

function withoutNulls(value: unknown): unknown {
  return stripNulls(value, 0);
}

const importedCandidateSchema = z.object({
  url: z.string().max(MAX_URL_LENGTH).optional(),
  width: z.number().int().nonnegative().max(20_000).optional(),
  height: z.number().int().nonnegative().max(20_000).optional(),
});

const importedMediaSchema = z.object({
  id: z.string().max(64).optional(),
  code: z.string().max(64).optional(),
  media_type: z.number().int().optional(),
  image_versions2: z
    .object({ candidates: z.array(importedCandidateSchema).max(20).optional() })
    .optional(),
  video_versions: z.array(importedCandidateSchema).max(20).optional(),
  video_duration: z.number().nonnegative().max(86_400).optional(),
  accessibility_caption: z.string().max(2_000).optional(),
});

export const importedPostNodeSchema = importedMediaSchema.extend({
  carousel_media: z.array(importedMediaSchema).max(MAX_IMPORTED_ITEMS).optional(),
  user: z
    .object({
      username: z.string().max(64).optional(),
      full_name: z.string().max(256).optional(),
    })
    .optional(),
  caption: z.object({ text: z.string().max(10_000).optional() }).optional(),
});

export const importRequestSchema = z.object({
  url: z.string().trim().min(1, 'Enter a link.').max(MAX_URL_LENGTH, 'That link is too long.'),
  node: z.preprocess(withoutNulls, importedPostNodeSchema),
});

const timecode = z
  .string()
  .trim()
  .max(9)
  .regex(TIMECODE_PATTERN, 'Use m:ss or h:mm:ss for the trim times.');

export const trimRequestSchema = z
  .object({ start: timecode.optional(), end: timecode.optional() })
  .superRefine((trim, context) => {
    const checked = checkTrim(trim);
    if (!checked.ok) context.addIssue({ code: 'custom', message: checked.message });
  });

export const subtitleRequestSchema = z
  .object({
    lang: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/,
        'That subtitle language is not one the source offers.',
      ),
    auto: z.boolean().optional(),
    format: z.enum(['srt', 'vtt', 'embed']),
    only: z.boolean().optional(),
  })
  .refine((subtitles) => !(subtitles.only && subtitles.format === 'embed'), {
    message: 'Subtitles can only be embedded in a video that is downloaded with them.',
  });

export const createJobRequestSchema = z.object({
  infoId: z.string().min(1).max(MAX_INFO_TOKEN_LENGTH),
  optionIds: z.array(z.string().min(1).max(512)).min(1).max(MAX_OPTIONS_PER_JOB),
  packaging: packagingModeSchema.optional(),
  filename: z.string().max(MAX_FILENAME_LENGTH).optional(),
  trim: trimRequestSchema.optional(),
  subtitles: subtitleRequestSchema.optional(),
});

export const legalReportCategorySchema = z.enum([
  'copyright',
  'malware',
  'illegal_content',
  'other',
]);

export const legalReportRequestSchema = z.object({
  targetUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'Enter an http:// or https:// URL.'),
  category: legalReportCategorySchema,
  explanation: z.string().min(10).max(10000),
  notifierName: z.string().min(2).max(256),
  notifierOrganization: z.string().max(256).optional(),
  notifierEmail: z.string().email().max(320),
  goodFaithConfirmed: z.literal(true),
});

export const legalReportResponseSchema = z.object({
  reportId: z.string(),
  receivedAt: z.string(),
  status: z.enum(['received', 'action_taken']),
  mitigated: z.boolean().optional(),
});

export const providerCapabilitiesSchema = z.object({
  video: z.boolean(),
  image: z.boolean(),
  audio: z.boolean(),
  audioExtraction: z.boolean(),
  carousel: z.boolean(),
  gallery: z.boolean(),
  gif: z.boolean(),
  live: z.boolean(),
  authenticatedMode: z.boolean(),
  requiresOauth: z.boolean(),
  residentialFallback: z.boolean(),
  cloudExtraction: z.boolean(),
  browserImport: z.boolean(),
  authRequiredFor: z.array(z.string()).optional(),
});

export const providerSummarySchema = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(64),
  hosts: z.array(z.string().min(1).max(256)),
  status: z.enum(['ok', 'degraded', 'unavailable']),
  capabilities: providerCapabilitiesSchema,
});

export const nodeAvailabilitySchema = z.object({
  enabled: z.boolean(),
  totalNodes: z.number().int().nonnegative(),
  healthyNodes: z.number().int().nonnegative(),
  residentialNodes: z.number().int().nonnegative(),
  primaryNodes: z.number().int().nonnegative().optional(),
  backupNodes: z.number().int().nonnegative().optional(),
  features: z.array(z.string().min(1).max(64)),
  providers: z.array(z.string().min(1).max(32)),
});

export const serviceInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  providers: z.array(providerSummarySchema),
  limits: z.object({
    maxFilesizeBytes: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive(),
    maxItemsPerJob: z.number().int().positive(),
    retentionSeconds: z.number().int().positive(),
  }),
  nodeAvailability: nodeAvailabilitySchema.optional(),
});

export const ServiceInfoSchema = serviceInfoSchema;

export const httpUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((u) => !/[\x00-\x20\x7f]/.test(u), 'URL contains forbidden characters.')
  .url()
  .refine(
    (u) => /^https?:\/\//i.test(u) && !/^https?:\/\/[^/?#]*@/i.test(u),
    'URL must use http or https without credentials.',
  );

const SAFE_EXTRACTOR_ARG_RE = /^[a-z0-9][a-z0-9_-]{0,31}:[A-Za-z0-9_.,;+=-]{1,180}$/;
const FORBIDDEN_EXTRACTOR_ARG_RE = /(?:^|[:;])(?:base_url|proxy|cookies?|file|path|exec)=/i;

export const safeExtractorArgSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(SAFE_EXTRACTOR_ARG_RE, 'Invalid extractor argument.')
  .refine((value) => !FORBIDDEN_EXTRACTOR_ARG_RE.test(value), 'Disallowed extractor argument.');

export const safeYtdlpSelectorSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9_+.*[\]=!<>~^:,\s/-]{1,500}$/, 'Invalid format selector.')
  .refine((value) => !value.trimStart().startsWith('-'), 'Format selector cannot start with -.');

export const safeUseExtractorsSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:,+-]{0,99}$/, 'Invalid extractor list.');

const ALLOWED_YOUTUBE_BOOL_FLAGS = new Set([
  '--force-ipv4',
  '--force-ipv6',
  '--geo-bypass',
  '--no-geo-bypass',
  '--no-remote-components',
  '--prefer-free-formats',
  '--no-prefer-free-formats',
  '--hls-prefer-native',
]);

const ALLOWED_YOUTUBE_VALUE_FLAGS: Readonly<Record<string, (value: string) => boolean>> = {
  '--sleep-requests': (v) => /^\d{1,2}(?:\.\d{1,2})?$/.test(v) && Number(v) <= 60,
  '--sleep-interval': (v) => /^\d{1,2}(?:\.\d{1,2})?$/.test(v) && Number(v) <= 60,
  '--max-sleep-interval': (v) => /^\d{1,3}(?:\.\d{1,2})?$/.test(v) && Number(v) <= 120,
  '--sleep-subtitles': (v) => /^\d{1,2}(?:\.\d{1,2})?$/.test(v) && Number(v) <= 60,
  '--retries': (v) => /^\d{1,2}$/.test(v) && Number(v) <= 20,
  '--fragment-retries': (v) => /^\d{1,2}$/.test(v) && Number(v) <= 20,
  '--extractor-retries': (v) => /^\d{1,2}$/.test(v) && Number(v) <= 20,
  '--socket-timeout': (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 120,
  '--concurrent-fragments': (v) => /^[1-9]\d?$/.test(v) && Number(v) <= 16,
  '--throttled-rate': (v) => /^\d{1,6}[KMG]?$/.test(v),
  '--geo-bypass-country': (v) => /^[A-Z]{2}$/.test(v),
  '--extractor-args': (v) => safeExtractorArgSchema.safeParse(v).success,
  '--remote-components': (v) =>
    /^[a-z0-9][a-z0-9_-]{0,31}:[a-z0-9_.,-]{1,80}(?:,[a-z0-9][a-z0-9_-]{0,31}:[a-z0-9_.,-]{1,80})*$/.test(
      v,
    ),
  '--impersonate': (v) => /^[a-z0-9][a-z0-9_.,:-]{0,63}$/i.test(v),
  '--compat-options': (v) => /^[a-z0-9][a-z0-9_,-]{0,63}$/i.test(v),
  '--format-sort': (v) => /^[A-Za-z0-9][A-Za-z0-9_.:,+~-]{0,127}$/.test(v),
};

export function isSafeYoutubeExtraArgs(args: readonly string[]): boolean {
  if (args.length > 50) return false;
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > 200 ||
      /[\x00-\x1f\x7f]/.test(token)
    ) {
      return false;
    }
    if (!token.startsWith('--')) return false;
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (ALLOWED_YOUTUBE_BOOL_FLAGS.has(flag)) {
      if (eq !== -1) return false;
      i += 1;
      continue;
    }
    const validator = Object.hasOwn(ALLOWED_YOUTUBE_VALUE_FLAGS, flag)
      ? ALLOWED_YOUTUBE_VALUE_FLAGS[flag]
      : undefined;
    if (!validator) return false;
    let value: string | undefined;
    if (eq !== -1) {
      value = token.slice(eq + 1);
      i += 1;
    } else {
      value = args[i + 1];
      if (value === undefined) return false;
      i += 2;
    }
    if (!value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) {
      return false;
    }
    if (!validator(value)) return false;
  }
  return true;
}

export const youtubeExtraArgsSchema = z
  .array(z.string().min(1).max(200))
  .max(50)
  .refine(isSafeYoutubeExtraArgs, 'Contains disallowed or malformed yt-dlp extraArgs.');

export const nodeNetworkClassSchema = z.enum(['datacenter', 'residential', 'unknown']);

export const nodeTransportSchema = z.enum(['wifi', 'cellular', 'other']);

export const nodeRoleSchema = z.enum(['primary', 'backup']);

export const nodeFeatureSchema = z.enum(['trim', 'subtitles', 'items', 'instagram-session']);

export const remoteTaskKindSchema = z.enum(['resolve', 'job']);

export const remoteTaskItemSchema = z.object({
  index: z.number().int().min(0).max(1000),
  sourceId: z.string().min(1).max(200).optional(),
});

export const remoteTaskSubtitlesSchema = z.object({
  lang: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
  auto: z.boolean(),
  format: z.enum(['srt', 'vtt', 'embed']),
  only: z.boolean(),
});

export const remoteTrimRangeSchema = z.object({
  start: z.number().min(0),
  end: z.number().positive().optional(),
});

export const remoteTaskSchema = z.object({
  id: z.string().min(1).max(64),
  kind: remoteTaskKindSchema,
  url: httpUrlSchema,
  providerId: z.string().min(1).max(32),
  networkClass: nodeNetworkClassSchema.optional(),
  planKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
  items: z.array(remoteTaskItemSchema).max(100).optional(),
  filename: z.string().max(200).optional(),
  trim: remoteTrimRangeSchema.optional(),
  requires: z.array(nodeFeatureSchema).max(5).optional(),
  avoid: z.array(z.string().min(1).max(64)).max(20).optional(),
  subtitles: remoteTaskSubtitlesSchema.optional(),
  createdAt: z.number().nonnegative(),
});

export const claimSchema = z.object({
  nodeId: z.string().min(1).max(64),
  providers: z.array(z.string().min(1).max(32)).max(50),
  capacity: z.coerce.number().int().min(1).max(8).default(1),
  networkClass: nodeNetworkClassSchema.default('residential'),
  features: z.array(z.string().min(1).max(32)).max(20).default([]),
  transport: nodeTransportSchema.optional(),
  role: nodeRoleSchema.optional(),
  priority: z.coerce.number().int().min(-1000).max(1000).optional(),
  appVersion: z.string().min(1).max(64).optional(),
  ytdlpVersion: z.string().min(1).max(64).optional(),
  ffmpegVersion: z.string().min(1).max(64).optional(),
});

export const claimBodySchema = claimSchema;

export const dispatchSchema = z.object({
  kind: remoteTaskKindSchema,
  url: httpUrlSchema,
  providerId: z.string().min(1).max(32),
  planKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
  items: z.array(remoteTaskItemSchema).max(100).optional(),
  filename: z.string().max(200).optional(),
  networkClass: nodeNetworkClassSchema.optional(),
  trim: remoteTrimRangeSchema.optional(),
  requires: z.array(nodeFeatureSchema).max(5).optional(),
  avoid: z.array(z.string().min(1).max(64)).max(20).optional(),
  subtitles: remoteTaskSubtitlesSchema.optional(),
});

export const progressSchema = z.object({
  percent: z.coerce.number().min(0).max(100),
  step: z.string().min(1).max(120),
  bytesDownloaded: z.coerce.number().int().min(0).optional(),
  bytesTotal: z.coerce.number().int().min(0).optional(),
  speedBytesPerSecond: z.coerce.number().min(0).finite().optional(),
  etaSeconds: z.coerce.number().min(0).finite().optional(),
});

export const failedSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(500).optional(),
  detail: z.string().max(2000).optional(),
});

export const nodeStatusSchema = z.object({
  id: z.string().min(1).max(64),
  providers: z.array(z.string().min(1).max(32)).max(50),
  networkClass: nodeNetworkClassSchema,
  capacity: z.number().int().min(1).max(8),
  features: z.array(z.string().min(1).max(32)).max(20).optional(),
  transport: nodeTransportSchema.optional(),
  role: nodeRoleSchema.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  appVersion: z.string().min(1).max(64).optional(),
  ytdlpVersion: z.string().min(1).max(64).optional(),
  ffmpegVersion: z.string().min(1).max(64).optional(),
  inFlight: z.number().int().nonnegative(),
  lastSeenMs: z.number().nonnegative(),
  healthy: z.boolean(),
});

export const resolvedPlanSchema = z.object({
  kind: z.enum(['video', 'audio', 'image', 'gif', 'file']),
  container: containerFormatSchema,
  label: z.string().min(1).max(64),
  detail: z.string().max(500).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  audioBitrateKbps: z.number().positive().optional(),
  videoCodec: z.string().max(32).optional(),
  audioCodec: z.string().max(32).optional(),
  filesizeBytes: z.number().int().nonnegative().optional(),
  filesizeIsApproximate: z.boolean().optional(),
  requiresConversion: z.boolean(),
  recommended: z.boolean(),
  fetch: z.discriminatedUnion('via', [
    z.object({
      via: z.literal('ytdlp'),
      selector: safeYtdlpSelectorSchema,
      merge: z.enum(['mp4', 'webm', 'mkv', 'mov']).optional(),
      audio: z
        .object({
          format: z.enum(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac', 'best']),
          quality: z
            .string()
            .regex(/^(?:[0-9]|10|\d{2,4}[Kk])$/, 'Invalid audio quality.')
            .optional(),
        })
        .optional(),
      remux: z.enum(['mp4', 'webm', 'mkv', 'mov']).optional(),
      extractorArgs: z.array(safeExtractorArgSchema).max(20).optional(),
      target: httpUrlSchema.optional(),
      useExtractors: safeUseExtractorsSchema.optional(),
    }),
    z.object({
      via: z.literal('direct'),
      url: httpUrlSchema,
    }),
  ]),
  convert: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('remux'),
        container: z.enum(['mp4', 'webm', 'mov', 'mkv']),
      }),
      z.object({
        kind: z.literal('video'),
        container: z.enum(['mp4', 'webm']),
      }),
      z.object({
        kind: z.literal('audio'),
        container: z.enum(['mp3', 'm4a', 'opus', 'wav', 'flac']),
        bitrateKbps: z.number().int().min(32).max(512).optional(),
      }),
      z.object({
        kind: z.literal('gif'),
        maxWidth: z.number().int().min(32).max(2048).optional(),
        fps: z.number().int().min(1).max(60).optional(),
      }),
    ])
    .optional(),
});

export const resolvedItemSchema = z.object({
  sourceId: z.string().max(200).optional(),
  index: z.number().int().nonnegative(),
  kind: mediaKindSchema,
  title: z.string().max(500).optional(),
  thumbnailUrl: httpUrlSchema.optional(),
  thumbnailFallbackUrl: httpUrlSchema.optional(),
  subtitles: z
    .array(
      z.object({
        lang: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
        label: z.string().max(100),
        auto: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  tags: z
    .object({
      artist: z.string().max(200).optional(),
      album: z.string().max(200).optional(),
      track: z.string().max(200).optional(),
    })
    .optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional(),
  container: containerFormatSchema.optional(),
  filesizeBytes: z.number().nonnegative().optional(),
  isLive: z.boolean().optional(),
  plans: z.array(resolvedPlanSchema).min(1).max(64),
});

export const resolvedMediaSchema = z.object({
  provider: z.string().min(1).max(32),
  providerLabel: z.string().min(1).max(64),
  url: httpUrlSchema,
  type: mediaInfoTypeSchema,
  title: z.string().max(500),
  description: z.string().max(5000).optional(),
  author: z.string().max(200).optional(),
  authorUrl: httpUrlSchema.optional(),
  thumbnailUrl: httpUrlSchema.optional(),
  duration: z.number().nonnegative().optional(),
  createdAt: z.string().max(64).optional(),
  remoteBackend: z.string().max(64).optional(),
  items: z.array(resolvedItemSchema).min(1).max(200),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const resolvedBodySchema = z.object({
  media: resolvedMediaSchema,
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export const ytdlpUpdateInfoSchema = z.object({
  version: z.string().min(1).max(64),
  assetName: z.string().min(1).max(128),
  sha256: sha256Schema.optional(),
  url: httpUrlSchema,
  proxyPath: z.string().min(1).max(256),
});

export const androidNodeAppUpdateInfoSchema = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(64),
  sha256: sha256Schema,
  apkUrl: httpUrlSchema,
  proxyPath: z.string().min(1).max(256),
  releaseNotes: z.string().max(8000).optional(),
  minVersionCode: z.number().int().positive().optional(),
});

export const youtubePlayerClientSchema = z.string().regex(/^[a-z0-9_+-]{1,64}$/i);

export const youtubeRemoteComponentSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}:[a-z0-9_.,-]{1,80}$/);

export const youtubeHotConfigSchema = z.object({
  playerClients: z.array(youtubePlayerClientSchema).max(20),
  extraArgs: youtubeExtraArgsSchema,
  remoteComponents: z.array(youtubeRemoteComponentSchema).max(20),
  potProviderUrl: httpUrlSchema.optional(),
});

export const instagramHotConfigSchema = z.object({
  webApiAppId: z.string().min(1).max(64),
  userAgent: z.string().min(1).max(512),
  cdnHosts: z.array(z.string().min(1).max(256)).min(1).max(50),
  strategyOrder: z
    .array(z.enum(['ytdlp', 'web-api', 'oembed']))
    .min(1)
    .max(10),
});

export const providerHotConfigSchema = z.object({
  youtube: youtubeHotConfigSchema,
  instagram: instagramHotConfigSchema,
});

export const nodeUpdateManifestSchema = z.object({
  manifestHash: z.string().min(1).max(128),
  generatedAt: z.string().min(1).max(64),
  ytdlp: ytdlpUpdateInfoSchema,
  androidNodeApp: androidNodeAppUpdateInfoSchema.optional(),
  providerConfig: providerHotConfigSchema,
});

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

type Mutual<A, B> = [Exclude<A, B>] extends [never]
  ? [Exclude<B, A>] extends [never]
    ? true
    : false
  : false;

type ValuesDiffer<A, B> = {
  [K in keyof A & keyof B]: [A[K]] extends [B[K]] ? ([B[K]] extends [A[K]] ? never : K) : K;
}[keyof A & keyof B];

type SameShape<A, B> =
  Mutual<keyof A, keyof B> extends true
    ? Mutual<OptionalKeys<A>, OptionalKeys<B>> extends true
      ? [ValuesDiffer<A, B>] extends [never]
        ? true
        : false
      : false
    : false;

type _MediaKindMatches = Assert<Exact<z.infer<typeof mediaKindSchema>, MediaKind>>;
type _MediaInfoTypeMatches = Assert<Exact<z.infer<typeof mediaInfoTypeSchema>, MediaInfoType>>;
type _ContainerMatches = Assert<Exact<z.infer<typeof containerFormatSchema>, ContainerFormat>>;
type _PackagingMatches = Assert<Exact<z.infer<typeof packagingModeSchema>, PackagingMode>>;
type _JobErrorMatches = Assert<SameShape<z.infer<typeof jobErrorSchema>, Writable<JobError>>>;
type _ApiErrorBodyMatches = Assert<
  SameShape<z.infer<typeof apiErrorBodySchema>, DeepMutable<ApiErrorBody>>
>;
type _ProviderCapabilitiesMatches = Assert<
  SameShape<z.infer<typeof providerCapabilitiesSchema>, DeepMutable<ProviderCapabilities>>
>;
type _ProviderSummaryMatches = Assert<
  SameShape<z.infer<typeof providerSummarySchema>, DeepMutable<ProviderSummary>>
>;
type _NodeAvailabilityMatches = Assert<
  SameShape<z.infer<typeof nodeAvailabilitySchema>, DeepMutable<NodeAvailability>>
>;
type _ServiceInfoMatches = Assert<
  SameShape<z.infer<typeof serviceInfoSchema>, DeepMutable<ServiceInfo>>
>;
type _ResolveMatches = Assert<
  SameShape<z.infer<typeof resolveRequestSchema>, Writable<ResolveRequest>>
>;
type _OptionMatches = Assert<
  SameShape<z.infer<typeof downloadOptionSchema>, Writable<DownloadOption>>
>;
type _CreateJobMatches = Assert<
  SameShape<
    z.infer<typeof createJobRequestSchema>,
    Omit<Writable<CreateJobRequest>, 'optionIds'> & { optionIds: string[] }
  >
>;

type _ImportFits = Assert<z.infer<typeof importRequestSchema> extends ImportRequest ? true : false>;

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

type _NodeNetworkClassMatches = Assert<
  Exact<z.infer<typeof nodeNetworkClassSchema>, NodeNetworkClass>
>;
type _NodeTransportMatches = Assert<Exact<z.infer<typeof nodeTransportSchema>, NodeTransport>>;
type _NodeRoleMatches = Assert<Exact<z.infer<typeof nodeRoleSchema>, NodeRole>>;
type _NodeFeatureMatches = Assert<Exact<z.infer<typeof nodeFeatureSchema>, NodeFeature>>;
type _RemoteTaskKindMatches = Assert<Exact<z.infer<typeof remoteTaskKindSchema>, RemoteTaskKind>>;
type _RemoteTaskItemMatches = Assert<
  SameShape<z.infer<typeof remoteTaskItemSchema>, DeepMutable<RemoteTaskItem>>
>;
type _RemoteTaskSubtitlesMatches = Assert<
  SameShape<z.infer<typeof remoteTaskSubtitlesSchema>, DeepMutable<RemoteTaskSubtitles>>
>;
type _RemoteTaskMatches = Assert<
  SameShape<z.infer<typeof remoteTaskSchema>, DeepMutable<RemoteTask>>
>;
type _ClaimMatches = Assert<
  SameShape<z.infer<typeof claimSchema>, DeepMutable<ExtractionNodeClaim>>
>;
type _DispatchMatches = Assert<
  SameShape<z.infer<typeof dispatchSchema>, DeepMutable<ExtractionNodeDispatch>>
>;
type _ProgressMatches = Assert<
  SameShape<z.infer<typeof progressSchema>, DeepMutable<RemoteProgress>>
>;
type _FailedMatches = Assert<
  SameShape<z.infer<typeof failedSchema>, DeepMutable<ExtractionNodeFailed>>
>;
type _NodeStatusMatches = Assert<
  SameShape<z.infer<typeof nodeStatusSchema>, DeepMutable<NodeStatus>>
>;
type _ResolvedPlanMatches = Assert<
  SameShape<z.infer<typeof resolvedPlanSchema>, DeepMutable<RemoteResolvedPlan>>
>;
type _ResolvedItemMatches = Assert<
  SameShape<z.infer<typeof resolvedItemSchema>, DeepMutable<RemoteResolvedItem>>
>;
type _ResolvedMediaMatches = Assert<
  SameShape<z.infer<typeof resolvedMediaSchema>, DeepMutable<RemoteResolvedMedia>>
>;
type _ResolvedBodyMatches = Assert<
  SameShape<z.infer<typeof resolvedBodySchema>, DeepMutable<RemoteResolvedBody>>
>;
type _YtdlpUpdateInfoMatches = Assert<
  SameShape<z.infer<typeof ytdlpUpdateInfoSchema>, DeepMutable<YtdlpUpdateInfo>>
>;
type _AndroidNodeAppUpdateInfoMatches = Assert<
  SameShape<z.infer<typeof androidNodeAppUpdateInfoSchema>, DeepMutable<AndroidNodeAppUpdateInfo>>
>;
type _YoutubeHotConfigMatches = Assert<
  SameShape<z.infer<typeof youtubeHotConfigSchema>, DeepMutable<YoutubeHotConfig>>
>;
type _InstagramHotConfigMatches = Assert<
  SameShape<z.infer<typeof instagramHotConfigSchema>, DeepMutable<InstagramHotConfig>>
>;
type _ProviderHotConfigMatches = Assert<
  SameShape<z.infer<typeof providerHotConfigSchema>, DeepMutable<ProviderHotConfig>>
>;
type _NodeUpdateManifestMatches = Assert<
  SameShape<z.infer<typeof nodeUpdateManifestSchema>, DeepMutable<NodeUpdateManifest>>
>;
