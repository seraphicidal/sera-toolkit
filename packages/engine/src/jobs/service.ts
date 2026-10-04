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

/**
 * Job lifecycle: accepting work, reporting on it, and cleaning up after it.
 *
 * The service is deliberately the only place that turns client input into a `JobSpec`.
 * Option tokens are verified here and must all belong to the same resolution, so a
 * request cannot stitch together selections from different URLs — which is what would
 * otherwise let someone use a legitimate token as a wrapper for an arbitrary fetch.
 */

export interface JobServiceDependencies {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly resolver: MediaResolver;
  readonly workspaces: WorkspaceManager;
  readonly backend: JobBackend;
  /** Extraction nodes, for a job whose plans were made on another network. */
  readonly remote?: RemoteExtraction;
  readonly runner?: JobRunner;
  /** Where each finished job is counted, by source and outcome only. */
  readonly usage?: UsageCounter;
}

/** Progress updates are coalesced to this interval before they hit the store. */
const PROGRESS_THROTTLE_MS = 250;

export class JobService {
  private readonly runner: JobRunner;
  /** Controllers for jobs running in this process, so cancellation can reach them. */
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

  /**
   * Validates a request and queues it. Throws a `SeraError` if it cannot be accepted.
   * `uncounted` keeps the job out of the usage counts: the server's own canary.
   */
  async create(
    request: CreateJobRequest,
    clientKey: string,
    { uncounted = false }: { readonly uncounted?: boolean } = {},
  ): Promise<Job> {
    const { config, resolver, backend } = this.deps;

    const info = resolver.verifyInfoId(request.infoId);
    // An imported post's hash covers the media approved from it, so an option minted for one
    // import of a post cannot be spent against another import of the same post.
    const expectedHash = resolver.resolutionHash(info.u, info.p, info.m);
    const selections: JobSelection[] = [];
    const options = [];

    for (const optionId of request.optionIds) {
      const option = resolver.verifyOptionId(optionId);
      // Every option must come from the resolution named by infoId, so a request cannot
      // stitch selections from different links into one job.
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
      // Carried whole, because the job cannot read the post again. It only ever comes from a
      // token this server signed; nothing in the request body can reach it.
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

  /** Marks a job cancelled and, if it is running here, stops it. */
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

  /**
   * Yields events for a job until it reaches a terminal state.
   *
   * The current state is emitted first so a client that connects after the job finished
   * still gets a result rather than an open stream that never says anything.
   */
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
          // A periodic wake doubles as the SSE keep-alive.
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

  /** Starts processing jobs in this process. */
  startWorker(concurrency = this.deps.config.workerConcurrency): WorkerHandle {
    return this.deps.backend.startWorker((record) => this.execute(record), concurrency);
  }

  /** Counts a finished job by its source and outcome, unless it is the canary's. */
  private count(
    record: JobRecord,
    outcome: { readonly ok: true } | { readonly ok: false; readonly code: string },
  ): void {
    if (record.uncounted || !this.deps.usage) return;
    void this.deps.usage.record({ source: record.provider, kind: 'download', ...outcome });
  }

  /** Runs one job to completion, translating every outcome into a stored state. */
  private async execute(record: JobRecord): Promise<void> {
    const { backend, logger, workspaces } = this.deps;
    const controller = new AbortController();
    this.inFlight.set(record.id, controller);

    // Cancellation has to cross the process boundary. `inFlight` only reaches jobs
    // running in this process, and in the distributed deployment the API that handles the
    // DELETE is not the worker holding the job — so the worker learns about it the same
    // way a browser does, off the backend's update channel.
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
          // Throttling keeps a fast download from writing hundreds of updates a second,
          // while state changes always go through immediately.
          const stateChanged = update.state !== record.state;
          if (stateChanged || now - lastPatch >= PROGRESS_THROTTLE_MS) {
            lastPatch = now;
            void flush();
          }
        },
        controller.signal,
      );

      // The file counts are carried into the final progress: a completed multi-file job
      // should still be able to say "7 of 7", not lose the count at the moment it
      // finishes.
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
      // A visitor changing their mind is not a failure of the source.
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

/**
 * A trim, checked against what was signed: one option, of a kind that has a timeline, and
 * times inside the item's own length. The schema has already checked the shape and order;
 * the length is only known here, from the option token, which the client cannot edit.
 */
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

/**
 * Subtitles, checked against what was signed: one option, never alongside a trim (the track
 * would keep the whole timeline), and an embedded track only in a video container that
 * holds one. Whether the language is really offered is checked when the job re-resolves.
 */
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
