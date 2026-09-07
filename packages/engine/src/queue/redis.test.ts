import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { silentLogger } from '../logging.js';
import type { JobSpec } from '../jobs/runner.js';
import { QUEUE_NAME, RedisJobBackend } from './redis.js';
import type { JobRecord } from './types.js';

/**
 * Naming rules for the Redis backend.
 *
 * These look trivial, and one of them shipped broken anyway: the queue was originally
 * `sera:jobs`, which BullMQ rejects in its constructor. Nothing caught it because the
 * Redis driver is the one path the offline suite cannot exercise, so the failure surfaced
 * as a container restart loop on a freshly provisioned server.
 */
describe('queue naming', () => {
  it('has no colon, which BullMQ rejects', () => {
    // BullMQ builds its own key namespace by joining on ':', so a colon in the queue
    // name would collide with its internal layout. It throws from `new Queue(...)`.
    expect(QUEUE_NAME).not.toContain(':');
  });

  it('is a plain identifier', () => {
    // Whitespace and wildcards are equally unwelcome in something used to build keys.
    expect(QUEUE_NAME).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('is still namespaced to this application', () => {
    // The queue shares a Redis instance with the job records; a generic name like
    // "jobs" would collide with anything else pointed at the same server.
    expect(QUEUE_NAME.startsWith('sera')).toBe(true);
  });
});

/**
 * The rest of the file needs a real Redis, because the failures worth catching here —
 * BullMQ's constructor validation, cross-connection pub/sub, custom job ids — are exactly
 * the ones a mock reproduces incorrectly.
 *
 *   SERA_TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
 *
 * The database is flushed before the suite runs, so point it at a throwaway instance.
 */
const REDIS_URL = process.env.SERA_TEST_REDIS_URL;

function record(id: string, clientKey = 'client-a'): JobRecord {
  const spec: JobSpec = {
    jobId: id,
    provider: 'direct',
    url: 'https://example.com/a.mp4',
    selections: [{ itemIndex: 0, planKey: 'video/mp4/Original' }],
    packaging: 'auto',
  };
  const now = new Date().toISOString();
  return {
    id,
    state: 'queued',
    step: 'Waiting to start',
    progress: { percent: 0 },
    provider: 'direct',
    createdAt: now,
    updatedAt: now,
    spec,
    clientKey,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls rather than sleeping a fixed amount, so a slow Redis does not flake. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error('condition not met within ' + String(timeoutMs) + 'ms');
}

describe.skipIf(!REDIS_URL)('RedisJobBackend against a live Redis', () => {
  let backend: RedisJobBackend;

  beforeAll(async () => {
    const admin = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await admin.flushdb();
    admin.disconnect();
    backend = new RedisJobBackend(REDIS_URL!, silentLogger());
  });

  afterAll(async () => {
    await backend?.close();
  });

  it('constructs without BullMQ rejecting the queue name', () => {
    // The regression that broke the first deployment: `new Queue('sera:jobs')` throws,
    // so the backend never finished construction and the API crash-looped.
    expect(backend.driver).toBe('redis');
  });

  it('accepts our job ids as BullMQ custom ids', async () => {
    // BullMQ also rejects custom ids containing ':' and ids that round-trip through
    // parseInt. Job ids are dashless UUIDs, but that is worth pinning down here rather
    // than in a comment.
    const id = 'a'.repeat(32);
    await backend.submit(record(id));
    expect((await backend.get(id))?.state).toBe('queued');
  });

  it('round-trips a record through Redis', async () => {
    await backend.submit(record('b1'));
    const stored = await backend.get('b1');
    expect(stored?.spec.url).toBe('https://example.com/a.mp4');
    expect(stored?.clientKey).toBe('client-a');
    expect(await backend.get('missing')).toBeUndefined();
  });

  it('publishes patches to a subscriber', async () => {
    // The fan-out that matters in production: the worker patches, and an API process
    // holding the client's event stream has to hear about it over pub/sub.
    await backend.submit(record('b2'));
    const seen: JobRecord[] = [];
    const unsubscribe = backend.subscribe('b2', (r) => seen.push(r));

    await backend.patch('b2', { state: 'downloading', step: 'Downloading' });
    await until(() => seen.length > 0);

    expect(seen[0]?.state).toBe('downloading');
    unsubscribe();

    await backend.patch('b2', { state: 'converting', step: 'Converting' });
    await wait(200);
    expect(seen).toHaveLength(1);
  });

  it('never lets progress move backwards', async () => {
    await backend.submit(record('b3'));
    await backend.patch('b3', { progress: { percent: 60 } });
    const regressed = await backend.patch('b3', { progress: { percent: 20 } });
    expect(regressed?.progress.percent).toBe(60);
  });

  it('counts a client only while its jobs are active', async () => {
    await backend.submit(record('b4', 'client-b'));
    await backend.submit(record('b5', 'client-b'));
    expect(await backend.activeCountFor('client-b')).toBe(2);

    await backend.patch('b4', { state: 'ready' });
    expect(await backend.activeCountFor('client-b')).toBe(1);

    await backend.patch('b5', { state: 'failed' });
    expect(await backend.activeCountFor('client-b')).toBe(0);
    expect(await backend.activeCountFor('client-never-seen')).toBe(0);
  });

  it('hands queued jobs to a worker', async () => {
    // End to end through BullMQ itself, which is the part that was never exercised.
    const handled: string[] = [];
    const worker = backend.startWorker((r) => {
      handled.push(r.id);
      return Promise.resolve();
    }, 1);

    await backend.submit(record('b6', 'client-c'));
    await until(() => handled.includes('b6'), 15_000);

    await worker.close();
  }, 20_000);

  it('refuses to move a job out of a terminal state', async () => {
    await backend.submit(record('b7'));
    await backend.patch('b7', { state: 'cancelled', step: 'Cancelled' });
    const late = await backend.patch('b7', { state: 'failed', step: 'Failed' });
    expect(late?.state).toBe('cancelled');
    expect((await backend.get('b7'))?.state).toBe('cancelled');
  });

  it('carries a cancellation to a second process', async () => {
    // The deployment shape this exists for: the API that handles DELETE /api/jobs/:id is
    // not the container running the job. Cancelling has to reach the worker over Redis,
    // or the worker keeps going, finds its workspace deleted, and reports a failure.
    const worker = new RedisJobBackend(REDIS_URL!, silentLogger());
    try {
      await backend.submit(record('b8'));

      const seen: string[] = [];
      worker.subscribe('b8', (r) => seen.push(r.state));

      await backend.patch('b8', { state: 'cancelled', step: 'Cancelled' });
      await until(() => seen.includes('cancelled'), 5000);
    } finally {
      await worker.close();
    }
  });

  it('reports the waiting count', async () => {
    expect(await backend.waitingCount()).toBeGreaterThanOrEqual(0);
  });
});
