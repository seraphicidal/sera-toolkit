import { pino } from 'pino';

/**
 * The logger type used across the engine.
 *
 * Derived from `pino`'s return type rather than written out, so the level generics stay
 * in step with whatever the options below actually produce.
 */
export type Logger = ReturnType<typeof pino>;

export interface LoggerOptions {
  readonly level: string;
  /** Pretty-prints in development; production always emits newline-delimited JSON. */
  readonly pretty?: boolean;
  readonly name?: string;
}

/**
 * Builds the service logger.
 *
 * The redaction list is the privacy policy in code: full URLs, client addresses and
 * anything resembling a token never reach the log, because a media downloader's logs
 * would otherwise be a record of what everyone watched.
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-forwarded-for"]',
  'req.remoteAddress',
  'req.remotePort',
  'res.headers["set-cookie"]',
  // A full URL says which video a person asked for. `logSafeUrl` is how one gets logged.
  'url',
  'sourceUrl',
  'mediaUrl',
  '*.mediaUrl',
  'token',
  '*.token',
  // Credentials an operator may configure. Not one of these is ever handed to a logger
  // deliberately; the list exists so that a future object spread — the only way it would
  // ever happen — cannot leak one.
  'cookie',
  '*.cookie',
  'sessionId',
  '*.sessionId',
  'clientSecret',
  '*.clientSecret',
  'accessToken',
  '*.accessToken',
  'authorization',
  '*.authorization',
];

export const REDACTION_CENSOR = '[redacted]';

export function createLogger(options: LoggerOptions): Logger {
  const base = {
    level: options.level,
    ...(options.name ? { name: options.name } : {}),
    redact: {
      paths: [...REDACTED_PATHS],
      censor: REDACTION_CENSOR,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  } satisfies Parameters<typeof pino>[0];

  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(base);
}

/** A logger that discards everything, for tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Reduces a URL to just its origin and a coarse path shape.
 *
 * Job logs need enough to correlate a failure with a site without recording which video
 * a person asked for, so `https://youtube.com/watch?v=abc` logs as `youtube.com/watch`.
 */
export function logSafeUrl(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const firstSegment = parsed.pathname.split('/').find(Boolean) ?? '';
    return `${parsed.hostname}${firstSegment ? `/${firstSegment}` : ''}`;
  } catch {
    return '(unparseable)';
  }
}
