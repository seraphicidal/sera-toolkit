import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { SERA_VERSION } from '@sera/contracts/types';
import { z } from 'zod';

const bytes = z.coerce.number().int().positive();
const seconds = z.coerce.number().int().positive();

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
  /** Public origin of the API, used to build absolute download URLs in logs and docs. */
  SERA_PUBLIC_URL: z.string().default(''),
  /** Comma-separated list of allowed browser origins. Empty means same-origin only. */
  SERA_CORS_ORIGINS: csv,

  /**
   * HMAC key for signing option ids. Required in production: without a stable secret,
   * ids minted before a restart stop validating, and a random per-boot key silently
   * breaks a multi-instance deployment.
   */
  SERA_SECRET: z.string().default(''),

  SERA_DATA_DIR: z.string().default(''),
  /** How long finished files stay on disk before the reaper deletes them. */
  SERA_RETENTION_SECONDS: seconds.default(1800),
  /** How often the reaper sweeps. */
  SERA_REAP_INTERVAL_SECONDS: seconds.default(120),
  /** Validity window for a resolution and the option ids it minted. */
  SERA_OPTION_TTL_SECONDS: seconds.default(3600),

  SERA_MAX_FILESIZE_BYTES: bytes.default(4 * 1024 * 1024 * 1024),
  SERA_MAX_DURATION_SECONDS: seconds.default(4 * 60 * 60),
  SERA_MAX_ITEMS_PER_JOB: z.coerce.number().int().min(1).max(200).default(50),
  /** Wall-clock ceiling for a single job, including download and conversion. */
  SERA_JOB_TIMEOUT_SECONDS: seconds.default(30 * 60),
  /** Ceiling for a metadata probe. Kept short: the user is waiting on it. */
  SERA_RESOLVE_TIMEOUT_SECONDS: seconds.default(45),

  /**
   * Per-provider ceilings for the metadata probe, in seconds.
   *
   * One number for every source is wrong in both directions: an OAuth round trip to
   * Reddit should not be given the same 45 seconds as a YouTube player negotiation, and
   * a slow provider must not be able to hold the single worker this instance has. A
   * value of 0 means "use SERA_RESOLVE_TIMEOUT_SECONDS".
   */
  SERA_RESOLVE_TIMEOUT_YOUTUBE_SECONDS: seconds.default(60),
  SERA_RESOLVE_TIMEOUT_INSTAGRAM_SECONDS: seconds.default(30),
  SERA_RESOLVE_TIMEOUT_TWITTER_SECONDS: seconds.default(25),
  SERA_RESOLVE_TIMEOUT_REDDIT_SECONDS: seconds.default(25),

  /**
   * Reddit's Data API. Anonymous access is refused outright from hosted ranges, so
   * without these Reddit is honestly reported as needing credentials rather than
   * failing with something vague. Register an app at
   * https://www.reddit.com/prefs/apps as type "script" and use its id and secret.
   */
  SERA_REDDIT_CLIENT_ID: z.string().default(''),
  SERA_REDDIT_CLIENT_SECRET: z.string().default(''),

  /**
   * A yt-dlp PO Token Provider, as described in yt-dlp's PO-Token-Guide. Empty disables
   * it. Measured on this deployment, it does not lift YouTube's datacentre challenge —
   * see the YouTube backend notes — but it is the supported architecture and is what a
   * host with a clean address needs for the web clients.
   */
  SERA_YOUTUBE_POT_PROVIDER_URL: z.string().default(''),

  /**
   * An authorized residential extraction backend for YouTube, reached over HTTPS with a
   * shared secret. Empty means there is no fallback and a blocked datacentre simply
   * reports that it is blocked, which is the honest default for a public deployment.
   */
  /**
   * Shared secret an extraction node presents to claim work. Empty disables the whole
   * remote-extraction surface, which is the default: a deployment with no node should
   * not have an endpoint that accepts one.
   */
  SERA_EXTRACTION_NODE_TOKEN: z.string().default(''),
  /** How long a node's request for work is held open before it asks again. */
  SERA_EXTRACTION_CLAIM_HOLD_SECONDS: seconds.default(25),

  SERA_YOUTUBE_FALLBACK_URL: z.string().default(''),
  SERA_YOUTUBE_FALLBACK_TOKEN: z.string().default(''),

  SERA_QUEUE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  SERA_REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  SERA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  /** Rejects new jobs once this many are waiting, instead of queueing without bound. */
  SERA_MAX_QUEUE_DEPTH: z.coerce.number().int().min(1).default(200),
  /** When true the API also runs a worker in-process. Ignored for the redis driver. */
  SERA_EMBEDDED_WORKER: booleanish.default(true),

  SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  SERA_RATE_LIMIT_JOBS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: z.coerce.number().int().min(1).default(3),
  /** Trust `X-Forwarded-For`. Only enable behind a proxy you control. */
  SERA_TRUST_PROXY: booleanish.default(false),

  SERA_YTDLP_PATH: z.string().default(''),
  SERA_FFMPEG_PATH: z.string().default(''),
  SERA_FFPROBE_PATH: z.string().default(''),

  /**
   * Additional hostnames the generic extractor may be pointed at, beyond the ones a
   * dedicated provider claims. Empty by default: a link is never handed to the extractor
   * merely because the extractor might recognize it.
   */
  SERA_EXTRA_ALLOWED_HOSTS: csv,
  /** Hostnames that are always refused, checked before anything else. */
  SERA_BLOCKED_HOSTS: csv,
  /**
   * Allows connections to private and loopback addresses. Only for local development
   * against a test server; leaving this on in production is an SSRF hole.
   */
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
  readonly publicUrl: string;
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

  /** Provider id → probe ceiling in milliseconds. Falls back to the shared value. */
  readonly resolveTimeoutMsFor: (providerId: string) => number;

  readonly reddit: {
    readonly clientId: string;
    readonly clientSecret: string;
    /** True when this installation can talk to Reddit's Data API at all. */
    readonly configured: boolean;
  };

  readonly extractionNodes: {
    readonly token: string;
    readonly enabled: boolean;
    readonly claimHoldMs: number;
  };

  readonly youtube: {
    readonly potProviderUrl: string;
    readonly fallbackUrl: string;
    readonly fallbackToken: string;
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

/** Re-exported so the engine and the browser bundle can never disagree about it. */
export const VERSION = SERA_VERSION;

/** Where a bundled tool would live if `npm run tools:fetch` has been run. */
function bundledToolPath(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  // Walk up from this file looking for a `.tools` directory, so the lookup works from
  // both `packages/engine/src` (dev) and `packages/engine/dist` (built).
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

/** First match for `name` on PATH, or undefined. */
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

/** Bundled tools win over PATH so a pinned version is used when one is present. */
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

  // A per-boot key is fine outside production; ids simply stop validating on restart.
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
    publicUrl: e.SERA_PUBLIC_URL.replace(/\/+$/, ''),
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

    extractionNodes: {
      token: e.SERA_EXTRACTION_NODE_TOKEN,
      enabled: e.SERA_EXTRACTION_NODE_TOKEN.length > 0,
      claimHoldMs: e.SERA_EXTRACTION_CLAIM_HOLD_SECONDS * 1000,
    },

    youtube: {
      potProviderUrl: e.SERA_YOUTUBE_POT_PROVIDER_URL.replace(/\/+$/, ''),
      fallbackUrl: e.SERA_YOUTUBE_FALLBACK_URL.replace(/\/+$/, ''),
      fallbackToken: e.SERA_YOUTUBE_FALLBACK_TOKEN,
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
