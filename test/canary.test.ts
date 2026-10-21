import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { isCanaryToken } from '../apps/api/src/plugins/client.js';
import { canaryCases, runCanary, smallestOption, type CanaryCase } from '../apps/api/src/canary.js';
import { ensureFixtures, ffmpegPath, ffprobePath } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

const TOKEN = 'canary-token-0123456789abcdef';

let origin: MediaServer;
let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;
let apiUrl: string;

beforeAll(async () => {
  const fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-canary-'));
  origin = new MediaServer({
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    '/gone.mp4': { status: 404 },
  });
  await origin.start();

  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'canary-secret',
      SERA_DATA_DIR: dataDir,
      SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
      SERA_FFMPEG_PATH: ffmpegPath,
      SERA_FFPROBE_PATH: ffprobePath,
      SERA_CANARY_TOKEN: TOKEN,
      SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '2',
    }),
  });
  app = await buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  engine.startWorker(1);
  const address = app.server.address();
  apiUrl = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

const direct = (id: string, path: string): CanaryCase => ({
  id,
  url: origin.url(path),
  canary: { label: `Source ${id}`, kind: 'video' },
});

describe('runCanary', () => {
  it('downloads a working source through the API and reports the bytes', async () => {
    const [result] = await runCanary({
      apiUrl,
      token: TOKEN,
      cases: [direct('direct', '/clip.mp4')],
      pollMs: 100,
    });
    expect(result).toMatchObject({ source: 'direct', label: 'Source direct', ok: true });
    expect(result?.bytes).toBeGreaterThan(1000);
    expect(Number.isNaN(Date.parse(result!.at))).toBe(false);
  });

  it("reports a broken source by the API's own error code, and carries on", async () => {
    const results = await runCanary({
      apiUrl,
      token: TOKEN,
      cases: [direct('gone', '/gone.mp4'), direct('direct', '/clip.mp4')],
      pollMs: 100,
    });
    expect(results.map((r) => [r.source, r.ok])).toEqual([
      ['gone', false],
      ['direct', true],
    ]);
    expect(results[0]?.code).toBe('MEDIA_UNAVAILABLE');
  });

  it('gives up on a source at its timeout instead of hanging the run', async () => {
    const [result] = await runCanary({
      apiUrl,
      token: TOKEN,
      cases: [direct('stuck', '/clip.mp4')],
      timeoutMs: 200,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(result?.durationMs).toBeLessThan(5000);
  });
});

describe('the canary exemption', () => {
  const resolveWith = (headers: Record<string, string>, url = origin.url('/clip.mp4')) =>
    app.inject({ method: 'POST', url: '/api/media/info', headers, payload: { url } });

  it('is never rate-limited, where a visitor is', async () => {
    for (let i = 0; i < 4; i += 1) {
      expect((await resolveWith({ 'x-sera-canary': TOKEN })).statusCode).toBe(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await resolveWith({ 'x-forwarded-for': '203.0.113.7' })).statusCode);
    }
    expect(statuses).toContain(429);
  });

  it('earns no abuse strikes, however often a source fails', async () => {
    for (let i = 0; i < 14; i += 1) {
      const response = await resolveWith({ 'x-sera-canary': TOKEN }, 'not a link');
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_URL');
    }
    expect((await resolveWith({ 'x-sera-canary': TOKEN })).json<MediaInfo>().items).toHaveLength(1);
  });

  it('needs the exact token', () => {
    expect(isCanaryToken(TOKEN, TOKEN)).toBe(true);
    expect(isCanaryToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(isCanaryToken('', TOKEN)).toBe(false);
    expect(isCanaryToken(undefined, TOKEN)).toBe(false);
    expect(isCanaryToken(['a', 'b'], TOKEN)).toBe(false);
    expect(isCanaryToken('', '')).toBe(false);
    expect(isCanaryToken('anything', '')).toBe(false);
  });
});

describe('the canary links', () => {
  it('are the provider cases marked for it, each with a label and a kind', async () => {
    const all = JSON.parse(
      await readFile(new URL('../scripts/provider-cases.json', import.meta.url), 'utf8'),
    ) as unknown[];
    const cases = canaryCases(all);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.map((entry) => entry.canary.label)).toContain('YouTube');
    expect(cases.some((entry) => entry.id.startsWith('instagram'))).toBe(false);
  });

  it('pick the smallest option of the kind asked for', () => {
    const option = (id: string, kind: string, filesizeBytes?: number) =>
      ({ id, kind, filesizeBytes }) as MediaInfo['items'][number]['options'][number];
    const info = {
      items: [
        {
          options: [
            option('v1080', 'video', 900),
            option('v144', 'video', 50),
            option('mp3', 'audio'),
          ],
        },
      ],
    } as unknown as MediaInfo;
    expect(smallestOption(info, 'video')?.id).toBe('v144');
    expect(smallestOption(info, 'audio')?.id).toBe('mp3');
    expect(smallestOption(info, 'image')).toBeUndefined();
  });
});
