import { SeraError } from '../errors.js';

/**
 * Why an extraction attempt failed, in the terms a router needs.
 *
 * An error code answers "what do we tell the visitor". This answers a different
 * question: "is another attempt worth making, where, and on what". Treating every
 * non-zero exit the same is how a service ends up retrying a deleted video on three
 * networks and telling the visitor nothing useful about any of them.
 *
 * The distinctions that carry weight are the ones that change the next step:
 *
 * - `DATACENTER_BLOCKED` and `BOT_DETECTION` are about the address that asked. Another
 *   network can fix them; nothing else can.
 * - `STREAM_403` is about a media URL, not a page. Several platforms sign a URL to the
 *   address that requested it, so this one is fixed by downloading *where the resolve
 *   happened* — not by a different network, and not by asking again.
 * - `LOGIN_REQUIRED` is the media wanting an account. `AUTH_CONFIGURATION_ERROR` is this
 *   server having credentials that do not work. They read alike and need opposite
 *   responses: one is the visitor's answer, the other is the operator's bug.
 * - `PRIVATE_CONTENT`, `DELETED_CONTENT` and `GEO_BLOCKED` are the same from everywhere,
 *   so they never justify spending a scarce backend.
 */
export type FailureClass =
  | 'DATACENTER_BLOCKED'
  | 'BOT_DETECTION'
  | 'STREAM_403'
  | 'RATE_LIMITED'
  | 'LOGIN_REQUIRED'
  | 'AUTH_CONFIGURATION_ERROR'
  | 'PRIVATE_CONTENT'
  | 'DELETED_CONTENT'
  | 'GEO_BLOCKED'
  | 'UNSUPPORTED_URL'
  | 'UNSUPPORTED_MEDIA'
  | 'EXTRACTOR_BUG'
  | 'SOURCE_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'OUTPUT_ERROR';

const BY_CODE: Partial<Record<string, FailureClass>> = {
  SOURCE_BLOCKED: 'DATACENTER_BLOCKED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  PROVIDER_AUTH_REQUIRED: 'LOGIN_REQUIRED',
  PROVIDER_CONFIGURATION_ERROR: 'AUTH_CONFIGURATION_ERROR',
  PRIVATE_CONTENT: 'PRIVATE_CONTENT',
  AGE_RESTRICTED: 'PRIVATE_CONTENT',
  DRM_PROTECTED: 'PRIVATE_CONTENT',
  GEO_RESTRICTED: 'GEO_BLOCKED',
  MEDIA_UNAVAILABLE: 'DELETED_CONTENT',
  NOT_FOUND: 'DELETED_CONTENT',
  EXPIRED: 'DELETED_CONTENT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'EXTRACTOR_BUG',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_MEDIA',
  ROBOTS_DISALLOWED: 'UNSUPPORTED_MEDIA',
  INVALID_URL: 'UNSUPPORTED_URL',
  BLOCKED_ADDRESS: 'UNSUPPORTED_URL',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'UPSTREAM_TIMEOUT',
  CONVERSION_FAILED: 'OUTPUT_ERROR',
  TOO_LARGE: 'OUTPUT_ERROR',
  TOO_LONG: 'OUTPUT_ERROR',
  INTERNAL: 'EXTRACTOR_BUG',
};

/**
 * Wording that outranks the code it arrived under.
 *
 * Extractors report a bot challenge as a login problem, and a signed-URL refusal as a
 * generic network error. Both are worth catching by their text, because the code is the
 * one thing that does not distinguish them.
 */
const BY_PHRASE: readonly (readonly [FailureClass, readonly string[]])[] = [
  [
    'BOT_DETECTION',
    ['not a bot', 'unusual traffic', 'suspicious activity', 'confirm your identity'],
  ],
  [
    'STREAM_403',
    [
      'http error 403',
      'unable to download video data: http error 403',
      'fragment 1 not found',
      'giving up after 10 fragment retries',
    ],
  ],
  ['DELETED_CONTENT', ['has been removed', 'no longer available', 'video unavailable']],
  ['GEO_BLOCKED', ['not available in your country', 'blocked it in your country']],
  ['SOURCE_ERROR', ['http error 5', 'internal server error', 'service unavailable']],
];

export function classifyFailure(error: unknown): FailureClass {
  const seraError = SeraError.from(error);
  const haystack = `${seraError.message} ${seraError.detail ?? ''}`.toLowerCase();

  for (const [failure, phrases] of BY_PHRASE) {
    if (phrases.some((phrase) => haystack.includes(phrase))) return failure;
  }
  return BY_CODE[seraError.code] ?? 'EXTRACTOR_BUG';
}

/**
 * Whether a different network could plausibly succeed where this one did not.
 *
 * Only the two address-shaped classes qualify. A deleted video is deleted from every
 * connection, and retrying it elsewhere spends someone's bandwidth to reach the same
 * answer more slowly.
 */
export function isEgressProblem(failure: FailureClass): boolean {
  return failure === 'DATACENTER_BLOCKED' || failure === 'BOT_DETECTION';
}

/**
 * Whether the work has to happen wherever the resolution happened.
 *
 * A media URL bound to the address that requested it cannot be handed to another
 * machine — measured on YouTube: the same signed URL answers 206 at home and 403 from a
 * server minutes later. This is the signal that a split resolve-here/download-there
 * attempt has been made and must not be retried the same way.
 */
export function requiresOriginatingNode(failure: FailureClass): boolean {
  return failure === 'STREAM_403';
}

/** Whether asking again, unchanged, could reasonably produce a different answer. */
export function isTransient(failure: FailureClass): boolean {
  return failure === 'RATE_LIMITED' || failure === 'SOURCE_ERROR' || failure === 'UPSTREAM_TIMEOUT';
}
