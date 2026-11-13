import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { SeraEngine } from '../engine.js';
import { silentLogger } from '../logging.js';
import { JobService } from './service.js';
import { MemoryJobBackend } from '../queue/memory.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { lowerQualityAlternatives } from './runner.js';
import type { DownloadPlan, ResolvedItem } from '../providers/types.js';
import type { JobRecord } from '../queue/types.js';
import { seraError } from '../errors.js';
import type { MediaResolver } from '../resolver.js';
import type { UsageCounter } from '../usage/counts.js';
import type { JobRunner, ReportFn, JobSpec } from './runner.js';

describe('lowerQualityAlternatives', () => {
  it('caps alternatives at the 2 nearest lower qualities', () => {
    const plans: DownloadPlan[] = [
      {
        kind: 'video',
        container: 'mp4',
        label: '1080p',
        height: 1080,
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'ytdlp', selector: 'b:1080' },
      },
      {
        kind: 'video',
        container: 'mp4',
        label: '720p',
        height: 720,
        requiresConversion: false,
        recommended: false,
        fetch: { via: 'ytdlp', selector: 'b:720' },
      },
      {
        kind: 'video',
        container: 'mp4',
        label: '480p',
        height: 480,
        requiresConversion: false,
        recommended: false,
        fetch: { via: 'ytdlp', selector: 'b:480' },
      },
      {
        kind: 'video',
        container: 'mp4',
        label: '360p',
        height: 360,
        requiresConversion: false,
        recommended: false,
        fetch: { via: 'ytdlp', selector: 'b:360' },
      },
      {
        kind: 'video',
        container: 'mp4',
        label: '240p',
        height: 240,
        requiresConversion: false,
        recommended: false,
        fetch: { via: 'ytdlp', selector: 'b:240' },
      },
    ];
    const item: ResolvedItem = { index: 0, kind: 'video', plans };
    const alternatives = lowerQualityAlternatives(item, plans[0]!);
    expect(alternatives.map((p) => p.label)).toEqual(['720p', '480p']);
  });
});

describe('JobService timeout and cancellation', () => {
  it('fails a timed-out job with TIMEOUT error and counts the failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-srv-test-'));
    try {
      const baseConfig = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'srv-test-secret',
        SERA_DATA_DIR: dir,
        SERA_JOB_TIMEOUT_SECONDS: '1',
      });
      const config = { ...baseConfig, jobTimeoutSeconds: 0.1 };
      const backend = new MemoryJobBackend(silentLogger());
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const counted: unknown[] = [];
      const service = new JobService({
        config,
        logger: silentLogger(),
        resolver: {} as unknown as MediaResolver,
        workspaces,
        backend,
        runner: {
          run: async (_spec: JobSpec, _report: ReportFn, signal?: AbortSignal) => {
            return new Promise((_, reject) => {
              signal?.addEventListener('abort', () => reject(seraError('CANCELLED')));
            });
          },
        } as unknown as JobRunner,
        usage: {
          record: (u: unknown) => {
            counted.push(u);
            return Promise.resolve();
          },
        } as unknown as UsageCounter,
      });

      const now = new Date().toISOString();
      const id = '1'.repeat(32);
      const record: JobRecord = {
        id,
        state: 'queued',
        step: 'Waiting',
        progress: { percent: 0 },
        provider: 'youtube',
        createdAt: now,
        updatedAt: now,
        spec: {
          jobId: id,
          provider: 'youtube',
          url: 'https://youtube.com/watch?v=abc',
          selections: [{ itemIndex: 0, planKey: '1080p' }],
          packaging: 'auto',
        },
        clientKey: 'client-test',
      };

      await backend.submit(record);
      await (service as unknown as { execute: (r: JobRecord) => Promise<void> }).execute(record);

      const finalRecord = await backend.get(id);
      expect(finalRecord?.state).toBe('failed');
      expect(finalRecord?.error?.code).toBe('TIMEOUT');
      expect(counted.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('marks a cancelled job as cancelled and does not count it as a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-srv-test-'));
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'srv-test-secret',
        SERA_DATA_DIR: dir,
        SERA_JOB_TIMEOUT_SECONDS: '10',
      });
      const backend = new MemoryJobBackend(silentLogger());
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const counted: unknown[] = [];
      const service = new JobService({
        config,
        logger: silentLogger(),
        resolver: {} as unknown as MediaResolver,
        workspaces,
        backend,
        runner: {
          run: async (_spec: JobSpec, _report: ReportFn, signal?: AbortSignal) => {
            return new Promise((_, reject) => {
              signal?.addEventListener('abort', () => reject(seraError('CANCELLED')));
            });
          },
        } as unknown as JobRunner,
        usage: {
          record: (u: unknown) => {
            counted.push(u);
            return Promise.resolve();
          },
        } as unknown as UsageCounter,
      });

      const now = new Date().toISOString();
      const id = '2'.repeat(32);
      const record: JobRecord = {
        id,
        state: 'queued',
        step: 'Waiting',
        progress: { percent: 0 },
        provider: 'youtube',
        createdAt: now,
        updatedAt: now,
        spec: {
          jobId: id,
          provider: 'youtube',
          url: 'https://youtube.com/watch?v=abc',
          selections: [{ itemIndex: 0, planKey: '1080p' }],
          packaging: 'auto',
        },
        clientKey: 'client-test',
      };

      await backend.submit(record);
      const execution = (
        service as unknown as { execute: (r: JobRecord) => Promise<void> }
      ).execute(record);
      setTimeout(() => void service.cancel(id), 20);
      await execution;

      const finalRecord = await backend.get(id);
      expect(finalRecord?.state).toBe('cancelled');
      expect(counted).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('deletes an existing job and destroys its workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-srv-test-'));
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'srv-test-secret',
        SERA_DATA_DIR: dir,
      });
      const backend = new MemoryJobBackend(silentLogger());
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const service = new JobService({
        config,
        logger: silentLogger(),
        resolver: {} as unknown as MediaResolver,
        workspaces,
        backend,
      });

      const now = new Date().toISOString();
      const id = '3'.repeat(32);
      const record: JobRecord = {
        id,
        state: 'ready',
        step: 'Complete',
        progress: { percent: 100 },
        provider: 'youtube',
        createdAt: now,
        updatedAt: now,
        spec: {
          jobId: id,
          provider: 'youtube',
          url: 'https://youtube.com/watch?v=abc',
          selections: [{ itemIndex: 0, planKey: '1080p' }],
          packaging: 'auto',
        },
        clientKey: 'client-test',
      };

      await backend.submit(record);
      await workspaces.create(id);
      const deleted = await service.delete(id);
      expect(deleted).toBe(true);

      const missingDeleted = await service.delete('4'.repeat(32));
      expect(missingDeleted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('transitions ready jobs to expired without affecting cancelled jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-srv-test-'));
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'srv-test-secret',
        SERA_DATA_DIR: dir,
      });
      const backend = new MemoryJobBackend(silentLogger());
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const service = new JobService({
        config,
        logger: silentLogger(),
        resolver: {} as unknown as MediaResolver,
        workspaces,
        backend,
      });

      const now = new Date().toISOString();
      const readyId = '5'.repeat(32);
      const cancelledId = '6'.repeat(32);
      const makeRecord = (id: string, state: JobRecord['state']): JobRecord => ({
        id,
        state,
        step: state === 'ready' ? 'Complete' : 'Cancelled',
        progress: { percent: state === 'ready' ? 100 : 0 },
        provider: 'youtube',
        createdAt: now,
        updatedAt: now,
        spec: {
          jobId: id,
          provider: 'youtube',
          url: 'https://youtube.com/watch?v=abc',
          selections: [{ itemIndex: 0, planKey: '1080p' }],
          packaging: 'auto',
        },
        clientKey: 'client-test',
      });

      await backend.submit(makeRecord(readyId, 'ready'));
      await backend.submit(makeRecord(cancelledId, 'cancelled'));

      const expired = await service.markExpired(readyId);
      expect(expired?.state).toBe('expired');
      expect((await backend.get(readyId))?.state).toBe('expired');

      const stillCancelled = await service.markExpired(cancelledId);
      expect(stillCancelled?.state).toBe('cancelled');
      expect((await backend.get(cancelledId))?.state).toBe('cancelled');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('serializes per-client slot checks across concurrent create calls', async () => {
    class DelayedCountBackend extends MemoryJobBackend {
      override async activeCountFor(clientKey: string): Promise<number> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.activeCountFor(clientKey);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'sera-srv-race-'));
    let engine: SeraEngine | undefined;
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'srv-race-secret',
        SERA_DATA_DIR: dir,
        SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '1',
      });
      const backend = new DelayedCountBackend(silentLogger());
      engine = await SeraEngine.create({
        config,
        logger: silentLogger(),
        backend,
      });

      const info = engine.resolver.importSubmitted({
        url: 'https://www.instagram.com/p/RaceTestPost1/',
        node: {
          code: 'RaceTestPost1',
          media_type: 1,
          image_versions2: {
            candidates: [
              {
                url: 'https://scontent-vie1-1.cdninstagram.com/v/t51/a.jpg',
                width: 640,
                height: 480,
              },
            ],
          },
        },
      });
      const optionId = info.items[0]!.options[0]!.id;
      const request = { infoId: info.id, optionIds: [optionId] };

      const results = await Promise.allSettled([
        engine.jobs.create(request, 'race-client'),
        engine.jobs.create(request, 'race-client'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'RATE_LIMITED' });
      expect(await backend.activeCountFor('race-client')).toBe(1);
    } finally {
      await engine?.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
