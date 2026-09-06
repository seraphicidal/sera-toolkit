import { describe, expect, it } from 'vitest';
import { silentLogger } from '../logging.js';
import type { JobSpec } from '../jobs/runner.js';
import { MemoryJobBackend } from './memory.js';
import { isActive, toPublicJob, type JobRecord } from './types.js';

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

describe('MemoryJobBackend', () => {
  it('stores and returns a job', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    await backend.submit(record('a1'));
    expect((await backend.get('a1'))?.state).toBe('queued');
    expect(await backend.get('missing')).toBeUndefined();
    await backend.close();
  });

  it('applies patches and stamps the update time', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    await backend.submit(record('a2'));
    const before = (await backend.get('a2'))!.updatedAt;
    await wait(5);

    const patched = await backend.patch('a2', { state: 'downloading', step: 'Downloading' });
    expect(patched?.state).toBe('downloading');
    expect(patched?.updatedAt).not.toBe(before);
    await backend.close();
  });

  it('never lets progress move backwards', async () => {
    // Streams report independently, and a late update from a slower one must not rewind
    // a bar the user has already watched advance.
    const backend = new MemoryJobBackend(silentLogger());
    await backend.submit(record('a3'));

    await backend.patch('a3', { progress: { percent: 60 } });
    const regressed = await backend.patch('a3', { progress: { percent: 20 } });
    expect(regressed?.progress.percent).toBe(60);

    const advanced = await backend.patch('a3', { progress: { percent: 75 } });
    expect(advanced?.progress.percent).toBe(75);
    await backend.close();
  });

  it('notifies subscribers and stops after unsubscribing', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    await backend.submit(record('a4'));

    const seen: string[] = [];
    const unsubscribe = backend.subscribe('a4', (job) => seen.push(job.state));

    await backend.patch('a4', { state: 'downloading' });
    await backend.patch('a4', { state: 'ready' });
    unsubscribe();
    await backend.patch('a4', { state: 'failed' });

    expect(seen).toEqual(['downloading', 'ready']);
    await backend.close();
  });

  it('counts only jobs that are still occupying a slot', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    await backend.submit(record('b1', 'client-a'));
    await backend.submit(record('b2', 'client-a'));
    await backend.submit(record('b3', 'client-b'));

    expect(await backend.activeCountFor('client-a')).toBe(2);
    expect(await backend.activeCountFor('client-b')).toBe(1);

    await backend.patch('b1', { state: 'ready' });
    expect(await backend.activeCountFor('client-a')).toBe(1);
    await backend.close();
  });

  it('runs queued jobs through a handler, respecting concurrency', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    let running = 0;
    let peak = 0;
    const completed: string[] = [];

    const worker = backend.startWorker(async (job) => {
      running += 1;
      peak = Math.max(peak, running);
      await wait(40);
      completed.push(job.id);
      running -= 1;
      await backend.patch(job.id, { state: 'ready' });
    }, 2);

    for (const id of ['c1', 'c2', 'c3', 'c4']) await backend.submit(record(id));

    const deadline = Date.now() + 5000;
    while (completed.length < 4 && Date.now() < deadline) await wait(20);

    expect(completed.sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(peak).toBeLessThanOrEqual(2);
    await worker.close();
    await backend.close();
  });

  it('keeps processing after a handler throws', async () => {
    // One bad job must not stall the queue behind it.
    const backend = new MemoryJobBackend(silentLogger());
    const finished: string[] = [];

    const worker = backend.startWorker(async (job) => {
      if (job.id === 'd1') throw new Error('handler exploded');
      await wait(5);
      finished.push(job.id);
    }, 1);

    await backend.submit(record('d1'));
    await backend.submit(record('d2'));

    const deadline = Date.now() + 5000;
    while (!finished.includes('d2') && Date.now() < deadline) await wait(20);

    expect(finished).toContain('d2');
    await worker.close();
    await backend.close();
  });

  it('reports the waiting depth', async () => {
    const backend = new MemoryJobBackend(silentLogger());
    expect(await backend.waitingCount()).toBe(0);
    await backend.submit(record('e1'));
    await backend.submit(record('e2'));
    expect(await backend.waitingCount()).toBe(2);
    await backend.close();
  });
});

describe('job projection', () => {
  it('never sends the spec or the client key to a client', () => {
    // The spec holds the source URL, which is exactly what must not be echoed back.
    const publicJob = toPublicJob(record('f1')) as unknown as Record<string, unknown>;
    expect(publicJob).not.toHaveProperty('spec');
    expect(publicJob).not.toHaveProperty('clientKey');
    expect(JSON.stringify(publicJob)).not.toContain('example.com');
  });
});

describe('isActive', () => {
  it('treats every working state as active and every terminal one as not', () => {
    for (const state of [
      'queued',
      'resolving',
      'downloading',
      'merging',
      'converting',
      'packaging',
      'finalizing',
    ] as const) {
      expect(isActive(state), state).toBe(true);
    }
    for (const state of ['ready', 'failed', 'cancelled', 'expired'] as const) {
      expect(isActive(state), state).toBe(false);
    }
  });
});
