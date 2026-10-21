import { SeraError } from '../errors.js';

export type FailureClass =
  | 'DATACENTER_BLOCKED'
  | 'BOT_DETECTION'
  | 'STREAM_403'
  | 'CDN_DOWNLOAD_FAILURE'
  | 'PO_TOKEN_REQUIRED'
  | 'FORMAT_UNAVAILABLE'
  | 'LOGIN_REQUIRED'
  | 'AGE_RESTRICTED'
  | 'AUTH_CONFIGURATION_ERROR'
  | 'PRIVATE_CONTENT'
  | 'DELETED_CONTENT'
  | 'GEO_BLOCKED'
  | 'UNSUPPORTED_URL'
  | 'UNSUPPORTED_MEDIA'
  | 'RATE_LIMITED'
  | 'SOURCE_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'EXTRACTOR_BUG'
  | 'OUTPUT_ERROR'
  | 'CANCELLED';

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
  LIVE_IN_PROGRESS: 'UNSUPPORTED_MEDIA',
  INVALID_URL: 'UNSUPPORTED_URL',
  BLOCKED_ADDRESS: 'UNSUPPORTED_URL',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'UPSTREAM_TIMEOUT',
  CONVERSION_FAILED: 'OUTPUT_ERROR',
  TOO_LARGE: 'OUTPUT_ERROR',
  TOO_LONG: 'OUTPUT_ERROR',
  QUEUE_FULL: 'RATE_LIMITED',
  CANCELLED: 'CANCELLED',
  INTERNAL: 'EXTRACTOR_BUG',
};

const BY_PHRASE: readonly (readonly [FailureClass, readonly string[]])[] = [
  [
    'BOT_DETECTION',
    ['not a bot', 'unusual traffic', 'suspicious activity', 'confirm your identity'],
  ],
  [
    'PO_TOKEN_REQUIRED',
    ['po token', 'po_token', 'potoken', 'missing a gvs po token', 'requires a po token'],
  ],
  [
    'FORMAT_UNAVAILABLE',
    ['requested format is not available', 'no video formats found', 'no formats found'],
  ],
  ['STREAM_403', ['http error 403', 'unable to download video data: http error 403']],
  [
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

export function isEgressProblem(failure: FailureClass): boolean {
  return (
    failure === 'DATACENTER_BLOCKED' ||
    failure === 'BOT_DETECTION' ||
    failure === 'PO_TOKEN_REQUIRED' ||
    failure === 'CDN_DOWNLOAD_FAILURE'
  );
}

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
