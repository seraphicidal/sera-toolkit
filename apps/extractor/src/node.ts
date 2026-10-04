import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  type JobRunner,
  type MediaResolver,
  newJobId,
  parseUserUrl,
  type ProviderRegistry,
  SeraError,
  seraError,
  type WorkspaceManager,
  type EngineConfig,
  type JobSpec,
  type Logger,
  type NodeFeature,
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
 */

interface RemoteTask {
  readonly id: string;
  readonly kind: 'resolve' | 'job';
  readonly url: string;
  readonly providerId: string;
  readonly planKeys?: readonly string[];
  readonly filename?: string;
  /** For a job: keep only this part of the item, in seconds. */
  readonly trim?: { readonly start: number; readonly end?: number };
  /** For a job: a subtitle track to embed or deliver. */
  readonly subtitles?: {
    readonly lang: string;
    readonly auto: boolean;
    readonly format: 'srt' | 'vtt' | 'embed';
    readonly only: boolean;
  };
}

/** What this node understands beyond a plain download; sent with every claim. */
export const NODE_FEATURES: readonly NodeFeature[] = ['trim', 'subtitles'];

/** A task's subtitles, if it has well-formed ones: the language goes onto a command line. */
export function taskSubtitles(task: Pick<RemoteTask, 'subtitles'>): RemoteTask['subtitles'] {
  const subtitles = task.subtitles;
  if (subtitles === undefined) return undefined;
  const valid =
    typeof subtitles.lang === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(subtitles.lang) &&
    ['srt', 'vtt', 'embed'].includes(subtitles.format) &&
    !(subtitles.only && subtitles.format === 'embed');
  if (!valid) throw seraError('INVALID_URL', { detail: 'node: malformed subtitles' });
  return {
    lang: subtitles.lang,
    auto: subtitles.auto === true,
    format: subtitles.format,
    only: subtitles.only === true,
  };
}

/**
 * A task's trim, if it has a sane one.
 *
 * The control plane checked it against the media; this checks it is a range at all, because
 * the numbers end up on a command line on somebody's own machine.
 */
export function taskTrim(task: Pick<RemoteTask, 'trim'>): RemoteTask['trim'] {
  const trim = task.trim;
  if (trim === undefined) return undefined;
  const valid =
    Number.isFinite(trim.start) &&
    trim.start >= 0 &&
    (trim.end === undefined || (Number.isFinite(trim.end) && trim.end > trim.start));
  if (!valid) throw seraError('INVALID_URL', { detail: 'node: malformed trim' });
  return { start: trim.start, ...(trim.end !== undefined ? { end: trim.end } : {}) };
}

/** Who this node is and where it reports; read from the environment by `index.ts`. */
export interface NodeOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly nodeId: string;
  readonly networkClass: string;
  /** Empty means every provider. */
  readonly providers: readonly string[];
}

/** Long enough that a quiet API is not a busy loop, short enough to notice a restart. */
const IDLE_BACKOFF_MS = 2_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const PROGRESS_INTERVAL_MS = 1_000;

/**
 * How long a claim may take before its connection is presumed dead.
 *
 * The API holds a claim open for SERA_EXTRACTION_CLAIM_HOLD_SECONDS (25 by default) and then
 * answers. Without a ceiling of its own, a claim sent just before the network changes — Wi-Fi
 * reconnecting after boot, a laptop moving between networks — waits on a socket nothing will
 * ever answer until undici gives up at five minutes, while the API stops offering this node
 * work after ninety seconds. Seen on a laptop node: connected at boot, then silent for seven
 * minutes, and every YouTube link in that window went to the datacentre and was refused.
 *
 * Must stay above the API's hold, or every idle claim would time out.
 */
const CLAIM_TIMEOUT_MS = 60_000;

/** Every other control-plane call is small and answered at once. */
const REQUEST_TIMEOUT_MS = 30_000;

export class ExtractionNode {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly nodeId: string;
  private readonly networkClass: string;
  private readonly providers: string[];
  private stopping = false;

  constructor(
    options: NodeOptions,
    private readonly logger: Logger,
    private readonly config: EngineConfig,
    private readonly registry: ProviderRegistry,
    private readonly resolver: MediaResolver,
    private readonly runner: JobRunner,
    private readonly workspaces: WorkspaceManager,
  ) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.nodeId = options.nodeId;
    this.networkClass = options.networkClass;
    this.providers = [...options.providers];

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
    const response = await this.post(
      '/internal/extraction/claim',
      {
        nodeId: this.nodeId,
        providers: this.providers,
        capacity: 1,
        networkClass: this.networkClass,
        features: NODE_FEATURES,
      },
      CLAIM_TIMEOUT_MS,
    );
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
        await this.report(`/internal/extraction/${task.id}/resolved`, { media });
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

    // Individual files, never a ZIP. Packaging is the server's job: it is the side that
    // knows the visitor asked for one archive, and it packages whatever arrives. A node
    // that zipped as well shipped the archive and every loose file, and the visitor got a
    // ZIP of those — an archive inside an archive, with each file in it twice.
    const trim = taskTrim(task);
    const subtitles = taskSubtitles(task);
    const spec: JobSpec = {
      jobId,
      provider: task.providerId,
      url: media.url,
      selections,
      packaging: 'individual',
      ...(task.filename ? { filename: task.filename } : {}),
      ...(trim ? { trim } : {}),
      ...(subtitles ? { subtitles } : {}),
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
      await this.report(`/internal/extraction/${task.id}/complete`, {});
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

  /**
   * Sends a result, and makes sure it arrived.
   *
   * A result the server refused is not a finished task. Treated as one, the node fell silent,
   * the server's lease handed the task out again, and the visitor waited for nothing. Thrown
   * here, it becomes a `failed` report the visitor sees.
   */
  private async report(path: string, body: unknown): Promise<void> {
    const response = await this.post(path, body);
    if (!response.ok) {
      throw new Error(`the server refused ${path.split('/').pop()} (HTTP ${response.status})`);
    }
  }

  private post(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
