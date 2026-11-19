import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { silentLogger } from '../logging.js';
import * as ytdlpModule from '../extract/ytdlp.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from '../providers/types.js';
import { sniffTextImposter } from '../util/sniff.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { JobRunner, sameHeightFallbackSelector } from './runner.js';

const run = promisify(execFile);
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERA_SECRET: 'delivery-secret',
  SERA_DATA_DIR: '.data/test',
});

let dataDir: string;
let workspaces: WorkspaceManager;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-delivery-'));
  workspaces = new WorkspaceManager(dataDir, 3600, silentLogger());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function plan(label: string, height: number): DownloadPlan {
  return {
    kind: 'video',
    container: 'mp4',
    label,
    height,
    requiresConversion: false,
    recommended: label === '1080p',
    fetch: { via: 'ytdlp', selector: `h:${String(height)}` },
  };
}

const item: ResolvedItem = {
  index: 0,
  kind: 'video',
  plans: [plan('1080p', 1080), plan('720p', 720), plan('480p', 480)],
};

const media: ResolvedMedia = {
  provider: 'youtube',
  providerLabel: 'YouTube',
  url: 'https://www.youtube.com/watch?v=x',
  type: 'single',
  title: 'A video',
  items: [item],
};

function runnerWith(fetchOne: (plan: DownloadPlan, scratch: string) => Promise<string>): JobRunner {
  const runner = new JobRunner({
    config: { ...config, dataDir },
    logger: silentLogger(),
    resolver: { resolveCanonical: () => Promise.resolve(media), dispatcher: undefined } as never,
    workspaces,
  });

  const internals = runner as unknown as {
    fetchOne: (args: { plan: DownloadPlan; workspace: { scratchDir: string } }) => Promise<string>;
  };
  internals.fetchOne = (args) => fetchOne(args.plan, args.workspace.scratchDir);
  return runner;
}

const spec = {
  jobId: 'cccccccccccccccccccccccccccccccc',
  provider: 'youtube',
  url: 'https://www.youtube.com/watch?v=x',
  selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
  packaging: 'auto' as const,
};

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

describe('a format that stops being available part-way through', () => {
  it('steps down to the next one this item already published', async () => {
    const asked: string[] = [];
    const runner = runnerWith(async (chosen, scratch) => {
      asked.push(chosen.label);
      if (chosen.label === '1080p') {
        throw Object.assign(new Error('Requested format is not available'), {
          code: 'PROVIDER_UNAVAILABLE',
        });
      }
      return realVideo(scratch);
    });

    const result = await runner.run(spec, () => undefined);

    expect(asked).toEqual(['1080p', '720p']);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.delivery?.substituted).toEqual([{ requested: '1080p', actual: '720p' }]);
    expect(result.delivery?.backend).toBe('local');
  }, 60_000);

  it('walks the whole list rather than giving up after one step', async () => {
    const asked: string[] = [];
    const runner = runnerWith(async (chosen, scratch) => {
      asked.push(chosen.label);
      if (chosen.label !== '480p') {
        throw Object.assign(new Error('HTTP Error 403: Forbidden'), { code: 'NETWORK_ERROR' });
      }
      return realVideo(scratch);
    });

    await runner.run(spec, () => undefined);
    expect(asked).toEqual(['1080p', '720p', '480p']);
  }, 60_000);

  it('does not step down for a failure a smaller format cannot answer', async () => {
    const asked: string[] = [];
    const runner = runnerWith((chosen) => {
      asked.push(chosen.label);
      return Promise.reject(
        Object.assign(new Error("Sign in to confirm you're not a bot"), { code: 'LOGIN_REQUIRED' }),
      );
    });

    await expect(runner.run(spec, () => undefined)).rejects.toThrow();
    expect(asked).toEqual(['1080p']);
  }, 60_000);

  it('never substitutes a different kind of media', async () => {
    const asked: string[] = [];
    const withAudio: ResolvedMedia = {
      ...media,
      items: [
        {
          ...item,
          plans: [
            plan('1080p', 1080),
            {
              kind: 'audio',
              container: 'mp3',
              label: 'MP3',
              requiresConversion: true,
              recommended: false,
              fetch: { via: 'ytdlp', selector: 'bestaudio' },
              convert: { kind: 'audio', container: 'mp3', bitrateKbps: 192 },
            },
          ],
        },
      ],
    };

    const runner = new JobRunner({
      config: { ...config, dataDir },
      logger: silentLogger(),
      resolver: {
        resolveCanonical: () => Promise.resolve(withAudio),
        dispatcher: undefined,
      } as never,
      workspaces,
    });
    (
      runner as unknown as { fetchOne: (args: { plan: DownloadPlan }) => Promise<string> }
    ).fetchOne = (args) => {
      asked.push(args.plan.label);
      return Promise.reject(
        Object.assign(new Error('Requested format is not available'), {
          code: 'PROVIDER_UNAVAILABLE',
        }),
      );
    };

    await expect(runner.run(spec, () => undefined)).rejects.toThrow();
    expect(asked).toEqual(['1080p']);
  }, 60_000);
});

describe('a refusal that arrives as a 200', () => {
  it('is caught by what the bytes are, not by what they are called', async () => {
    const runner = runnerWith(async (_chosen, scratch) => {
      const path = join(scratch, 'media.mp4');
      await writeFile(path, '<!DOCTYPE html>\n<html><head><title>Log in</title></head></html>');
      return path;
    });

    await expect(runner.run(spec, () => undefined)).rejects.toMatchObject({
      code: 'MEDIA_UNAVAILABLE',
    });
  }, 60_000);

  it('recognises the shapes a refusal actually arrives in', () => {
    expect(sniffTextImposter(Buffer.from('<!DOCTYPE html><html>'))).toBe('html');
    expect(sniffTextImposter(Buffer.from('  \n<html lang="en">'))).toBe('html');
    expect(sniffTextImposter(Buffer.from('﻿{"error":"login required"}'))).toBe('json');
    expect(sniffTextImposter(Buffer.from('<?xml version="1.0"?>'))).toBe('xml');
    expect(sniffTextImposter(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined();
    expect(sniffTextImposter(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe(
      undefined,
    );
    expect(sniffTextImposter(Buffer.alloc(0))).toBeUndefined();
  });

  it('lets a real file through untouched', async () => {
    const runner = runnerWith((_chosen, scratch) => realVideo(scratch));
    const result = await runner.run(spec, () => undefined);
    const bytes = await readFile(join(dataDir, spec.jobId, 'out', result.filename));
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(result.delivery?.substituted).toBeUndefined();
  }, 60_000);
});

describe('same-height stream fallback', () => {
  it('builds container-aware same-height fallback selectors for pinned format ids', () => {
    const mp4 = sameHeightFallbackSelector({
      kind: 'video',
      container: 'mp4',
      label: '720p',
      height: 720,
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'ytdlp', selector: '311+140-13', merge: 'mp4' },
    });
    expect(mp4).toContain('bestvideo[height=720][protocol^=http][vcodec^=avc]+140-13');
    expect(mp4).toContain('best[height=720]');

    const mov = sameHeightFallbackSelector({
      kind: 'video',
      container: 'mov',
      label: '1080p (MOV)',
      height: 1080,
      requiresConversion: false,
      recommended: false,
      fetch: { via: 'ytdlp', selector: '312+140-13', merge: 'mp4', remux: 'mov' },
    });
    expect(mov).toContain("[vcodec~='^(avc|h264|hev|hvc)']+140-13");

    expect(
      sameHeightFallbackSelector({
        kind: 'video',
        container: 'mp4',
        label: '720p',
        height: 720,
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'ytdlp', selector: 'bestvideo+bestaudio/best' },
      }),
    ).toBeUndefined();
  });

  it('falls back to another stream at the same height before stepping down resolution', async () => {
    const formatsTried: string[] = [];
    vi.spyOn(ytdlpModule, 'download').mockImplementation(async (req) => {
      formatsTried.push(req.format);
      if (req.format === '311+140-13') {
        throw Object.assign(new Error('Requested format is not available'), {
          code: 'MEDIA_UNAVAILABLE',
        });
      }
      await realVideo(req.workdir, 'media.mp4');
    });

    const mediaWithPinned720: ResolvedMedia = {
      ...media,
      items: [
        {
          index: 0,
          kind: 'video',
          plans: [
            {
              kind: 'video',
              container: 'mp4',
              label: '720p',
              height: 720,
              requiresConversion: false,
              recommended: true,
              fetch: { via: 'ytdlp', selector: '311+140-13', merge: 'mp4' },
            },
            {
              kind: 'video',
              container: 'mp4',
              label: '480p',
              height: 480,
              requiresConversion: false,
              recommended: false,
              fetch: { via: 'ytdlp', selector: '231+140-13', merge: 'mp4' },
            },
          ],
        },
      ],
    };

    const runner = new JobRunner({
      config: { ...config, dataDir },
      logger: silentLogger(),
      resolver: {
        resolveCanonical: () => Promise.resolve(mediaWithPinned720),
        dispatcher: undefined,
      } as never,
      workspaces,
    });

    const result = await runner.run(
      {
        jobId: 'dddddddddddddddddddddddddddddddd',
        provider: 'youtube',
        url: media.url,
        selections: [{ itemIndex: 0, planKey: 'video/mp4/720p' }],
        packaging: 'auto',
      },
      () => undefined,
    );

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.delivery?.substituted).toBeUndefined();
    expect(formatsTried).toHaveLength(2);
    expect(formatsTried[0]).toBe('311+140-13');
    expect(formatsTried[1]).toContain('bestvideo[height=720]');
  }, 60_000);
});
