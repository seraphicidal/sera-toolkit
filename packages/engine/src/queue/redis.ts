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

export const QUEUE_NAME = 'sera-jobs';

const RECORD_PREFIX = 'sera:job:';
const CLIENT_PREFIX = 'sera:client:';
const UPDATE_CHANNEL = 'sera:job-updates';

const PATCH_LUA = `
local raw = redis.call('get', KEYS[1])
if not raw then return nil end
local current = cjson.decode(raw)
if current.state == 'ready' or current.state == 'failed' or current.state == 'cancelled' or current.state == 'expired' then
  return raw
end
local patch = cjson.decode(ARGV[1])
for k, v in pairs(patch) do
  if k ~= 'progress' then current[k] = v end
end
if patch.progress then
  if not current.progress then current.progress = {} end
  local maxPercent = current.progress.percent or 0
  if patch.progress.percent and patch.progress.percent > maxPercent then
    maxPercent = patch.progress.percent
  end
  for pk, pv in pairs(patch.progress) do
    current.progress[pk] = pv
  end
  current.progress.percent = maxPercent
end
current.updatedAt = ARGV[4]
local encoded = cjson.encode(current)
redis.call('set', KEYS[1], encoded, 'EX', ARGV[2])
redis.call('publish', ARGV[3], encoded)
if current.state ~= 'queued' and current.state ~= 'resolving' and current.state ~= 'downloading' and current.state ~= 'merging' and current.state ~= 'converting' and current.state ~= 'packaging' and current.state ~= 'finalizing' then
  redis.call('srem', KEYS[2] .. current.clientKey, current.id)
end
return encoded
`;

export class RedisJobBackend implements JobBackend {
  readonly driver = 'redis' as const;

  private readonly connection: Redis;
  private readonly subscriber: Redis;
  private readonly queue: Queue<{ jobId: string }>;
  private readonly listeners = new Map<string, Set<(record: JobRecord) => void>>();
  private worker: Worker<{ jobId: string }> | undefined;
  private workerConnection: Redis | undefined;
  private readonly subscribed: Promise<void>;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
    private readonly recordTtlSeconds = 24 * 60 * 60,
  ) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', (error: unknown) => {
      this.logger.warn({ err: error }, 'redis connection error');
    });
    this.subscriber.on('error', (error: unknown) => {
      this.logger.warn({ err: error }, 'redis subscriber error');
    });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });

    this.subscribed = this.subscriber.subscribe(UPDATE_CHANNEL).then(
      () => undefined,
      (error: unknown) => {
        this.logger.error({ err: error }, 'failed to subscribe to job updates');
      },
    );
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
    const key = RECORD_PREFIX + id;
    const res = await this.connection.eval(
      PATCH_LUA,
      2,
      key,
      CLIENT_PREFIX,
      JSON.stringify(patch),
      this.recordTtlSeconds,
      UPDATE_CHANNEL,
      new Date().toISOString(),
    );
    if (typeof res !== 'string') return undefined;
    try {
      return JSON.parse(res) as JobRecord;
    } catch {
      return undefined;
    }
  }

  ready(): Promise<void> {
    return this.subscribed;
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
    if (stale.length) await this.connection.srem(CLIENT_PREFIX + clientKey, ...stale);
    return count;
  }

  startWorker(handler: JobHandler, concurrency: number): WorkerHandle {
    const workerConnection = new Redis(this.connection.options);
    workerConnection.on('error', (error: unknown) => {
      this.logger.warn({ err: error }, 'redis worker connection error');
    });
    this.workerConnection = workerConnection;
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
      { connection: workerConnection, concurrency: Math.max(1, concurrency) },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.data.jobId }, 'worker reported failure');
    });

    return {
      close: async () => {
        await this.worker?.close();
        this.workerConnection?.disconnect();
        this.workerConnection = undefined;
      },
    };
  }

  async close(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    this.workerConnection?.disconnect();
    this.workerConnection = undefined;
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
