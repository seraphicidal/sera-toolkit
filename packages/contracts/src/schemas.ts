import { z } from 'zod';
import { checkTrim, TIMECODE_PATTERN } from './types.js';
import type {
  ContainerFormat,
  CreateJobRequest,
  DownloadOption,
  ImportRequest,
  JobError,
  MediaInfoType,
  MediaKind,
  PackagingMode,
  ResolveRequest,
} from './types.js';

export const mediaKindSchema = z.enum(['video', 'audio', 'image', 'gif', 'unknown']);

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
  'zip',
  'bin',
]);

export const errorCodeSchema = z.enum([
  'INVALID_URL',
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

export const downloadOptionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: z.enum(['video', 'audio', 'image', 'gif']),
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

export const MAX_OPTIONS_PER_JOB = 64;

export const resolveRequestSchema = z.object({
  url: z.string().trim().min(1, 'Enter a link.').max(MAX_URL_LENGTH, 'That link is too long.'),
});

function withoutNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== null)
        .map(([key, entry]) => [key, withoutNulls(entry)]),
    );
  }
  return value;
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
