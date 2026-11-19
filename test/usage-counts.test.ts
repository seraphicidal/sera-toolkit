import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job, MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine, type SourceUsage, type UsageDay } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { formatUsage } from '../apps/api/src/stats.js';
import { ensureFixtures, ffmpegPath, ffprobePath, type Fixtures } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

const ADMIN = 'admin-token-0123456789abcdef0123456789';
const CANARY = 'canary-token-0123456789abcdef012345678';

let origin: MediaServer;
let fixtures: Fixtures;
let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

const env = (extra: Record<string, string>) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'usage-secret',
    SERA_DATA_DIR: dataDir,
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    SERA_FFMPEG_PATH: ffmpegPath,
    SERA_FFPROBE_PATH: ffprobePath,
    SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '1000',
    SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
    SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '10',
    ...extra,
  });

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-usage-'));
  origin = new MediaServer({ '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' } });
  await origin.start();
  engine = await SeraEngine.create({
    config: env({ SERA_ADMIN_TOKEN: ADMIN, SERA_CANARY_TOKEN: CANARY }),
  });
  app = await buildServer(engine);
  engine.startWorker(1);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

async function usage(): Promise<{ days: UsageDay[]; totals: Record<string, SourceUsage> }> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/admin/usage?days=7',
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function visit(headers: Record<string, string> = {}): Promise<number> {
  const resolved = await app.inject({
    method: 'POST',
    url: '/api/media/info',
    headers,
    payload: { url: origin.url('/clip.mp4') },
  });
  expect(resolved.statusCode, resolved.body).toBe(200);
  const info = resolved.json<MediaInfo>();
  const option = info.items[0]!.options.find((candidate) => candidate.label === 'Original')!;

  const created = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers,
    payload: { infoId: info.id, optionIds: [option.id] },
  });
  expect(created.statusCode, created.body).toBe(202);
  let job = created.json<Job>();
  const deadline = Date.now() + 60_000;
  while (!['ready', 'failed'].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}` })).json<Job>();
  }
  expect(job.state).toBe('ready');
  const download = await app.inject({ method: 'GET', url: job.result!.downloadPath, headers });
  expect(download.statusCode).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return download.rawPayload.length;
}

describe('a visitor', () => {
  it('is counted by source: a resolve, a download and its bytes', async () => {
    const before = (await usage()).totals.direct;
    const bytes = await visit();
    const after = (await usage()).totals.direct!;

    expect(after.resolves.ok - (before?.resolves.ok ?? 0)).toBe(1);
    expect(after.downloads.ok - (before?.downloads.ok ?? 0)).toBe(1);
    expect(after.bytes - (before?.bytes ?? 0)).toBe(bytes);
    expect(bytes).toBe((await stat(fixtures.video)).size);
  });

  it('is counted by error code when a link fails, without the link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/missing-file.mp4') },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const { code } = response.json<{ error: { code: string } }>().error;

    const counted = await usage();
    expect(counted.totals.direct!.resolves.failed[code]).toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(counted);
    expect(raw).not.toContain('missing-file');
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('clip');
  });
});

describe('the canary', () => {
  it('is not counted at all', async () => {
    const before = JSON.stringify((await usage()).totals);
    await visit({ 'x-sera-canary': CANARY });
    expect(JSON.stringify((await usage()).totals)).toBe(before);
  });
});

describe('the admin endpoint', () => {
  it('refuses a missing or wrong token, in the same words', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Basic ${ADMIN}`]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/usage',
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    }
  });

  it('answers 7 days by default, newest first, and refuses more than 90', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/usage',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const days = response.json<{ days: UsageDay[] }>().days;
    expect(days).toHaveLength(7);
    expect(days[0]!.date).toBe(new Date().toISOString().slice(0, 10));
    const tooMany = await app.inject({
      method: 'GET',
      url: '/api/admin/usage?days=91',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('does not exist without a token configured', async () => {
    const closed = await SeraEngine.create({ config: env({}) });
    const closedApp = await buildServer(closed);
    try {
      const response = await closedApp.inject({
        method: 'GET',
        url: '/api/admin/usage',
        headers: { authorization: 'Bearer ' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await closedApp.close();
      await closed.close();
    }
  });
});

describe('sera stats', () => {
  it('prints a table per source and per day', () => {
    const day = (date: string, sources: UsageDay['sources']): UsageDay => ({ date, sources });
    const youtube = {
      resolves: { ok: 10, failed: { SOURCE_BLOCKED: 2 } },
      downloads: { ok: 7, failed: { TIMEOUT: 1 } },
      bytes: 3 * 1024 * 1024,
    };
    const days = [day('2026-10-04', { youtube }), day('2026-10-03', {})];
    const text = formatUsage(days, { youtube });

    expect(text).toContain('SERA usage, 2026-10-03 to 2026-10-04 (UTC)');
    const row = text.split('\n').find((line) => line.startsWith('youtube'))!;
    expect(row.split(/\s{2,}/)).toEqual([
      'youtube',
      '12',
      '2',
      '8',
      '1',
      '3.0 MB',
      'SOURCE_BLOCKED 2, TIMEOUT 1',
    ]);
    expect(text).toMatch(/^2026-10-03\s+0\s+0\s+0\s+0\s+0$/m);
  });

  it('says so when nothing was counted', () => {
    expect(formatUsage([{ date: '2026-10-04', sources: {} }], {})).toContain(
      'Nothing counted in this period.',
    );
  });
});
