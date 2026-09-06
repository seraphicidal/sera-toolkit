/**
 * Runtime validation for everything that crosses the network boundary.
 *
 * Only the server imports this module; the browser bundle imports `@sera/contracts/types`
 * instead so it never pays for the validator. The drift guards at the bottom fail
 * the build if the two definitions ever drift apart.
 */

import { z } from 'zod';
import type {
  ContainerFormat,
  CreateJobRequest,
  DownloadOption,
  JobError,
  MediaInfoType,
  MediaKind,
  PackagingMode,
  ResolveRequest,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

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

export const jobStateSchema = z.enum([
  'queued',
  'resolving',
  'downloading',
  'merging',
  'converting',
  'packaging',
  'finalizing',
  'ready',
  'failed',
  'cancelled',
  'expired',
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

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/* -------------------------------------------------------------------------- */

/** Hard ceiling on submitted URL length; nothing legitimate approaches this. */
export const MAX_URL_LENGTH = 2048;

/** Hard ceiling on a user-supplied filename stem, before sanitization. */
export const MAX_FILENAME_LENGTH = 200;

/**
 * Ceiling for a signed resolution token.
 *
 * It embeds the canonical URL, so it scales with MAX_URL_LENGTH: base64 costs a third
 * more, plus the JSON envelope and a 43-character signature.
 */
export const MAX_TOKEN_LENGTH = 4096;

/** Ceiling on how many options one job may combine. */
export const MAX_OPTIONS_PER_JOB = 64;

export const resolveRequestSchema = z.object({
  url: z.string().trim().min(1, 'Enter a link.').max(MAX_URL_LENGTH, 'That link is too long.'),
});

export const createJobRequestSchema = z.object({
  infoId: z.string().min(1).max(MAX_TOKEN_LENGTH),
  optionIds: z.array(z.string().min(1).max(512)).min(1).max(MAX_OPTIONS_PER_JOB),
  packaging: packagingModeSchema.optional(),
  filename: z.string().max(MAX_FILENAME_LENGTH).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Drift guards                                                              */
/* -------------------------------------------------------------------------- */

/**
 * True only when `A` and `B` are the same type.
 * Used for the unions, where a single identity check is exactly right.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless the argument resolves to `true`. */
type Assert<T extends true> = T;

/**
 * Structural equality for object types: same keys, same optionality, same value types.
 *
 * The identity check above cannot be used for these. `detail?: string` and
 * `detail?: string | undefined` describe the same values but are not the same
 * declaration, and zod always infers the second spelling — so an identity check reports
 * drift on every optional field and would have to be switched off, taking the real
 * guarantee with it. Comparing the three properties that matter keeps the guard useful.
 */
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

/** Strips `readonly` so inferred zod shapes can be compared against the public types. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };
