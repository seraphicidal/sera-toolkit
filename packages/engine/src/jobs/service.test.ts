import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
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
});
