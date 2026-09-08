import { mkdir } from 'node:fs/promises';
import type { HealthCheck, HealthReport, ServiceInfo } from '@sera/contracts/types';
import type { Dispatcher } from 'undici';
import { loadConfig, VERSION, type EngineConfig } from './config.js';
import { ffmpegVersion } from './convert/ffmpeg.js';
import { ExtractionNodeRegistry, remoteBackends, type RemoteExtraction } from './extract/remote.js';
import { RemoteOverHttp } from './extract/remote-http.js';
import { version as ytdlpVersion } from './extract/ytdlp.js';
import { JobService } from './jobs/service.js';
import { createLogger, type Logger } from './logging.js';
import { ProviderRegistry } from './providers/index.js';
import { MemoryJobBackend } from './queue/memory.js';
import type { JobBackend, WorkerHandle } from './queue/types.js';
import { MediaResolver, type ResolverDependencies } from './resolver.js';
import { AbuseGuard } from './security/abuse.js';
import { WorkspaceManager } from './storage/workspace.js';

/**
 * The composition root.
 *
 * Everything the API and the worker processes need is assembled here, so a deployment
 * differs only in which parts it starts: the API serves HTTP, the worker calls
 * `startWorker`, and a single-container install does both.
 */
export interface EngineOptions {
  readonly config?: EngineConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly backend?: JobBackend;
  readonly dispatcher?: Dispatcher;
  /** Overrides the metadata probe, so the whole pipeline is testable without yt-dlp. */
  readonly probe?: ResolverDependencies['probe'];
}

export class SeraEngine {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly registry: ProviderRegistry;
  /** Extraction nodes on other networks. Empty unless one has dialled in. */
  readonly extractionNodes: ExtractionNodeRegistry;
  readonly resolver: MediaResolver;
  readonly workspaces: WorkspaceManager;
  readonly backend: JobBackend;
  readonly jobs: JobService;
  /**
   * Cooldown for clients that keep failing.
   *
   * Held here rather than in the HTTP layer so every entry point shares one view of a
   * misbehaving client.
   */
  readonly abuse = new AbuseGuard();

  private readonly startedAt = Date.now();
  private stopReaper: (() => void) | undefined;
  private worker: WorkerHandle | undefined;

  private constructor(parts: {
    config: EngineConfig;
    logger: Logger;
    registry: ProviderRegistry;
    extractionNodes: ExtractionNodeRegistry;
    resolver: MediaResolver;
    workspaces: WorkspaceManager;
    backend: JobBackend;
    jobs: JobService;
  }) {
    this.config = parts.config;
    this.logger = parts.logger;
    this.registry = parts.registry;
    this.extractionNodes = parts.extractionNodes;
    this.resolver = parts.resolver;
    this.workspaces = parts.workspaces;
    this.backend = parts.backend;
    this.jobs = parts.jobs;
  }

  static async create(options: EngineOptions = {}): Promise<SeraEngine> {
    const config = options.config ?? loadConfig(options.env);
    const logger =
      options.logger ??
      createLogger({
        level: config.logLevel,
        pretty: !config.isProduction,
        name: 'sera',
      });

    await mkdir(config.dataDir, { recursive: true });

    const registry = new ProviderRegistry(undefined, config);
    // Nodes on other networks, if any ever connect. The router asks this at call time,
    // so one that dials in later is usable without restarting the API.
    const extractionNodes = new ExtractionNodeRegistry(logger);

    /**
     * Where this process asks about nodes.
     *
     * The registry itself when this process is the one a node dialled, and the API over
     * HTTP when it is not. A standalone worker is the second case, and getting it wrong
     * is invisible until a download: the link resolves through the node and then fails
     * with the datacentre block, because the process doing the downloading never knew a
     * node was there.
     */
    const remote: RemoteExtraction =
      config.extractionNodes.enabled && !config.embeddedWorker && config.apiUrl
        ? new RemoteOverHttp(config.apiUrl, config.extractionNodes.token, logger)
        : extractionNodes;
    const resolver = new MediaResolver({
      config,
      logger,
      registry,
      remoteBackends: () => (config.extractionNodes.enabled ? remoteBackends(remote) : []),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      ...(options.probe ? { probe: options.probe } : {}),
    });
    const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
    const backend = options.backend ?? (await createBackend(config, logger));
    const jobs = new JobService({
      config,
      logger,
      resolver,
      workspaces,
      backend,
      remote,
    });

    const engine = new SeraEngine({
      config,
      logger,
      registry,
      extractionNodes,
      resolver,
      workspaces,
      backend,
      jobs,
    });
    engine.stopReaper = workspaces.startReaper(config.reapIntervalSeconds);
    // One sweep at boot clears anything a previous process left behind.
    void workspaces.reap().catch(() => undefined);
    return engine;
  }

  /** Starts processing jobs in this process. */
  startWorker(concurrency?: number): WorkerHandle {
    this.worker = this.jobs.startWorker(concurrency);
    this.logger.info(
      { driver: this.backend.driver, concurrency: concurrency ?? this.config.workerConcurrency },
      'worker started',
    );
    return this.worker;
  }

  serviceInfo(): ServiceInfo {
    return {
      name: 'SERA.toolkit',
      version: VERSION,
      providers: this.registry.summarize(),
      limits: {
        maxFilesizeBytes: this.config.maxFilesizeBytes,
        maxDurationSeconds: this.config.maxDurationSeconds,
        maxItemsPerJob: this.config.maxItemsPerJob,
        retentionSeconds: this.config.retentionSeconds,
      },
    };
  }

  /**
   * Reports whether the service can actually do its job.
   *
   * The tool checks run the real binaries rather than testing that a path exists: a
   * misconfigured FFmpeg looks identical to a working one until it is executed, and a
   * health endpoint that cannot tell the difference is worse than none.
   */
  async health(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];

    checks.push(
      await checkTool('yt-dlp', () => ytdlpVersion(this.config.ytdlpPath)),
      await checkTool('ffmpeg', () => ffmpegVersion(this.config.ffmpegPath)),
      await checkTool('storage', async () => {
        const usage = await this.workspaces.usage();
        return `${usage.workspaces} workspaces, ${Math.round(usage.bytes / 1048576)} MB`;
      }),
      await checkTool('queue', async () => {
        const waiting = await this.backend.waitingCount();
        return `${this.backend.driver}, ${waiting} waiting`;
      }),
    );

    // Where extraction can run. Only reported once a deployment has enabled it, so a
    // normal install's health output does not grow a line about a feature it is not
    // using. A configured node that has gone quiet shows as an error here, which is the
    // one way an operator finds out before a visitor does.
    if (this.config.extractionNodes.enabled) {
      const nodes = this.extractionNodes.status();
      const healthy = nodes.filter((node) => node.healthy);
      checks.push({
        name: 'extraction-nodes',
        status: nodes.length === 0 ? 'error' : healthy.length ? 'ok' : 'error',
        detail: nodes.length
          ? healthy
              .map(
                (node) =>
                  `${node.id} [${node.networkClass}] (${node.providers.join(',') || 'any'})`,
              )
              .join(', ') || 'all nodes are stale'
          : 'none connected',
      });
    }

    const failed = checks.filter((check) => check.status === 'error').length;
    return {
      status: failed === 0 ? 'ok' : failed === checks.length ? 'error' : 'degraded',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  async close(): Promise<void> {
    this.stopReaper?.();
    await this.worker?.close().catch(() => undefined);
    await this.backend.close().catch(() => undefined);
  }
}

async function checkTool(name: string, probe: () => Promise<string>): Promise<HealthCheck> {
  try {
    return { name, status: 'ok', detail: await probe() };
  } catch (error) {
    return {
      name,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createBackend(config: EngineConfig, logger: Logger): Promise<JobBackend> {
  if (config.queueDriver === 'redis') {
    // Imported lazily so a memory-driver deployment never loads the Redis client.
    const { RedisJobBackend } = await import('./queue/redis.js');
    logger.info({ driver: 'redis' }, 'using distributed job backend');
    return new RedisJobBackend(config.redisUrl, logger);
  }
  return new MemoryJobBackend(logger);
}
