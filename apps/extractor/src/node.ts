import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { safeExtractorArgSchema } from '@sera/contracts';
import type { RemoteProgress } from '@sera/contracts/types';
import {
  hostMatchesAny,
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
  readonly items?: readonly { readonly index: number; readonly sourceId?: string }[];
  readonly filename?: string;
  readonly trim?: { readonly start: number; readonly end?: number };
  readonly subtitles?: {
    readonly lang: string;
    readonly auto: boolean;
    readonly format: 'srt' | 'vtt' | 'embed';
    readonly only: boolean;
  };
}

export const NODE_FEATURES: readonly NodeFeature[] = ['trim', 'subtitles', 'items'];

export function taskSelections(
  task: Pick<RemoteTask, 'planKeys' | 'items'>,
  itemCount: number,
): JobSpec['selections'] {
  const keys = task.planKeys ?? [];
  return keys.map((planKey, position) => {
    const item = task.items?.length === keys.length ? task.items[position] : undefined;
    if (item) {
      return {
        itemIndex: item.index,
        ...(item.sourceId ? { sourceId: item.sourceId } : {}),
        planKey,
      };
    }
    return { itemIndex: itemCount > position ? position : 0, planKey };
  });
}

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
const PROGRESS_THROTTLE_MS = 250;
const AUTH_BACKOFF_MS = 30_000;
const MAX_AUTH_FAILURES = 3;

class FatalAuthError extends Error {
  constructor(status: number) {
    super(`extraction node authentication rejected (${status})`);
    this.name = 'FatalAuthError';
  }
}

const CLAIM_TIMEOUT_MS = 60_000;

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_MS = 1_000;

function sanitizeResolvedForWire(media: ResolvedMedia): ResolvedMedia {
  return {
    ...media,
    items: media.items.map((item) => ({
      ...item,
      plans: item.plans.map((plan) => {
        if (plan.fetch.via !== 'ytdlp' || !plan.fetch.extractorArgs?.length) return plan;
        const safeArgs = plan.fetch.extractorArgs.filter(
          (arg) => safeExtractorArgSchema.safeParse(arg).success,
        );
        const { extractorArgs: _dropped, ...restFetch } = plan.fetch;
        return {
          ...plan,
          fetch: {
            ...restFetch,
            ...(safeArgs.length ? { extractorArgs: safeArgs } : {}),
          },
        };
      }),
    })),
  };
}

export class ExtractionNode {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly nodeId: string;
  private readonly networkClass: string;
  private readonly providers: string[];
  private readonly features: NodeFeature[];
  private stopping = false;
  private claimAbort: AbortController | undefined;
  private taskAbort: AbortController | undefined;

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
    this.claimAbort?.abort();
    this.taskAbort?.abort();
  }

  async run(): Promise<void> {
    let backoff = ERROR_BACKOFF_MS;
    let authFailures = 0;
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
        authFailures = 0;
        if (!task || this.stopping) continue;
        await this.handle(task);
      } catch (error) {
        if (this.stopping) break;
        if (error instanceof FatalAuthError) {
          authFailures += 1;
          this.logger.error(
            { err: error.message, authFailures, maxAuthFailures: MAX_AUTH_FAILURES },
            'extraction node token rejected by API',
          );
          if (authFailures >= MAX_AUTH_FAILURES) throw error;
          await sleep(AUTH_BACKOFF_MS);
          continue;
        }
        authFailures = 0;
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
    const controller = new AbortController();
    this.claimAbort = controller;
    const startedAt = Date.now();
    try {
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
        controller.signal,
      );
      if (response.status === 204) {
        await response.body?.cancel().catch(() => undefined);
        if (!this.stopping && Date.now() - startedAt < 5_000) await sleep(IDLE_BACKOFF_MS);
        return undefined;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new FatalAuthError(response.status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`claim returned ${response.status}`);
      }
      return (await response.json()) as RemoteTask;
    } finally {
      if (this.claimAbort === controller) this.claimAbort = undefined;
    }
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
    if (hostMatchesAny(url.hostname, this.config.blockedHosts)) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'node: host is on the deny list' });
    }

    const detected = this.registry.detect(url);
    if (task.providerId !== 'generic' && detected?.id !== task.providerId) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `node: ${url.hostname} is not ${task.providerId}`,
      });
    }
    return url;
  }

  private async handle(task: RemoteTask): Promise<void> {
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id)) {
      this.logger.warn({ taskId: task.id }, 'ignoring task with malformed id');
      return;
    }
    const started = Date.now();
    const abort = new AbortController();
    this.taskAbort = abort;
    let currentProgress: RemoteProgress = { percent: 0, step: 'Working' };
    let lastSentAt = 0;
    let finished = false;
    let progressInFlight = false;
    let pendingProgress: RemoteProgress | undefined;

    const flushProgress = (): void => {
      if (progressInFlight || finished || abort.signal.aborted || !pendingProgress) return;
      progressInFlight = true;
      void (async () => {
        try {
          while (!finished && !abort.signal.aborted && pendingProgress) {
            const next = pendingProgress;
            pendingProgress = undefined;
            lastSentAt = Date.now();
            await this.progress(task.id, next, abort);
          }
        } finally {
          progressInFlight = false;
          if (!finished && !abort.signal.aborted && pendingProgress) {
            flushProgress();
          }
        }
      })();
    };

    const scheduleProgress = (update: RemoteProgress): void => {
      if (finished || abort.signal.aborted) return;
      pendingProgress = update;
      flushProgress();
    };

    const heartbeat = setInterval(() => {
      if (finished || abort.signal.aborted || progressInFlight) return;
      if (Date.now() - lastSentAt < PROGRESS_INTERVAL_MS - 100) return;
      scheduleProgress(currentProgress);
    }, PROGRESS_INTERVAL_MS);
    heartbeat.unref();

    const onProgress = (update: RemoteProgress): void => {
      const stepChanged = update.step !== currentProgress.step;
      currentProgress = update;
      const now = Date.now();
      if (stepChanged || now - lastSentAt >= PROGRESS_THROTTLE_MS) {
        scheduleProgress(update);
      }
    };

    try {
      const url = this.accept(task);

      if (task.kind === 'resolve') {
        const media = await this.resolver.resolveCanonical(url, task.providerId, abort.signal);
        await this.report(
          `/internal/extraction/${task.id}/resolved`,
          { media: sanitizeResolvedForWire(media) },
          abort.signal,
        );
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

      await this.runJob(task, url, abort, onProgress);
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
      const failRes = await this.post(`/internal/extraction/${task.id}/failed`, {
        code: failure.code,
        message: failure.message,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }).catch(() => undefined);
      await failRes?.body?.cancel().catch(() => undefined);
    } finally {
      finished = true;
      pendingProgress = undefined;
      clearInterval(heartbeat);
      if (this.taskAbort === abort) this.taskAbort = undefined;
    }
  }

  private async runJob(
    task: RemoteTask,
    url: URL,
    abort: AbortController,
    onProgress: (update: RemoteProgress) => void,
  ): Promise<void> {
    const jobId = newJobId();
    const media: ResolvedMedia = await this.resolver.resolveCanonical(
      url,
      task.providerId,
      abort.signal,
    );

    const selections = taskSelections(task, media.items.length);
    if (!selections.length) throw new Error('job task carried no plan keys');

    const trim = taskTrim(task);
    const subtitles = taskSubtitles(task);
    const cached = this.resolver.getCached(task.providerId, media.url);
    const spec: JobSpec = {
      jobId,
      provider: task.providerId,
      url: media.url,
      selections,
      packaging: 'individual',
      ...(task.filename ? { filename: task.filename } : {}),
      ...(trim ? { trim } : {}),
      ...(subtitles ? { subtitles } : {}),
      resolvedMedia: media,
      ...(cached?.rawInfoJson ? { rawInfoJson: cached.rawInfoJson } : {}),
      resolvedAt: cached?.resolvedAt ?? Date.now(),
    };

    try {
      await this.runner.run(
        spec,
        (update) => {
          const downloadPercent = Math.min(85, Math.round((update.progress.percent / 100) * 85));
          onProgress({
            percent: downloadPercent,
            step: update.step,
            ...(update.progress.bytesDownloaded !== undefined
              ? { bytesDownloaded: update.progress.bytesDownloaded }
              : {}),
            ...(update.progress.bytesTotal !== undefined
              ? { bytesTotal: update.progress.bytesTotal }
              : {}),
            ...(update.progress.speedBytesPerSecond !== undefined
              ? { speedBytesPerSecond: update.progress.speedBytesPerSecond }
              : {}),
            ...(update.progress.etaSeconds !== undefined
              ? { etaSeconds: update.progress.etaSeconds }
              : {}),
          });
        },
        abort.signal,
      );

      const manifest = await this.workspaces.readManifest(jobId);
      if (!manifest) throw new Error('the job produced no manifest');

      const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      const uploadedByFile = new Map<string, number>();
      const uploadStartedAt = Date.now();

      onProgress({ percent: 85, step: 'Uploading', bytesDownloaded: 0, bytesTotal: totalBytes });

      const queue = [...manifest.files];
      let uploadError: unknown;
      const worker = async () => {
        while (queue.length > 0) {
          if (abort.signal.aborted || uploadError) break;
          const file = queue.shift();
          if (!file) break;
          try {
            const path = await this.workspaces.resolveFile(jobId, file.name);
            await this.upload(
              task.id,
              file.name,
              file.mimeType,
              path,
              abort,
              (sentBytesForFile) => {
                uploadedByFile.set(file.name, sentBytesForFile);
                let uploadedBytes = 0;
                for (const value of uploadedByFile.values()) uploadedBytes += value;
                const uploadFrac = totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : 1;
                const percent = Math.min(99, Math.round(85 + uploadFrac * 14));
                const elapsedSec = (Date.now() - uploadStartedAt) / 1000;
                const speed =
                  elapsedSec > 0.25 && uploadedBytes > 0 ? uploadedBytes / elapsedSec : undefined;
                const eta =
                  speed && speed > 0 && totalBytes > uploadedBytes
                    ? (totalBytes - uploadedBytes) / speed
                    : undefined;
                onProgress({
                  percent,
                  step: 'Uploading',
                  bytesDownloaded: uploadedBytes,
                  bytesTotal: totalBytes,
                  ...(speed !== undefined ? { speedBytesPerSecond: speed } : {}),
                  ...(eta !== undefined ? { etaSeconds: eta } : {}),
                });
              },
            );
          } catch (error) {
            uploadError ??= error;
            abort.abort();
            break;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (uploadError) throw SeraError.from(uploadError);
      if (abort.signal.aborted) throw seraError('CANCELLED');
      await this.report(`/internal/extraction/${task.id}/complete`, {});
    } finally {
      await this.workspaces.destroy(jobId).catch(() => undefined);
    }
  }

  private async queryUploadedOffset(
    taskId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ complete: boolean; sizeBytes: number }> {
    const query = new URLSearchParams({ name });
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.apiUrl}/internal/extraction/${taskId}/file?${query.toString()}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.any([signal, timeoutSignal]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { complete: false, sizeBytes: 0 };
      }
      const data = (await response.json().catch(() => undefined)) as
        { exists?: boolean; complete?: boolean; sizeBytes?: number } | undefined;
      return {
        complete: Boolean(data?.complete),
        sizeBytes:
          typeof data?.sizeBytes === 'number' &&
          Number.isSafeInteger(data.sizeBytes) &&
          data.sizeBytes > 0
            ? data.sizeBytes
            : 0,
      };
    } catch {
      return { complete: false, sizeBytes: 0 };
    }
  }

  private async upload(
    taskId: string,
    name: string,
    mimeType: string,
    path: string,
    abort: AbortController,
    onProgress?: (sentBytesForFile: number) => void,
  ): Promise<void> {
    const fileInfo = await stat(path);
    const totalSize = fileInfo.size;
    let offset = 0;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      if (abort.signal.aborted) throw seraError('CANCELLED');

      if (attempt > 0) {
        await sleep(UPLOAD_RETRY_BASE_MS * attempt);
        if (abort.signal.aborted) throw seraError('CANCELLED');
        const status = await this.queryUploadedOffset(taskId, name, abort.signal);
        if (status.complete) {
          onProgress?.(totalSize);
          return;
        }
        offset = Math.min(status.sizeBytes, totalSize);
      }

      const query = new URLSearchParams({ name, mime: mimeType });
      if (offset > 0) query.set('offset', String(offset));
      const remaining = Math.max(0, totalSize - offset);
      let sent = offset;
      const stream = createReadStream(path, { start: offset });
      let trackingStream: Transform | undefined;
      let bodyStream: ReadableStream<Uint8Array>;
      if (onProgress) {
        trackingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sent += chunk.length;
            onProgress(sent);
            callback(null, chunk);
          },
        });
        stream.once('error', (error) => {
          if (!trackingStream?.destroyed) trackingStream?.destroy(error);
        });
        trackingStream.once('close', () => {
          if (!stream.destroyed) stream.destroy();
        });
        bodyStream = Readable.toWeb(stream.pipe(trackingStream)) as ReadableStream<Uint8Array>;
      } else {
        bodyStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(remaining),
      };
      if (totalSize > 0 && offset < totalSize) {
        headers['content-range'] =
          `bytes ${String(offset)}-${String(totalSize - 1)}/${String(totalSize)}`;
      }

      const timeoutSignal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([abort.signal, timeoutSignal]);
      try {
        const response = await fetch(
          `${this.apiUrl}/internal/extraction/${taskId}/file?${query.toString()}`,
          {
            method: 'POST',
            headers,
            body: bodyStream,
            duplex: 'half',
            signal: combinedSignal,
          },
        );
        if (response.status === 409) {
          const conflict = (await response.json().catch(() => undefined)) as
            { cancelled?: boolean; superseded?: boolean } | undefined;
          if (conflict?.cancelled || !conflict?.superseded) {
            throw seraError('CANCELLED');
          }
          lastError = new Error(`upload of ${name} was superseded`);
          continue;
        }
        if (response.status === 416) {
          const receivedHeader = Number(response.headers.get('x-sera-received-bytes'));
          const body416 = (await response.json().catch(() => undefined)) as
            { receivedBytes?: number } | undefined;
          const serverBytes = Number.isSafeInteger(receivedHeader)
            ? receivedHeader
            : typeof body416?.receivedBytes === 'number'
              ? body416.receivedBytes
              : 0;
          offset = Math.max(0, Math.min(serverBytes, totalSize));
          lastError = new Error(`upload offset mismatch for ${name}`);
          continue;
        }
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`upload of ${name} returned ${response.status}`);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          lastError = new Error(`upload of ${name} returned ${response.status}`);
          continue;
        }
        const payload = (await response.json().catch(() => undefined)) as
          { accepted?: boolean; cancelled?: boolean } | undefined;
        if (payload?.cancelled) throw seraError('CANCELLED');
        if (payload?.accepted === false) {
          throw new Error(`the server did not accept uploaded file ${name}`);
        }
        onProgress?.(totalSize);
        return;
      } catch (error) {
        if (error instanceof SeraError && error.code === 'CANCELLED') throw error;
        if (abort.signal.aborted) throw seraError('CANCELLED', { cause: error });
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 >= MAX_UPLOAD_ATTEMPTS) {
          throw lastError;
        }
      } finally {
        stream.destroy();
        trackingStream?.destroy();
      }
    }
    throw lastError ?? new Error(`upload of ${name} failed`);
  }

  private async progress(
    taskId: string,
    update: RemoteProgress,
    abort: AbortController,
  ): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      const response = await this.post(
        `/internal/extraction/${taskId}/progress`,
        {
          percent: update.percent,
          step: update.step,
          ...(update.bytesDownloaded !== undefined
            ? { bytesDownloaded: update.bytesDownloaded }
            : {}),
          ...(update.bytesTotal !== undefined ? { bytesTotal: update.bytesTotal } : {}),
          ...(update.speedBytesPerSecond !== undefined
            ? { speedBytesPerSecond: update.speedBytesPerSecond }
            : {}),
          ...(update.etaSeconds !== undefined ? { etaSeconds: update.etaSeconds } : {}),
        },
        REQUEST_TIMEOUT_MS,
        abort.signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const body = (await response.json()) as { cancelled?: boolean };
      if (body.cancelled && !abort.signal.aborted) abort.abort();
    } catch {}
  }

  private async report(path: string, body: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.post(path, body, REQUEST_TIMEOUT_MS, signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`the server refused ${path.split('/').pop()} (HTTP ${response.status})`);
    }
    const payload = (await response.json().catch(() => undefined)) as
      { accepted?: boolean } | undefined;
    if (payload?.accepted === false) {
      throw new Error(`the server did not accept ${path.split('/').pop()}`);
    }
  }

  private post(
    path: string,
    body: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
