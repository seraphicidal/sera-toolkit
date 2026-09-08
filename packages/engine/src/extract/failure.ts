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
  /* ---- the address that asked ---- */
  | 'DATACENTER_BLOCKED'
  | 'BOT_DETECTION'
  /* ---- a media URL, not a page ---- */
  | 'STREAM_403'
  | 'CDN_DOWNLOAD_FAILURE'
  /* ---- the extractor's own footing ---- */
  | 'PO_TOKEN_REQUIRED'
  | 'FORMAT_UNAVAILABLE'
  /* ---- credentials ---- */
  | 'LOGIN_REQUIRED'
  | 'AGE_RESTRICTED'
  | 'AUTH_CONFIGURATION_ERROR'
  /* ---- the same from everywhere ---- */
  | 'PRIVATE_CONTENT'
  | 'DELETED_CONTENT'
  | 'GEO_BLOCKED'
  | 'UNSUPPORTED_URL'
  | 'UNSUPPORTED_MEDIA'
  /* ---- worth another try, unchanged ---- */
  | 'RATE_LIMITED'
  | 'SOURCE_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_ERROR'
  /* ---- ours ---- */
  | 'EXTRACTOR_BUG'
  | 'OUTPUT_ERROR'
  | 'CANCELLED';

/**
 * Every error code SERA can raise, and what it means for routing.
 *
 * Exported so the test can check it against the code list in the contract: a code added
 * there and forgotten here would otherwise classify as an extractor bug, which is how a
 * Twitch channel URL — correctly refused because the stream is still running — came to
 * be logged as a bug in SERA.
 */
export const FAILURE_BY_CODE: Partial<Record<string, FailureClass>> = {
  SOURCE_BLOCKED: 'DATACENTER_BLOCKED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  PROVIDER_AUTH_REQUIRED: 'LOGIN_REQUIRED',
  PROVIDER_CONFIGURATION_ERROR: 'AUTH_CONFIGURATION_ERROR',
  PRIVATE_CONTENT: 'PRIVATE_CONTENT',
  AGE_RESTRICTED: 'AGE_RESTRICTED',
  DRM_PROTECTED: 'PRIVATE_CONTENT',
  GEO_RESTRICTED: 'GEO_BLOCKED',
  MEDIA_UNAVAILABLE: 'DELETED_CONTENT',
  NOT_FOUND: 'DELETED_CONTENT',
  EXPIRED: 'DELETED_CONTENT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'EXTRACTOR_BUG',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_MEDIA',
  ROBOTS_DISALLOWED: 'UNSUPPORTED_MEDIA',
  // A stream still running is not a file yet, and no address changes that.
  LIVE_IN_PROGRESS: 'UNSUPPORTED_MEDIA',
  INVALID_URL: 'UNSUPPORTED_URL',
  BLOCKED_ADDRESS: 'UNSUPPORTED_URL',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'UPSTREAM_TIMEOUT',
  CONVERSION_FAILED: 'OUTPUT_ERROR',
  TOO_LARGE: 'OUTPUT_ERROR',
  TOO_LONG: 'OUTPUT_ERROR',
  // This server is full, not the source refusing us. It shares one property with a
  // rate limit and it is the one that matters here: waiting is the answer.
  QUEUE_FULL: 'RATE_LIMITED',
  // The visitor left. Not a failure of extraction, and a class of its own so that it
  // cannot be read as one in the logs.
  CANCELLED: 'CANCELLED',
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
  // Ordered: the first match wins, so the specific readings come before the general
  // ones they would otherwise be swallowed by.
  [
    'BOT_DETECTION',
    ['not a bot', 'unusual traffic', 'suspicious activity', 'confirm your identity'],
  ],
  [
    // The extractor asking for a token it could not get. Distinct from a bot challenge
    // because the answer is a provider, not a different address — and distinct from a
    // login wall because no account is involved.
    'PO_TOKEN_REQUIRED',
    ['po token', 'po_token', 'potoken', 'missing a gvs po token', 'requires a po token'],
  ],
  [
    // The list this client can see does not contain what was asked for. Another client
    // sees a different list, and a lower quality is on the same one.
    'FORMAT_UNAVAILABLE',
    ['requested format is not available', 'no video formats found', 'no formats found'],
  ],
  [
    // A media URL refused to the address that asked, which is not the same as a page
    // being refused: it is fixed by downloading where the resolve happened.
    'STREAM_403',
    ['http error 403', 'unable to download video data: http error 403'],
  ],
  [
    // The CDN answered, badly. Retrying the same URL from the same place is what does
    // not work; the whole job somewhere else does.
    'CDN_DOWNLOAD_FAILURE',
    [
      'fragment 1 not found',
      'giving up after 10 fragment retries',
      'unable to download fragment',
      'the download is incomplete',
    ],
  ],
  ['AGE_RESTRICTED', ['age-restricted', 'confirm your age', 'sign in to confirm your age']],
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
  return FAILURE_BY_CODE[seraError.code] ?? 'EXTRACTOR_BUG';
}

/**
 * Whether a different network could plausibly succeed where this one did not.
 *
 * Only the two address-shaped classes qualify. A deleted video is deleted from every
 * connection, and retrying it elsewhere spends someone's bandwidth to reach the same
 * answer more slowly.
 */
export function isEgressProblem(failure: FailureClass): boolean {
  return (
    failure === 'DATACENTER_BLOCKED' ||
    failure === 'BOT_DETECTION' ||
    // A token the extractor could not obtain here. A residential address usually can,
    // which makes this an address problem wearing different words.
    failure === 'PO_TOKEN_REQUIRED' ||
    // The page resolved and the CDN then refused or truncated the bytes. Nothing on
    // this network fixes that; the whole job somewhere else does.
    failure === 'CDN_DOWNLOAD_FAILURE'
  );
}

/**
 * Whether this is the end of the road, whatever else exists.
 *
 * The point of a strategy ladder is to keep going after a failure that another approach
 * could plausibly answer. These are the failures no approach answers: the content is
 * private, gone, geo-fenced, not media, or the visitor has left. Retrying them through
 * five more backends spends time and somebody's bandwidth to arrive at the same
 * sentence — and, worse, replaces a precise answer with a vague one.
 */
export function isDefinitive(failure: FailureClass): boolean {
  return (
    failure === 'PRIVATE_CONTENT' ||
    failure === 'AGE_RESTRICTED' ||
    failure === 'DELETED_CONTENT' ||
    failure === 'GEO_BLOCKED' ||
    failure === 'UNSUPPORTED_URL' ||
    failure === 'CANCELLED'
  );
}

/**
 * Whether another way of asking the same source could still work.
 *
 * The inverse of `isDefinitive`, and the question a strategy ladder actually asks.
 * `UNSUPPORTED_MEDIA` is deliberately on this side of the line: it usually means "this
 * extractor only understands video and the post is photographs", which is precisely the
 * case another strategy exists for.
 */
export function worthAnotherStrategy(failure: FailureClass): boolean {
  return !isDefinitive(failure);
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
