import { SeraError } from '../errors.js';

/**
 * Why an extraction attempt failed, in the terms a router needs.
 *
 * An error code answers "what do we tell the visitor". This answers a different
 * question: "is another backend worth trying, and which one". Treating every non-zero
 * exit the same is how a service ends up retrying a deleted video on three networks and
 * telling the visitor nothing useful about any of them.
 */
export type FailureClass =
  /** The network this attempt came from is refused; the media itself is fine. */
  | 'DATACENTER_BLOCKED'
  /** An anti-automation challenge. Also network-shaped, and also worth another egress. */
  | 'BOT_DETECTION'
  /** The source wants an account this installation does not have. */
  | 'AUTH_REQUIRED'
  /** Private, restricted, or otherwise not ours to see — identical from every network. */
  | 'PRIVATE_CONTENT'
  | 'MEDIA_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TEMPORARY_FAILURE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'EXTRACTOR_FAILURE'
  | 'NETWORK_FAILURE';

const BY_CODE: Partial<Record<string, FailureClass>> = {
  SOURCE_BLOCKED: 'DATACENTER_BLOCKED',
  LOGIN_REQUIRED: 'AUTH_REQUIRED',
  PROVIDER_AUTH_REQUIRED: 'AUTH_REQUIRED',
  PRIVATE_CONTENT: 'PRIVATE_CONTENT',
  AGE_RESTRICTED: 'PRIVATE_CONTENT',
  DRM_PROTECTED: 'PRIVATE_CONTENT',
  GEO_RESTRICTED: 'PRIVATE_CONTENT',
  MEDIA_UNAVAILABLE: 'MEDIA_NOT_FOUND',
  NOT_FOUND: 'MEDIA_NOT_FOUND',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_TEMPORARY_FAILURE',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_MEDIA_TYPE',
  ROBOTS_DISALLOWED: 'UNSUPPORTED_MEDIA_TYPE',
  INVALID_URL: 'UNSUPPORTED_MEDIA_TYPE',
  BLOCKED_ADDRESS: 'UNSUPPORTED_MEDIA_TYPE',
  NETWORK_ERROR: 'NETWORK_FAILURE',
  TIMEOUT: 'NETWORK_FAILURE',
  CONVERSION_FAILED: 'EXTRACTOR_FAILURE',
  PROVIDER_CONFIGURATION_ERROR: 'EXTRACTOR_FAILURE',
  INTERNAL: 'EXTRACTOR_FAILURE',
};

/** Wording that says the network is the problem, whatever code it arrived under. */
const BOT_PHRASES = [
  'not a bot',
  'unusual traffic',
  'suspicious activity',
  'confirm your identity',
];

export function classifyFailure(error: unknown): FailureClass {
  const seraError = SeraError.from(error);
  const haystack = `${seraError.message} ${seraError.detail ?? ''}`.toLowerCase();
  if (BOT_PHRASES.some((phrase) => haystack.includes(phrase))) return 'BOT_DETECTION';
  return BY_CODE[seraError.code] ?? 'EXTRACTOR_FAILURE';
}

/**
 * Whether a different network could plausibly succeed where this one did not.
 *
 * Only the two network-shaped classes qualify. A deleted video is deleted from every
 * address, and retrying it elsewhere wastes a scarce backend and the visitor's time.
 */
export function isEgressProblem(failure: FailureClass): boolean {
  return failure === 'DATACENTER_BLOCKED' || failure === 'BOT_DETECTION';
}
