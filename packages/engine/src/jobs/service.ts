import type { CreateJobRequest, Job, JobEvent } from '@sera/contracts/types';
import {
  checkTrim,
  isTerminalJobState,
  SUBTITLE_EMBED_CONTAINERS,
  type ContainerFormat,
  type TrimRange,
} from '@sera/contracts/types';
import type { EngineConfig } from '../config.js';
import { seraError, SeraError } from '../errors.js';
import { logSafeUrl, type Logger } from '../logging.js';
import type { MediaResolver } from '../resolver.js';
import type { WorkspaceManager } from '../storage/workspace.js';
import { classifyFailure } from '../extract/failure.js';
import type { RemoteExtraction } from '../extract/remote.js';
import type { UsageCounter } from '../usage/counts.js';
import { newJobId } from '../util/tokens.js';
import type { JobBackend, JobRecord, WorkerHandle } from '../queue/types.js';
import { toPublicJob } from '../queue/types.js';
import { JobRunner, type JobSelection, type JobSpec, type JobSubtitles } from './runner.js';

export interface JobServiceDependencies {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly resolver: MediaResolver;
  readonly workspaces: WorkspaceManager;
  readonly backend: JobBackend;
  readonly remote?: RemoteExtraction;
  readonly runner?: JobRunner;
  readonly usage?: UsageCounter;
}

const PROGRESS_THROTTLE_MS = 250;

export class JobService {
  private readonly runner: JobRunner;
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly createLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: JobServiceDependencies) {
    this.runner =
      deps.runner ??
      new JobRunner({
        config: deps.config,
        logger: deps.logger,
        resolver: deps.resolver,
        workspaces: deps.workspaces,
        ...(deps.remote ? { remote: deps.remote } : {}),
      });
  }

  async create(
    request: CreateJobRequest,
    clientKey: string,
    { uncounted = false }: { readonly uncounted?: boolean } = {},
  ): Promise<Job> {
    const { config, resolver, backend } = this.deps;

    const info = resolver.verifyInfoId(request.infoId);
    if (resolver.isBlocked(info.u)) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'This URL has been blocked' });
    }
    const expectedHash = resolver.resolutionHash(info.u, info.p, info.m);
    const selections: JobSelection[] = [];
    const options = [];

    for (const optionId of request.optionIds) {
      const option = resolver.verifyOptionId(optionId);
      if (option.h !== expectedHash) {
        throw seraError('EXPIRED', {
          message: 'Those options came from a different link.',
          hint: 'Analyze the link again.',
          detail: 'option token does not match info token',
        });
      }
      options.push(option);
      selections.push({
        itemIndex: option.i,
        ...(option.s ? { sourceId: option.s } : {}),
        planKey: option.k,
      });
    }

    if (!selections.length)
      throw seraError('INVALID_URL', { message: 'Choose something to download.' });
    if (selections.length > config.maxItemsPerJob) {
      throw seraError('TOO_LARGE', {
        message: `A single download can include at most ${config.maxItemsPerJob} items.`,
      });
    }

    const trim = request.trim ? trimFor(request.trim, options) : undefined;
    const subtitles = request.subtitles
      ? subtitlesFor(request.subtitles, options, trim !== undefined)
      : undefined;

    return this.withClientCreateLock(clientKey, async () => {
      const waiting = await backend.waitingCount();
      if (waiting >= config.maxQueueDepth) {
        throw seraError('QUEUE_FULL', { detail: `${waiting} jobs waiting` });
      }
      const active = await backend.activeCountFor(clientKey);
      if (active >= config.maxConcurrentJobsPerClient) {
        throw seraError('RATE_LIMITED', {
          message: 'You already have downloads in progress.',
          hint: 'Wait for one to finish, then try again.',
          detail: `${active} concurrent jobs`,
        });
      }

      let resolvedMedia;
      let rawInfoJson: string | undefined;
      let resolvedAt: number | undefined;

      if (!info.m) {
        const cached = resolver.getCached(info.p, info.u);
        if (cached) {
          try {
            const mediaJson = JSON.stringify(cached.media);
            if (mediaJson.length <= 1024 * 1024) {
              resolvedMedia = cached.media;
              resolvedAt = cached.resolvedAt ?? Date.now();
              if (cached.rawInfoJson && cached.rawInfoJson.length <= 1024 * 1024) {
                rawInfoJson = cached.rawInfoJson;
              }
            }
          } catch {}
        }
      }

      const spec: JobSpec = {
        jobId: newJobId(),
        provider: info.p,
        url: info.u,
        selections,
        packaging: request.packaging ?? 'auto',
        ...(request.filename ? { filename: request.filename } : {}),
        ...(trim ? { trim } : {}),
        ...(subtitles ? { subtitles } : {}),
        ...(resolvedMedia ? { resolvedMedia } : {}),
        ...(rawInfoJson ? { rawInfoJson } : {}),
        ...(resolvedAt !== undefined ? { resolvedAt } : {}),
        ...(info.m
          ? {
              imported: {
                entries: info.m,
                title: info.t ?? '',
                ...(info.a ? { author: info.a } : {}),
                ...(info.x !== undefined ? { expiresAt: info.x } : {}),
              },
            }
          : {}),
      };

      const now = new Date().toISOString();
      const record: JobRecord = {
        id: spec.jobId,
        state: 'queued',
        step: 'Waiting to start',
        progress: {
          percent: 0,
          ...(selections.length > 1 ? { totalFiles: selections.length } : {}),
        },
        provider: info.p,
        createdAt: now,
        updatedAt: now,
        spec,
        clientKey,
        ...(uncounted ? { uncounted: true } : {}),
      };

      await backend.submit(record);
      this.deps.logger.info(
        {
          jobId: spec.jobId,
          provider: info.p,
          source: logSafeUrl(info.u),
          items: selections.length,
          ...(spec.imported ? { strategy: 'visitor-browser' } : {}),
        },
        'job queued',
      );
      return toPublicJob(record);
    });
  }

  private async withClientCreateLock<T>(clientKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.createLocks.get(clientKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.createLocks.set(clientKey, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.createLocks.get(clientKey) === tail) {
        this.createLocks.delete(clientKey);
      }
    }
  }

  async get(id: string, clientKey?: string): Promise<Job | undefined> {
    const record = await this.deps.backend.get(id);
    if (!record) return undefined;
    if (clientKey && record.clientKey !== clientKey) return undefined;
    return toPublicJob(record);
  }

  async markExpired(id: string): Promise<Job | undefined> {
    const updated = await this.deps.backend.patch(id, {
      state: 'expired',
      step: 'Expired',
    });
    return updated ? toPublicJob(updated) : undefined;
  }

  private async abortAndWait(id: string): Promise<boolean> {
    const active = this.inFlight.get(id);
    active?.controller.abort();
    await this.deps.backend.patch(id, {
      state: 'cancelled',
      step: 'Cancelled',
      error: seraError('CANCELLED').toJobError(),
    });
    if (!active) return true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      active.done.then(() => {
        settled = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 4_000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      void active.done.finally(() => {
        void this.deps.workspaces.destroy(id).catch(() => undefined);
      });
    }
    return settled;
  }

  async cancel(id: string, clientKey?: string): Promise<boolean> {
    const record = await this.deps.backend.get(id);
    if (
      !record ||
      (clientKey && record.clientKey !== clientKey) ||
      isTerminalJobState(record.state)
    ) {
      return false;
    }

    const settled = await this.abortAndWait(id);
    if (settled) {
      await this.deps.workspaces.destroy(id);
    }
    return true;
  }

  async delete(id: string, clientKey?: string): Promise<boolean> {
    const record = await this.deps.backend.get(id);
    if (!record || (clientKey && record.clientKey !== clientKey)) return false;

    let settled = true;
    if (!isTerminalJobState(record.state)) {
      settled = await this.abortAndWait(id);
    }
    if (settled) {
      await this.deps.workspaces.destroy(id);
    }
    return true;
  }

  async *events(id: string, signal?: AbortSignal, clientKey?: string): AsyncGenerator<JobEvent> {
    const queue: JobEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: JobEvent): void => {
      queue.push(event);
      notify?.();
    };

    const unsubscribe = this.deps.backend.subscribe(id, (updated) => {
      if (clientKey && updated.clientKey !== clientKey) return;
      const job = toPublicJob(updated);
      push({ type: eventTypeFor(job), job });
    });
    const onAbort = (): void => push({ type: 'ping' });
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const record = await this.deps.backend.get(id);
      if (!record || (clientKey && record.clientKey !== clientKey)) {
        throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      }

      const initial = toPublicJob(record);
      yield { type: eventTypeFor(initial), job: initial };
      if (isTerminalJobState(record.state)) return;

      for (;;) {
        while (queue.length) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'done' || event.type === 'error') return;
        }
        if (signal?.aborted) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve) => {
            notify = resolve;
            timer = setTimeout(resolve, 15_000);
            timer.unref();
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
        notify = undefined;
        if (!queue.length && !signal?.aborted) yield { type: 'ping' };
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  startWorker(concurrency = this.deps.config.workerConcurrency): WorkerHandle {
    return this.deps.backend.startWorker((record) => this.execute(record), concurrency);
  }

  private count(
    record: JobRecord,
    outcome: { readonly ok: true } | { readonly ok: false; readonly code: string },
  ): void {
    if (record.uncounted || !this.deps.usage) return;
    void this.deps.usage.record({ source: record.provider, kind: 'download', ...outcome });
  }

  private async execute(record: JobRecord): Promise<void> {
    const { backend, logger, workspaces } = this.deps;
    const current = await backend.get(record.id);
    if (!current || isTerminalJobState(current.state)) return;

    const cancelController = new AbortController();
    const timeoutController = new AbortController();
    const combinedSignal = AbortSignal.any([cancelController.signal, timeoutController.signal]);
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    this.inFlight.set(record.id, { controller: cancelController, done });

    const unwatch = backend.subscribe(record.id, (updated) => {
      if (updated.state === 'cancelled') cancelController.abort();
    });

    const timeout = setTimeout(
      () => timeoutController.abort(),
      this.deps.config.jobTimeoutSeconds * 1000,
    );
    timeout.unref();

    let lastPatch = 0;
    let lastFlushedState: JobRecord['state'] = current.state;
    let pending:
      { state: JobRecord['state']; step: string; progress: JobRecord['progress'] } | undefined;
    let inFlightFlush: Promise<void> | undefined;

    const flush = async (): Promise<void> => {
      while (pending) {
        const update = pending;
        pending = undefined;
        lastFlushedState = update.state;
        await backend.patch(record.id, update).catch(() => undefined);
      }
    };

    try {
      workspaces.markActive(record.id);
      const result = await this.runner.run(
        record.spec,
        (update) => {
          pending = update;
          const now = Date.now();
          const stateChanged = update.state !== lastFlushedState;
          if (stateChanged || now - lastPatch >= PROGRESS_THROTTLE_MS) {
            lastPatch = now;
            inFlightFlush = (inFlightFlush ?? Promise.resolve()).then(() => flush());
          }
        },
        combinedSignal,
      );

      pending = undefined;
      await inFlightFlush;
      const totalFiles = record.spec.selections.length;
      await backend.patch(record.id, {
        state: 'ready',
        step: 'Ready',
        progress: {
          percent: 100,
          ...(totalFiles > 1 ? { currentFile: totalFiles, totalFiles } : {}),
        },
        result,
      });
      this.count(record, { ok: true });
    } catch (error) {
      pending = undefined;
      await inFlightFlush;
      const isTimeout = timeoutController.signal.aborted;
      const rawErr = SeraError.from(error);
      const seraErr = isTimeout
        ? seraError('TIMEOUT', {
            message: 'That job took too long to complete.',
            detail: `job timed out after ${this.deps.config.jobTimeoutSeconds}s`,
          })
        : rawErr;
      const cancelled =
        !isTimeout && (rawErr.code === 'CANCELLED' || cancelController.signal.aborted);
      if (!cancelled) this.count(record, { ok: false, code: seraErr.code });

      await backend.patch(record.id, {
        state: cancelled ? 'cancelled' : 'failed',
        step: cancelled ? 'Cancelled' : 'Failed',
        progress: { percent: 0 },
        error: (cancelled ? seraError('CANCELLED') : seraErr).toJobError(),
      });
      await workspaces.destroy(record.id).catch(() => undefined);

      logger.info(
        {
          jobId: record.id,
          provider: record.provider,
          source: logSafeUrl(record.spec.url),
          outcome: cancelled ? 'cancelled' : 'failed',
          errorCode: seraErr.code,
          failureClass: classifyFailure(seraErr),
          detail: seraErr.detail,
        },
        'job finished',
      );
    } finally {
      workspaces.markInactive(record.id);
      clearTimeout(timeout);
      unwatch();
      this.inFlight.delete(record.id);
      markDone();
    }
  }
}

function eventTypeFor(job: Job): JobEvent['type'] {
  if (job.state === 'ready') return 'done';
  if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired')
    return 'error';
  return job.state === 'queued' ? 'state' : 'progress';
}

function trimFor(
  request: NonNullable<CreateJobRequest['trim']>,
  options: readonly { readonly k: string; readonly d?: number }[],
): TrimRange {
  const [option, ...rest] = options;
  if (!option || rest.length) {
    throw seraError('INVALID_URL', {
      message: 'Trimming works on one item at a time.',
      detail: `trim with ${options.length} selections`,
    });
  }
  const kind = option.k.split('/')[0];
  if (kind !== 'video' && kind !== 'audio') {
    throw seraError('INVALID_URL', {
      message: 'Only video and audio can be trimmed.',
      detail: `trim on ${kind ?? 'unknown'}`,
    });
  }
  const checked = checkTrim(request, option.d);
  if (!checked.ok) {
    throw seraError('INVALID_URL', { message: checked.message, detail: 'trim out of range' });
  }
  return checked.range;
}

function subtitlesFor(
  request: NonNullable<CreateJobRequest['subtitles']>,
  options: readonly { readonly k: string }[],
  trimmed: boolean,
): JobSubtitles {
  const [option, ...rest] = options;
  if (!option || rest.length) {
    throw seraError('INVALID_URL', {
      message: 'Subtitles work on one item at a time.',
      detail: `subtitles with ${options.length} selections`,
    });
  }
  if (trimmed) {
    throw seraError('INVALID_URL', {
      message: 'Subtitles cannot be added to a trimmed download yet.',
      detail: 'subtitles with trim',
    });
  }
  const [kind, container] = option.k.split('/');
  if (
    request.format === 'embed' &&
    (kind !== 'video' || !SUBTITLE_EMBED_CONTAINERS.includes(container as ContainerFormat))
  ) {
    throw seraError('INVALID_URL', {
      message: 'Subtitles can be embedded only in an MP4, MKV or WebM video.',
      detail: `embed into ${option.k}`,
    });
  }
  return {
    lang: request.lang,
    auto: request.auto === true,
    format: request.format,
    only: request.only === true,
  };
}
