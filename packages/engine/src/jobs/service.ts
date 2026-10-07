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
  private readonly inFlight = new Map<string, AbortController>();

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

    const spec: JobSpec = {
      jobId: newJobId(),
      provider: info.p,
      url: info.u,
      selections,
      packaging: request.packaging ?? 'auto',
      ...(request.filename ? { filename: request.filename } : {}),
      ...(trim ? { trim } : {}),
      ...(subtitles ? { subtitles } : {}),
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
      progress: { percent: 0, ...(selections.length > 1 ? { totalFiles: selections.length } : {}) },
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
  }

  async get(id: string): Promise<Job | undefined> {
    const record = await this.deps.backend.get(id);
    return record ? toPublicJob(record) : undefined;
  }

  async cancel(id: string): Promise<boolean> {
    const record = await this.deps.backend.get(id);
    if (!record || isTerminalJobState(record.state)) return false;

    this.inFlight.get(id)?.abort();
    await this.deps.backend.patch(id, {
      state: 'cancelled',
      step: 'Cancelled',
      error: seraError('CANCELLED').toJobError(),
    });
    await this.deps.workspaces.destroy(id);
    return true;
  }

  async *events(id: string, signal?: AbortSignal): AsyncGenerator<JobEvent> {
    const record = await this.deps.backend.get(id);
    if (!record) throw seraError('NOT_FOUND', { message: 'That download has expired.' });

    const initial = toPublicJob(record);
    yield { type: eventTypeFor(initial), job: initial };
    if (isTerminalJobState(record.state)) return;

    const queue: JobEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: JobEvent): void => {
      queue.push(event);
      notify?.();
    };

    const unsubscribe = this.deps.backend.subscribe(id, (updated) => {
      const job = toPublicJob(updated);
      push({ type: eventTypeFor(job), job });
    });
    const onAbort = (): void => push({ type: 'ping' });
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        while (queue.length) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'done' || event.type === 'error') return;
        }
        if (signal?.aborted) return;

        await new Promise<void>((resolve) => {
          notify = resolve;
          const timer = setTimeout(resolve, 15_000);
          timer.unref();
        });
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
    const controller = new AbortController();
    this.inFlight.set(record.id, controller);

    const unwatch = backend.subscribe(record.id, (updated) => {
      if (updated.state === 'cancelled') controller.abort();
    });

    const timeout = setTimeout(() => controller.abort(), this.deps.config.jobTimeoutSeconds * 1000);
    timeout.unref();

    let lastPatch = 0;
    let pending:
      { state: JobRecord['state']; step: string; progress: JobRecord['progress'] } | undefined;

    const flush = async (): Promise<void> => {
      if (!pending) return;
      const update = pending;
      pending = undefined;
      await backend.patch(record.id, update);
    };

    try {
      const result = await this.runner.run(
        record.spec,
        (update) => {
          pending = update;
          const now = Date.now();
          const stateChanged = update.state !== record.state;
          if (stateChanged || now - lastPatch >= PROGRESS_THROTTLE_MS) {
            lastPatch = now;
            void flush();
          }
        },
        controller.signal,
      );

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
      const seraErr = SeraError.from(error);
      const cancelled = seraErr.code === 'CANCELLED' || controller.signal.aborted;
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
      clearTimeout(timeout);
      unwatch();
      this.inFlight.delete(record.id);
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
