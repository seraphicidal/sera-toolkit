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

interface RemoteTask {
  readonly id: string;
  readonly kind: 'resolve' | 'job';
  readonly url: string;
  readonly providerId: string;
  readonly planKeys?: readonly string[];
  readonly filename?: string;
  readonly trim?: { readonly start: number; readonly end?: number };
  readonly subtitles?: {
    readonly lang: string;
    readonly auto: boolean;
    readonly format: 'srt' | 'vtt' | 'embed';
    readonly only: boolean;
  };
}

export const NODE_FEATURES: readonly NodeFeature[] = ['trim', 'subtitles'];

export function nodeFeatures(config: Pick<EngineConfig, 'instagram'>): NodeFeature[] {
  return [
    ...NODE_FEATURES,
    ...(config.instagram.configured ? (['instagram-session'] as const) : []),
  ];
}

export function nodeProviders(
  providers: readonly string[],
  config: Pick<EngineConfig, 'instagram'>,
): string[] {
  const list = [...providers];
  if (list.length && config.instagram.configured && !list.includes('instagram')) {
    list.push('instagram');
  }
  return list;
}

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

export interface NodeOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly nodeId: string;
  readonly networkClass: string;
  readonly providers: readonly string[];
}

const IDLE_BACKOFF_MS = 2_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const PROGRESS_INTERVAL_MS = 1_000;

const CLAIM_TIMEOUT_MS = 60_000;

const REQUEST_TIMEOUT_MS = 30_000;

export class ExtractionNode {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly nodeId: string;
  private readonly networkClass: string;
  private readonly providers: string[];
  private readonly features: NodeFeature[];
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
    this.providers = nodeProviders(options.providers, config);
    this.features = nodeFeatures(config);

    if (!this.apiUrl || !this.token) {
      throw new Error('SERA_API_URL and SERA_EXTRACTION_NODE_TOKEN are both required');
    }
  }

  stop(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    let backoff = ERROR_BACKOFF_MS;
    this.logger.info(
      {
        api: this.apiUrl,
        node: this.nodeId,
        providers: this.providers,
        networkClass: this.networkClass,
        features: this.features,
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
        features: this.features,
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

  private accept(task: RemoteTask): URL {
    if (this.providers.length && !this.providers.includes(task.providerId)) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `node: not configured for ${task.providerId}`,
      });
    }

    const { url } = parseUserUrl(task.url, {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    });

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

  private async runJob(task: RemoteTask, url: URL, abort: AbortController): Promise<void> {
    const jobId = newJobId();
    const media: ResolvedMedia = await this.resolver.resolveCanonical(
      url,
      task.providerId,
      abort.signal,
    );

    const selections = (task.planKeys ?? []).map((planKey, index) => ({
      itemIndex: media.items.length > index ? index : 0,
      planKey,
    }));
    if (!selections.length) throw new Error('job task carried no plan keys');

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

      for (const file of manifest.files) {
        const path = await this.workspaces.resolveFile(jobId, file.name);
        await this.upload(task.id, file.name, file.mimeType, path);
      }
      await this.report(`/internal/extraction/${task.id}/complete`, {});
    } finally {
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
        duplex: 'half',
      },
    );
    if (!response.ok) throw new Error(`upload of ${name} returned ${response.status}`);
  }

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
      if (body.cancelled && !abort.signal.aborted) abort.abort();
    } catch {}
  }

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
