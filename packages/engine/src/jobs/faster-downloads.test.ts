import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { silentLogger } from '../logging.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from '../providers/types.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { JobRunner, type JobSpec } from './runner.js';
import { JobService } from './service.js';
import { MediaResolver } from '../resolver.js';
import { MemoryJobBackend } from '../queue/memory.js';
import * as ytdlpModule from '../extract/ytdlp.js';

const run = promisify(execFile);
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERA_SECRET: 'faster-downloads-secret',
  SERA_DATA_DIR: '.data/test',
  SERA_ITEM_CONCURRENCY: '2',
});

let dataDir: string;
let workspaces: WorkspaceManager;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-faster-'));
  workspaces = new WorkspaceManager(dataDir, 3600, silentLogger());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

async function realVideo(directory: string, name = 'media.mp4'): Promise<string> {
  const path = join(directory, name);
  await run(config.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:rate=5:duration=1',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  return path;
}

function plan(label: string): DownloadPlan {
  return {
    kind: 'video',
    container: 'mp4',
    label,
    requiresConversion: false,
    recommended: true,
    fetch: { via: 'ytdlp', selector: 'best' },
  };
}

const item0: ResolvedItem = {
  index: 0,
  kind: 'video',
  title: 'Item 1',
  plans: [plan('1080p')],
};

const item1: ResolvedItem = {
  index: 1,
  kind: 'video',
  title: 'Item 2',
  plans: [plan('1080p')],
};

const item2: ResolvedItem = {
  index: 2,
  kind: 'video',
  title: 'Item 3',
  plans: [plan('1080p')],
};

const item3: ResolvedItem = {
  index: 3,
  kind: 'video',
  title: 'Item 4',
  plans: [plan('1080p')],
};

const multiMedia: ResolvedMedia = {
  provider: 'youtube',
  providerLabel: 'YouTube',
  url: 'https://www.youtube.com/playlist?list=PL123',
  type: 'playlist',
  title: 'A playlist',
  items: [item0, item1, item2, item3],
};

describe('download acceleration and efficiency', () => {
  it('reuses spec.resolvedMedia without calling resolver.resolveCanonical when fresh', async () => {
    const resolveCanonical = vi.fn().mockRejectedValue(new Error('should not be called'));
    const runner = new JobRunner({
      config: { ...config, dataDir },
      logger: silentLogger(),
      resolver: { resolveCanonical, dispatcher: undefined } as never,
      workspaces,
    });

    const internals = runner as unknown as {
      fetchOne: (args: {
        plan: DownloadPlan;
        workspace: { scratchDir: string };
      }) => Promise<string>;
    };
    internals.fetchOne = (args) => realVideo(args.workspace.scratchDir);

    const spec: JobSpec = {
      jobId: '11111111111111111111111111111111',
      provider: 'youtube',
      url: multiMedia.url,
      selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
      packaging: 'auto',
      resolvedMedia: multiMedia,
      resolvedAt: Date.now() - 5_000,
    };

    const result = await runner.run(spec, () => undefined);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(resolveCanonical).not.toHaveBeenCalled();
  });

  it('falls back to resolver.resolveCanonical when spec.resolvedAt is older than 30 minutes', async () => {
    const resolveCanonical = vi.fn().mockResolvedValue(multiMedia);
    const runner = new JobRunner({
      config: { ...config, dataDir },
      logger: silentLogger(),
      resolver: { resolveCanonical, dispatcher: undefined } as never,
      workspaces,
    });

    const internals = runner as unknown as {
      fetchOne: (args: {
        plan: DownloadPlan;
        workspace: { scratchDir: string };
      }) => Promise<string>;
    };
    internals.fetchOne = (args) => realVideo(args.workspace.scratchDir);

    const spec: JobSpec = {
      jobId: '22222222222222222222222222222222',
      provider: 'youtube',
      url: multiMedia.url,
      selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
      packaging: 'auto',
      resolvedMedia: multiMedia,
      resolvedAt: Date.now() - 31 * 60_000,
    };

    const result = await runner.run(spec, () => undefined);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(resolveCanonical).toHaveBeenCalledTimes(1);
  });

  it('runs items with bounded concurrency, keeps progress monotonic, and preserves order', async () => {
    const runner = new JobRunner({
      config: { ...config, dataDir, itemConcurrency: 2 },
      logger: silentLogger(),
      resolver: {
        resolveCanonical: vi.fn().mockResolvedValue(multiMedia),
        dispatcher: undefined,
      } as never,
      workspaces,
    });

    let currentInFlight = 0;
    let maxInFlight = 0;
    const internals = runner as unknown as {
      fetchOne: (args: {
        plan: DownloadPlan;
        workspace: { scratchDir: string };
        index: number;
      }) => Promise<string>;
    };
    internals.fetchOne = async (args) => {
      currentInFlight++;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentInFlight--;
      return realVideo(args.workspace.scratchDir, `out-${args.index}.mp4`);
    };

    const percents: number[] = [];
    const spec: JobSpec = {
      jobId: '33333333333333333333333333333333',
      provider: 'youtube',
      url: multiMedia.url,
      selections: [
        { itemIndex: 0, planKey: 'video/mp4/1080p' },
        { itemIndex: 1, planKey: 'video/mp4/1080p' },
        { itemIndex: 2, planKey: 'video/mp4/1080p' },
        { itemIndex: 3, planKey: 'video/mp4/1080p' },
      ],
      packaging: 'individual',
      resolvedMedia: multiMedia,
      resolvedAt: Date.now(),
    };

    const result = await runner.run(spec, (update) => {
      percents.push(update.progress.percent);
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.files).toBeDefined();
    expect(result.files?.length).toBe(4);

    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
    }

    const names = result.files!.map((f) => f.name);
    expect(names[0]).toContain('Item 1');
    expect(names[1]).toContain('Item 2');
    expect(names[2]).toContain('Item 3');
    expect(names[3]).toContain('Item 4');
  });

  it('uses loadInfoJsonPath with ytdlp download and retries on 403', async () => {
    let callCount = 0;
    const pathsPassed: (string | undefined)[] = [];

    vi.spyOn(ytdlpModule, 'download').mockImplementation(async (req) => {
      callCount++;
      pathsPassed.push(req.loadInfoJsonPath);
      if (callCount === 1) {
        throw Object.assign(new Error('HTTP Error 403: Forbidden'), { code: 'NETWORK_ERROR' });
      }
      await realVideo(req.workdir, 'media.mp4');
    });

    const runner = new JobRunner({
      config: { ...config, dataDir },
      logger: silentLogger(),
      resolver: {
        resolveCanonical: vi.fn().mockResolvedValue(multiMedia),
        dispatcher: undefined,
      } as never,
      workspaces,
    });

    const spec: JobSpec = {
      jobId: '44444444444444444444444444444444',
      provider: 'youtube',
      url: multiMedia.url,
      selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
      packaging: 'auto',
      resolvedMedia: multiMedia,
      rawInfoJson: JSON.stringify({ id: 'test', title: 'test' }),
      resolvedAt: Date.now(),
    };

    const result = await runner.run(spec, () => undefined);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(callCount).toBe(2);
    expect(pathsPassed[0]).toContain('info.json');
    expect(pathsPassed[1]).toBeUndefined();
  });

  it('attaches cached resolution to spec in JobService.create', async () => {
    const resolver = new MediaResolver({ config, logger: silentLogger() });
    const info = resolver.toMediaInfo(multiMedia);
    resolver.setCached('youtube', multiMedia.url, {
      media: multiMedia,
      backend: 'local',
      networkClass: 'datacenter',
      remote: false,
      fallbackUsed: false,
      attempts: 1,
      rawInfoJson: '{"id":"xyz"}',
      resolvedAt: 123456789,
    });

    const backend = new MemoryJobBackend(silentLogger());
    const service = new JobService({
      config,
      logger: silentLogger(),
      resolver,
      workspaces,
      backend,
    });

    const job = await service.create(
      { infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] },
      'test-client',
    );

    const record = await backend.get(job.id);
    expect(record?.spec.resolvedMedia).toEqual(multiMedia);
    expect(record?.spec.rawInfoJson).toBe('{"id":"xyz"}');
    expect(record?.spec.resolvedAt).toBe(123456789);
  });
});
