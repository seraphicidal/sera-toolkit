import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  createLogger,
  JobRunner,
  loadConfig,
  MediaResolver,
  newJobId,
  parseUserUrl,
  ProviderRegistry,
  SeraError,
  seraError,
  WorkspaceManager,
  type EngineConfig,
  type JobSpec,
  type Logger,
  type ResolvedMedia,
} from '@sera/engine';

/**
 * The extraction node.
 *
 * This runs on a machine whose connection the platforms do not refuse — a home
 * connection, usually — and does extraction that the server cannot. It is not a proxy.
 * It listens on nothing, accepts no connections, and only ever performs work the SERA
 * deployment it is configured for hands to it.
 *
 * It has to do whole jobs, not just resolutions. A media URL YouTube signs is bound to
 * the address that asked for it: the same URL answers 206 here and 403 on the server, so
 * a resolution taken on one network and a download taken on another do not compose. When
 * this node resolves a link it owns the download too, and ships the finished file back.
 *
 *   SERA_API_URL=https://your-deployment
 *   SERA_EXTRACTION_NODE_TOKEN=<the same secret the API has>
 *   SERA_NODE_ID=home            (optional)
 *   SERA_NODE_PROVIDERS=youtube  (optional; empty means every provider)
 *   SERA_NODE_NETWORK_CLASS=residential  (optional; datacenter for a second cloud node)
 */

interface RemoteTask {
  readonly id: string;
  readonly kind: 'resolve' | 'job';
  readonly url: string;
  readonly providerId: string;
  readonly planKeys?: readonly string[];
  readonly filename?: string;
}

/** Long enough that a quiet API is not a busy loop, short enough to notice a restart. */
const IDLE_BACKOFF_MS = 2_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const PROGRESS_INTERVAL_MS = 1_000;

class Node {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly nodeId: string;
  private readonly networkClass: string;
  private readonly providers: string[];
  private stopping = false;

  constructor(
    private readonly logger: Logger,
    private readonly config: EngineConfig,
    private readonly registry: ProviderRegistry,
    private readonly resolver: MediaResolver,
    private readonly runner: JobRunner,
    private readonly workspaces: WorkspaceManager,
  ) {
    this.apiUrl = (process.env.SERA_API_URL ?? '').replace(/\/+$/, '');
    this.token = process.env.SERA_EXTRACTION_NODE_TOKEN ?? '';
    this.nodeId = process.env.SERA_NODE_ID ?? 'residential';
    this.networkClass = process.env.SERA_NODE_NETWORK_CLASS ?? 'residential';
    this.providers = (process.env.SERA_NODE_PROVIDERS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!this.apiUrl || !this.token) {
      throw new Error('SERA_API_URL and SERA_EXTRACTION_NODE_TOKEN are both required');
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /**
   * Asks for work, forever.
   *
   * The request is held open by the API, so this is a heartbeat as much as a queue: a
   * node that is asking is a node that is alive, and work reaches it immediately instead
   * of on the next poll.
   */
  async run(): Promise<void> {
    let backoff = ERROR_BACKOFF_MS;
    this.logger.info(
      {
        api: this.apiUrl,
        node: this.nodeId,
        providers: this.providers,
        networkClass: this.networkClass,
      },
      'extraction node started',
    );

    while (!this.stopping) {
      try {
        const task = await this.claim();
        backoff = ERROR_BACKOFF_MS;
        if (!task) continue;
        await this.handle(task);
      } catch (error) {
        // A deployment that is restarting, a laptop that slept, a flaky link home. None
        // of it is worth giving up over; it is worth backing off over.
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error), backoffMs: backoff },
          'could not reach the SERA API',
        );
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async claim(): Promise<RemoteTask | undefined> {
    const response = await this.post('/internal/extraction/claim', {
      nodeId: this.nodeId,
      providers: this.providers,
      capacity: 1,
      networkClass: this.networkClass,
    });
    if (response.status === 204) {
      await sleep(IDLE_BACKOFF_MS);
      return undefined;
    }
    if (!response.ok) throw new Error(`claim returned ${response.status}`);
    return (await response.json()) as RemoteTask;
  }

  /**
   * What this node will agree to do, decided here rather than taken on trust.
   *
   * The control plane checks all of this before it dispatches anything, and that is not
   * a reason to skip it. This machine is somebody's home connection, and the whole
   * argument for it being safe is that it does a narrow, known job. A node that runs
   * whatever arrives is one compromised deployment — or one bug in a validator on the
   * other side — away from being a fetcher for arbitrary addresses.
   *
   * yt-dlp is a subprocess and makes its own connections, so the engine's SSRF-guarded
   * dispatcher does not cover it. This is the check that does.
   */
  private accept(task: RemoteTask): URL {
    if (this.providers.length && !this.providers.includes(task.providerId)) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `node: not configured for ${task.providerId}`,
      });
    }

    // Protocol, embedded credentials, unusual ports, and any IP literal that points at
    // infrastructure — the same gate the public API puts a visitor's link through.
    const { url } = parseUserUrl(task.url, {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    });

    // And the named provider has to be the one that claims this host, so a task cannot
    // borrow a provider's name to have some other address fetched.
    const detected = this.registry.detect(url);
    if (detected?.id !== task.providerId) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `node: ${url.hostname} is not ${task.providerId}`,
      });
    }
    return url;
  }

  private async handle(task: RemoteTask): Promise<void> {
    const started = Date.now();
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.progress(task.id, 0, 'Working', abort);
    }, PROGRESS_INTERVAL_MS);
    heartbeat.unref();

    try {
      const url = this.accept(task);

      if (task.kind === 'resolve') {
        const media = await this.resolver.resolveCanonical(url, task.providerId, abort.signal);
        await this.post(`/internal/extraction/${task.id}/resolved`, { media });
        this.logger.info(
          {
            task: task.id,
            kind: task.kind,
            provider: task.providerId,
            durationMs: Date.now() - started,
            items: media.items.length,
          },
          'task complete',
        );
        return;
      }

      await this.runJob(task, url, abort);
      this.logger.info(
        {
          task: task.id,
          kind: task.kind,
          provider: task.providerId,
          durationMs: Date.now() - started,
        },
        'task complete',
      );
    } catch (error) {
      const failure = SeraError.from(error);
      this.logger.info(
        { task: task.id, kind: task.kind, failureClass: failure.code, detail: failure.detail },
        'task failed',
      );
      await this.post(`/internal/extraction/${task.id}/failed`, {
        code: failure.code,
        message: failure.message,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Resolves, downloads, converts and uploads — the whole job, on this network. */
  private async runJob(task: RemoteTask, url: URL, abort: AbortController): Promise<void> {
    const jobId = newJobId();
    const media: ResolvedMedia = await this.resolver.resolveCanonical(
      url,
      task.providerId,
      abort.signal,
    );

    // The plan keys were minted from a resolution this node produced, so they match.
    const selections = (task.planKeys ?? []).map((planKey, index) => ({
      itemIndex: media.items.length > index ? index : 0,
      planKey,
    }));
    if (!selections.length) throw new Error('job task carried no plan keys');

    const spec: JobSpec = {
      jobId,
      provider: task.providerId,
      url: media.url,
      selections,
      packaging: 'auto',
      ...(task.filename ? { filename: task.filename } : {}),
    };

    try {
      await this.runner.run(
        spec,
        (update) => {
          void this.progress(task.id, update.progress.percent, update.step, abort);
        },
        abort.signal,
      );

      const manifest = await this.workspaces.readManifest(jobId);
      if (!manifest) throw new Error('the job produced no manifest');

      // Order matters — a carousel is a sequence — so these go one at a time.
      for (const file of manifest.files) {
        const path = await this.workspaces.resolveFile(jobId, file.name);
        await this.upload(task.id, file.name, file.mimeType, path);
      }
      await this.post(`/internal/extraction/${task.id}/complete`, {});
    } finally {
      // Nothing stays on the node. It is someone's own machine.
      await this.workspaces.destroy(jobId).catch(() => undefined);
    }
  }

  private async upload(
    taskId: string,
    name: string,
    mimeType: string,
    path: string,
  ): Promise<void> {
    const query = new URLSearchParams({ name, mime: mimeType });
    const response = await fetch(
      `${this.apiUrl}/internal/extraction/${taskId}/file?${query.toString()}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/octet-stream',
        },
        body: Readable.toWeb(createReadStream(path)),
        // Node needs this to stream a request body rather than buffering the whole file.
        duplex: 'half',
      },
    );
    if (!response.ok) throw new Error(`upload of ${name} returned ${response.status}`);
  }

  /** Reports progress and finds out whether anyone is still waiting. */
  private async progress(
    taskId: string,
    percent: number,
    step: string,
    abort: AbortController,
  ): Promise<void> {
    try {
      const response = await this.post(`/internal/extraction/${taskId}/progress`, {
        percent,
        step,
      });
      if (!response.ok) return;
      const body = (await response.json()) as { cancelled?: boolean };
      // The visitor closed the tab. Stop spending a home connection on it.
      if (body.cancelled && !abort.signal.aborted) abort.abort();
    } catch {
      // A missed progress report is not a reason to abandon the work.
    }
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: !config.isProduction,
    name: 'sera-node',
  });

  const registry = new ProviderRegistry();
  const resolver = new MediaResolver({ config, logger, registry });
  const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
  const runner = new JobRunner({ config, logger, resolver, workspaces });

  const node = new Node(logger, config, registry, resolver, runner, workspaces);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'stopping extraction node');
    node.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await node.run();
}

await main();
