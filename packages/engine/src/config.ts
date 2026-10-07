import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { SERA_VERSION } from '@sera/contracts/types';
import { z } from 'zod';

const bytes = z.coerce.number().int().positive();
const seconds = z.coerce.number().int().positive();
const secondsOrZero = z.coerce.number().int().nonnegative();

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  SERA_HOST: z.string().default('0.0.0.0'),
  SERA_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  SERA_CORS_ORIGINS: csv,

  SERA_SECRET: z.string().default(''),

  SERA_DATA_DIR: z.string().default(''),
  SERA_RETENTION_SECONDS: seconds.default(1800),
  SERA_REAP_INTERVAL_SECONDS: seconds.default(120),
  SERA_OPTION_TTL_SECONDS: seconds.default(3600),

  SERA_MAX_FILESIZE_BYTES: bytes.default(4 * 1024 * 1024 * 1024),
  SERA_MAX_DURATION_SECONDS: seconds.default(4 * 60 * 60),
  SERA_MAX_ITEMS_PER_JOB: z.coerce.number().int().min(1).max(200).default(50),
  SERA_JOB_TIMEOUT_SECONDS: seconds.default(30 * 60),
  SERA_RESOLVE_TIMEOUT_SECONDS: seconds.default(45),

  SERA_RESOLVE_TIMEOUT_YOUTUBE_SECONDS: secondsOrZero.default(60),
  SERA_RESOLVE_TIMEOUT_INSTAGRAM_SECONDS: secondsOrZero.default(30),
  SERA_RESOLVE_TIMEOUT_TWITTER_SECONDS: secondsOrZero.default(25),
  SERA_RESOLVE_TIMEOUT_REDDIT_SECONDS: secondsOrZero.default(25),

  SERA_REDDIT_CLIENT_ID: z.string().default(''),
  SERA_REDDIT_CLIENT_SECRET: z.string().default(''),

  SERA_YOUTUBE_PLAYER_CLIENTS: z.string().default(''),
  SERA_YOUTUBE_POT_PROVIDER_URL: z.string().default(''),

  SERA_INSTAGRAM_SESSION_ID: z.string().default(''),

  SERA_EXTRACTION_NODE_TOKEN: z.string().default(''),
  SERA_CANARY_TOKEN: z.string().default(''),
  SERA_ADMIN_TOKEN: z.string().default(''),
  SERA_EXTRACTION_CLAIM_HOLD_SECONDS: seconds.default(25),
  SERA_NETWORK_CLASS: z.enum(['datacenter', 'residential', 'unknown']).default('unknown'),
  SERA_API_URL: z.string().default(''),

  SERA_EXTRACTION_PROXY_URL: z.string().default(''),
  SERA_EXTRACTION_PROXY_PROVIDERS: z.string().default(''),

  SERA_QUEUE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  SERA_REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  SERA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  SERA_MAX_QUEUE_DEPTH: z.coerce.number().int().min(1).default(200),
  SERA_EMBEDDED_WORKER: booleanish.default(true),

  SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  SERA_RATE_LIMIT_JOBS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: z.coerce.number().int().min(1).default(3),
  SERA_TRUST_PROXY: booleanish.default(false),

  SERA_YTDLP_PATH: z.string().default(''),
  SERA_FFMPEG_PATH: z.string().default(''),
  SERA_FFPROBE_PATH: z.string().default(''),

  SERA_EXTRA_ALLOWED_HOSTS: csv,
  SERA_BLOCKED_HOSTS: csv,
  SERA_ALLOW_PRIVATE_ADDRESSES: booleanish.default(false),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface EngineConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly logLevel: RawEnv['LOG_LEVEL'];
  readonly version: string;

  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];

  readonly secret: Buffer;

  readonly dataDir: string;
  readonly retentionSeconds: number;
  readonly reapIntervalSeconds: number;
  readonly optionTtlSeconds: number;

  readonly maxFilesizeBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxItemsPerJob: number;
  readonly jobTimeoutSeconds: number;
  readonly resolveTimeoutSeconds: number;

  readonly resolveTimeoutMsFor: (providerId: string) => number;

  readonly reddit: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly configured: boolean;
  };

  readonly canaryToken: string;

  readonly adminToken: string;

  readonly extractionNodes: {
    readonly token: string;
    readonly enabled: boolean;
    readonly claimHoldMs: number;
  };

  readonly networkClass: 'datacenter' | 'residential' | 'unknown';

  proxyFor(providerId: string): string | undefined;

  readonly apiUrl: string;

  readonly instagram: {
    readonly sessionId: string;
    readonly configured: boolean;
  };

  readonly youtube: {
    readonly playerClients: string;
    readonly potProviderUrl: string;
  };

  readonly queueDriver: 'memory' | 'redis';
  readonly redisUrl: string;
  readonly workerConcurrency: number;
  readonly maxQueueDepth: number;
  readonly embeddedWorker: boolean;

  readonly rateLimitResolvePerMinute: number;
  readonly rateLimitJobsPerMinute: number;
  readonly maxConcurrentJobsPerClient: number;
  readonly trustProxy: boolean;

  readonly ytdlpPath: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;

  readonly extraAllowedHosts: readonly string[];
  readonly blockedHosts: readonly string[];
  readonly allowPrivateAddresses: boolean;
}

export const VERSION = SERA_VERSION;

function bundledToolPath(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.tools', exe);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function locateTool(name: string, override: string): string {
  if (override) return override;
  return bundledToolPath(name) ?? onPath(name) ?? name;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (isProduction && !e.SERA_SECRET) {
    throw new ConfigError(
      'SERA_SECRET must be set in production. Generate one with:\n' +
        "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (isProduction && e.SERA_ALLOW_PRIVATE_ADDRESSES) {
    throw new ConfigError(
      'SERA_ALLOW_PRIVATE_ADDRESSES cannot be enabled in production: it disables SSRF protection.',
    );
  }

  const secret = e.SERA_SECRET
    ? createHash('sha256').update(e.SERA_SECRET).digest()
    : randomBytes(32);

  const dataDir = e.SERA_DATA_DIR
    ? resolve(e.SERA_DATA_DIR)
    : resolve(process.cwd(), '.data', 'workspaces');

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    version: VERSION,

    host: e.SERA_HOST,
    port: e.SERA_PORT,
    corsOrigins: e.SERA_CORS_ORIGINS,

    secret,

    dataDir,
    retentionSeconds: e.SERA_RETENTION_SECONDS,
    reapIntervalSeconds: e.SERA_REAP_INTERVAL_SECONDS,
    optionTtlSeconds: e.SERA_OPTION_TTL_SECONDS,

    maxFilesizeBytes: e.SERA_MAX_FILESIZE_BYTES,
    maxDurationSeconds: e.SERA_MAX_DURATION_SECONDS,
    maxItemsPerJob: e.SERA_MAX_ITEMS_PER_JOB,
    jobTimeoutSeconds: e.SERA_JOB_TIMEOUT_SECONDS,
    resolveTimeoutSeconds: e.SERA_RESOLVE_TIMEOUT_SECONDS,

    resolveTimeoutMsFor: (providerId: string) => {
      const perProvider: Record<string, number> = {
        youtube: e.SERA_RESOLVE_TIMEOUT_YOUTUBE_SECONDS,
        instagram: e.SERA_RESOLVE_TIMEOUT_INSTAGRAM_SECONDS,
        twitter: e.SERA_RESOLVE_TIMEOUT_TWITTER_SECONDS,
        reddit: e.SERA_RESOLVE_TIMEOUT_REDDIT_SECONDS,
      };
      const seconds = perProvider[providerId] ?? 0;
      return (seconds > 0 ? seconds : e.SERA_RESOLVE_TIMEOUT_SECONDS) * 1000;
    },

    reddit: {
      clientId: e.SERA_REDDIT_CLIENT_ID,
      clientSecret: e.SERA_REDDIT_CLIENT_SECRET,
      configured: Boolean(e.SERA_REDDIT_CLIENT_ID && e.SERA_REDDIT_CLIENT_SECRET),
    },

    canaryToken: e.SERA_CANARY_TOKEN,
    adminToken: e.SERA_ADMIN_TOKEN,

    extractionNodes: {
      token: e.SERA_EXTRACTION_NODE_TOKEN,
      enabled: e.SERA_EXTRACTION_NODE_TOKEN.length > 0,
      claimHoldMs: e.SERA_EXTRACTION_CLAIM_HOLD_SECONDS * 1000,
    },

    networkClass: e.SERA_NETWORK_CLASS,

    proxyFor(providerId: string): string | undefined {
      const proxy = e.SERA_EXTRACTION_PROXY_URL.trim();
      if (!proxy) return undefined;
      const only = e.SERA_EXTRACTION_PROXY_PROVIDERS.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      return only.length === 0 || only.includes(providerId) ? proxy : undefined;
    },
    apiUrl: e.SERA_API_URL.replace(/\/+$/, ''),

    instagram: {
      sessionId: e.SERA_INSTAGRAM_SESSION_ID,
      configured: e.SERA_INSTAGRAM_SESSION_ID.length > 0,
    },

    youtube: {
      playerClients: e.SERA_YOUTUBE_PLAYER_CLIENTS.trim(),
      potProviderUrl: e.SERA_YOUTUBE_POT_PROVIDER_URL.replace(/\/+$/, ''),
    },

    queueDriver: e.SERA_QUEUE_DRIVER,
    redisUrl: e.SERA_REDIS_URL,
    workerConcurrency: e.SERA_WORKER_CONCURRENCY,
    maxQueueDepth: e.SERA_MAX_QUEUE_DEPTH,
    embeddedWorker: e.SERA_QUEUE_DRIVER === 'memory' ? true : e.SERA_EMBEDDED_WORKER,

    rateLimitResolvePerMinute: e.SERA_RATE_LIMIT_RESOLVE_PER_MINUTE,
    rateLimitJobsPerMinute: e.SERA_RATE_LIMIT_JOBS_PER_MINUTE,
    maxConcurrentJobsPerClient: e.SERA_MAX_CONCURRENT_JOBS_PER_CLIENT,
    trustProxy: e.SERA_TRUST_PROXY,

    ytdlpPath: locateTool('yt-dlp', e.SERA_YTDLP_PATH),
    ffmpegPath: locateTool('ffmpeg', e.SERA_FFMPEG_PATH),
    ffprobePath: locateTool('ffprobe', e.SERA_FFPROBE_PATH),

    extraAllowedHosts: e.SERA_EXTRA_ALLOWED_HOSTS,
    blockedHosts: e.SERA_BLOCKED_HOSTS,
    allowPrivateAddresses: e.SERA_ALLOW_PRIVATE_ADDRESSES,
  };
}
