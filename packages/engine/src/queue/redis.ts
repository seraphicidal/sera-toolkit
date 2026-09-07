import { Queue, Worker, type Job as BullJob } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from '../logging.js';
import {
  isActive,
  type JobBackend,
  type JobHandler,
  type JobPatch,
  type JobRecord,
  type WorkerHandle,
} from './types.js';

/**
 * The distributed driver: BullMQ for dispatch, Redis for state and fan-out.
 *
 * Job records live in Redis rather than in BullMQ's own payload because the API must be
 * able to read and update a job that a worker on another machine is running, and every
 * progress update has to reach whichever API instance is holding that client's event
 * stream. Pub/sub does the fan-out; the queue only decides who runs what.
 */

/**
 * BullMQ refuses a queue name containing `:` — it builds its own key namespace by
 * joining on that character, so a colon here would collide with its internal layout.
 * The plain Redis keys below are ours alone and use the usual colon convention.
 */
export const QUEUE_NAME = 'sera-jobs';

const RECORD_PREFIX = 'sera:job:';
const CLIENT_PREFIX = 'sera:client:';
const UPDATE_CHANNEL = 'sera:job-updates';

export class RedisJobBackend implements JobBackend {
  readonly driver = 'redis' as const;

  private readonly connection: Redis;
  private readonly subscriber: Redis;
  private readonly queue: Queue<{ jobId: string }>;
  private readonly listeners = new Map<string, Set<(record: JobRecord) => void>>();
  private worker: Worker<{ jobId: string }> | undefined;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
    /** Records expire on their own, so a crashed worker cannot leak state forever. */
    private readonly recordTtlSeconds = 24 * 60 * 60,
  ) {
    // BullMQ requires this setting on the connection it blocks on.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });

    void this.subscriber.subscribe(UPDATE_CHANNEL).catch((error: unknown) => {
      this.logger.error({ err: error }, 'failed to subscribe to job updates');
    });
    this.subscriber.on('message', (_channel, payload) => {
      let record: JobRecord;
      try {
        record = JSON.parse(payload) as JobRecord;
      } catch {
        return;
      }
      for (const listener of this.listeners.get(record.id) ?? []) listener(record);
    });
  }

  async submit(record: JobRecord): Promise<void> {
    await this.write(record);
    await this.connection.sadd(CLIENT_PREFIX + record.clientKey, record.id);
    await this.connection.expire(CLIENT_PREFIX + record.clientKey, this.recordTtlSeconds);
    await this.queue.add(
      'download',
      { jobId: record.id },
      {
        jobId: record.id,
        // The pipeline is not idempotent — a half-written workspace must not be retried
        // behind the user's back — so failures surface rather than silently re-running.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const raw = await this.connection.get(RECORD_PREFIX + id);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as JobRecord;
    } catch {
      return undefined;
    }
  }

  async patch(id: string, patch: JobPatch): Promise<JobRecord | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;

    const next: JobRecord = {
      ...current,
      ...patch,
      ...(patch.progress
        ? {
            progress: {
              ...patch.progress,
              percent: Math.max(current.progress.percent, patch.progress.percent),
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.write(next);
    await this.connection.publish(UPDATE_CHANNEL, JSON.stringify(next));
    if (!isActive(next.state)) {
      await this.connection.srem(CLIENT_PREFIX + next.clientKey, next.id);
    }
    return next;
  }

  subscribe(id: string, listener: (record: JobRecord) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      const current = this.listeners.get(id);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(id);
    };
  }

  async waitingCount(): Promise<number> {
    return this.queue.getWaitingCount();
  }

  async activeCountFor(clientKey: string): Promise<number> {
    const ids = await this.connection.smembers(CLIENT_PREFIX + clientKey);
    if (!ids.length) return 0;

    const records = await Promise.all(ids.map((id) => this.get(id)));
    let count = 0;
    const stale: string[] = [];
    for (const [index, record] of records.entries()) {
      if (record && isActive(record.state)) count += 1;
      else stale.push(ids[index]!);
    }
    // Records expire before the set does; prune as we go rather than with a sweeper.
    if (stale.length) await this.connection.srem(CLIENT_PREFIX + clientKey, ...stale);
    return count;
  }

  startWorker(handler: JobHandler, concurrency: number): WorkerHandle {
    this.worker = new Worker<{ jobId: string }>(
      QUEUE_NAME,
      async (job: BullJob<{ jobId: string }>) => {
        const record = await this.get(job.data.jobId);
        if (!record) {
          this.logger.warn({ jobId: job.data.jobId }, 'queued job has no record; skipping');
          return;
        }
        await handler(record);
      },
      { connection: new Redis(this.connection.options), concurrency: Math.max(1, concurrency) },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.data.jobId }, 'worker reported failure');
    });

    return {
      close: async () => {
        await this.worker?.close();
      },
    };
  }

  async close(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue.close().catch(() => undefined);
    this.subscriber.disconnect();
    this.connection.disconnect();
  }

  private async write(record: JobRecord): Promise<void> {
    await this.connection.set(
      RECORD_PREFIX + record.id,
      JSON.stringify(record),
      'EX',
      this.recordTtlSeconds,
    );
  }
}
