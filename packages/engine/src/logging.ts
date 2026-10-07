import { pino } from 'pino';

export type Logger = ReturnType<typeof pino>;

export interface LoggerOptions {
  readonly level: string;
  readonly pretty?: boolean;
  readonly name?: string;
}

export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-forwarded-for"]',
  'req.remoteAddress',
  'req.remotePort',
  'res.headers["set-cookie"]',
  'url',
  'sourceUrl',
  'mediaUrl',
  '*.mediaUrl',
  'token',
  '*.token',
  'cookie',
  '*.cookie',
  'sessionId',
  '*.sessionId',
  'clientSecret',
  '*.clientSecret',
  'accessToken',
  '*.accessToken',
  'proxy',
  '*.proxy',
  'authorization',
  '*.authorization',
  'imported',
  '*.imported',
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

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export function logSafeUrl(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const firstSegment = parsed.pathname.split('/').find(Boolean) ?? '';
    return `${parsed.hostname}${firstSegment ? `/${firstSegment}` : ''}`;
  } catch {
    return '(unparseable)';
  }
}
