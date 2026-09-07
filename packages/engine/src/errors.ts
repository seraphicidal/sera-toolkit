import type { ErrorCode, JobError } from '@sera/contracts/types';

/**
 * The single error type that crosses module boundaries inside the engine.
 *
 * Every failure the user can see is one of these. The `cause` carries the technical
 * detail for the server log; only `code`, `message` and `hint` are ever serialized to a
 * client, which is what keeps stack traces and provider internals off the wire.
 */
export class SeraError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  /** Free-form technical context for structured logs. Never sent to clients. */
  readonly detail?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      hint?: string;
      retryable?: boolean;
      httpStatus?: number;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SeraError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code];
    this.detail = options.detail;
  }

  /** The client-safe projection. */
  toJobError(): JobError {
    const error: { code: ErrorCode; message: string; hint?: string; retryable: boolean } = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.hint !== undefined) error.hint = this.hint;
    return error;
  }

  static from(value: unknown, fallback?: Partial<{ code: ErrorCode; message: string }>): SeraError {
    if (value instanceof SeraError) return value;
    return new SeraError(fallback?.code ?? 'INTERNAL', fallback?.message ?? MESSAGES.INTERNAL, {
      cause: value,
      detail: value instanceof Error ? value.message : String(value),
    });
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorCode>([
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'QUEUE_FULL',
  'INTERNAL',
]);

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  UNSUPPORTED_SOURCE: 422,
  PRIVATE_CONTENT: 403,
  MEDIA_UNAVAILABLE: 404,
  GEO_RESTRICTED: 451,
  AGE_RESTRICTED: 403,
  LOGIN_REQUIRED: 403,
  // Not 403: the refusal is upstream's, about this server, not about the request.
  SOURCE_BLOCKED: 502,
  // 501, not 403: the request is fine and the media may well be public — this
  // installation simply has not been given what the source now asks for.
  PROVIDER_AUTH_REQUIRED: 501,
  PROVIDER_CONFIGURATION_ERROR: 500,
  ROBOTS_DISALLOWED: 403,
  DRM_PROTECTED: 403,
  LIVE_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  NETWORK_ERROR: 502,
  TOO_LARGE: 413,
  TOO_LONG: 413,
  CONVERSION_FAILED: 500,
  TIMEOUT: 504,
  CANCELLED: 409,
  NOT_FOUND: 404,
  EXPIRED: 410,
  BLOCKED_ADDRESS: 400,
  QUEUE_FULL: 503,
  INTERNAL: 500,
};

/**
 * The exact wording users see. Kept in one place so the tone stays consistent and so
 * nothing accidentally leaks a provider name or an internal identifier into a message.
 */
export const MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: "That doesn't look like a valid link.",
  UNSUPPORTED_SOURCE: "This source isn't currently supported.",
  PRIVATE_CONTENT: "This content isn't publicly accessible.",
  MEDIA_UNAVAILABLE: 'This media is no longer available.',
  GEO_RESTRICTED: "This media isn't available from this server's region.",
  AGE_RESTRICTED: 'This media is age-restricted and cannot be accessed without signing in.',
  LOGIN_REQUIRED: 'This media requires an account to view.',
  SOURCE_BLOCKED: 'This source is blocking this server, not the link.',
  PROVIDER_AUTH_REQUIRED: 'This source needs an account, and this server does not have one.',
  PROVIDER_CONFIGURATION_ERROR: 'This source is configured incorrectly on this server.',
  ROBOTS_DISALLOWED: 'This site asks not to be read automatically.',
  DRM_PROTECTED: 'This media is protected and cannot be downloaded.',
  LIVE_IN_PROGRESS: 'This stream is still live. Try again once it has finished.',
  RATE_LIMITED: 'The source is temporarily limiting requests. Try again later.',
  PROVIDER_UNAVAILABLE: 'Support for this source is temporarily unavailable.',
  NETWORK_ERROR: "We couldn't retrieve this media.",
  TOO_LARGE: 'This media is larger than this server allows.',
  TOO_LONG: 'This media is longer than this server allows.',
  CONVERSION_FAILED: 'The media was downloaded, but conversion failed.',
  TIMEOUT: 'This took too long and was stopped.',
  CANCELLED: 'This download was cancelled.',
  NOT_FOUND: "We couldn't find that.",
  EXPIRED: 'This link has expired. Analyze the URL again.',
  BLOCKED_ADDRESS: 'That address cannot be reached from this server.',
  QUEUE_FULL: 'The server is busy right now. Try again in a moment.',
  INTERNAL: 'Something went wrong on our side.',
};

/** Suggested next steps, surfaced under the message in the UI. */
export const HINTS: Partial<Record<ErrorCode, string>> = {
  UNSUPPORTED_SOURCE: 'Try a direct link to the media file itself.',
  PRIVATE_CONTENT: 'Only public posts can be processed.',
  RATE_LIMITED: 'Waiting a minute usually clears it.',
  CONVERSION_FAILED: 'Try a different format.',
  TOO_LARGE: 'Try a lower quality.',
  LIVE_IN_PROGRESS: 'Live streams can only be processed after they end.',
  EXPIRED: 'Paste the link again to refresh the available formats.',
  SOURCE_BLOCKED:
    'Sites often challenge requests coming from datacentres. The same link usually works from a home connection.',
  PROVIDER_AUTH_REQUIRED:
    'Nothing is wrong with the link. The operator of this server can enable it by adding credentials for that source.',
  ROBOTS_DISALLOWED: 'Try a direct link to the media file itself.',
};

/** Constructs a `SeraError` with the canonical message and hint for its code. */
export function seraError(
  code: ErrorCode,
  options: { message?: string; hint?: string; detail?: string; cause?: unknown } = {},
): SeraError {
  const opts: ConstructorParameters<typeof SeraError>[2] = {};
  const hint = options.hint ?? HINTS[code];
  if (hint !== undefined) opts.hint = hint;
  if (options.detail !== undefined) opts.detail = options.detail;
  if (options.cause !== undefined) opts.cause = options.cause;
  return new SeraError(code, options.message ?? MESSAGES[code], opts);
}
