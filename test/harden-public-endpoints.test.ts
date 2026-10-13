import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthReport } from '@sera/contracts/types';
import { loadConfig, resetVersionCache, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { ensureFixtures, ffmpegPath, ffprobePath, type Fixtures } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

let engine: SeraEngine;
let app: FastifyInstance;
let origin: MediaServer;
let fixtures: Fixtures;
let dataDir: string;

const ADMIN_TOKEN = 'test-admin-token-12345';
const CANARY_TOKEN = 'test-canary-token-67890';

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-harden-'));

  origin = new MediaServer({
    '/photo.jpg': {
      file: fixtures.image,
      contentType: 'image/jpeg',
    },
    '/redirect-blocked': {
      redirectTo: 'http://blocked.test/forbidden.jpg',
    },
  });
  await origin.start();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'harden-suite-secret',
    SERA_DATA_DIR: dataDir,
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    SERA_ADMIN_TOKEN: ADMIN_TOKEN,
    SERA_CANARY_TOKEN: CANARY_TOKEN,
    SERA_BLOCKED_HOSTS: 'blocked.test',
    SERA_FFMPEG_PATH: ffmpegPath,
    SERA_FFPROBE_PATH: ffprobePath,
    SERA_TRUST_PROXY: 'true',
  });

  engine = await SeraEngine.create({ config });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('health caching and single flight', () => {
  it('shares in-flight computation across concurrent calls and caches results', async () => {
    resetVersionCache();
    engine.resetHealthCache();

    const results = await Promise.all([
      engine.health(),
      engine.health(),
      engine.health(),
      engine.health(),
    ]);

    expect(results).toHaveLength(4);
    const first = results[0];
    for (const r of results) {
      expect(r).toEqual(first);
    }

    const cached = await engine.health();
    expect(cached).toEqual(first);
  });
});

describe('health redaction and authorization', () => {
  it('redacts detail fields for unauthenticated callers on /health', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<HealthReport>();
    expect(report.status).toBeDefined();
    expect(report.version).toBeDefined();
    expect(report.uptimeSeconds).toBeDefined();
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.name).toBeDefined();
      expect(check.status).toBeDefined();
      expect(check.detail).toBeUndefined();
    }
  });

  it('redacts detail fields for unauthenticated callers on /ready', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ready: boolean;
      checks: { name: string; status: string; detail?: string }[];
    }>();
    expect(body.ready).toBe(true);
    for (const check of body.checks) {
      expect(check.name).toBeDefined();
      expect(check.status).toBeDefined();
      expect(check.detail).toBeUndefined();
    }
  });

  it('includes full detail with admin bearer token on /health', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<HealthReport>();
    const details = report.checks.map((c) => c.detail).filter(Boolean);
    expect(details.length).toBeGreaterThan(0);
  });

  it('includes full detail with canary token on /health', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-sera-canary': CANARY_TOKEN,
      },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<HealthReport>();
    const details = report.checks.map((c) => c.detail).filter(Boolean);
    expect(details.length).toBeGreaterThan(0);
  });
});

describe('rate limiting on health and ready', () => {
  it('rate limits health requests exceeding 60 per minute per client', async () => {
    const ip = '198.51.100.77';
    let hitRateLimit = false;

    for (let i = 0; i < 65; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-forwarded-for': ip },
      });
      if (response.statusCode === 429) {
        hitRateLimit = true;
        break;
      }
    }

    expect(hitRateLimit).toBe(true);
  });

  it('exempts canary requests from rate limits on health', async () => {
    const ip = '198.51.100.88';
    for (let i = 0; i < 65; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          'x-forwarded-for': ip,
          'x-sera-canary': CANARY_TOKEN,
        },
      });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe('thumbnail security and caching', () => {
  it('caches thumbnails in memory and serves repeat requests without refetching', async () => {
    origin.requests.length = 0;
    const url = origin.url('/photo.jpg');
    const path = engine.resolver.thumbnailPath(url);

    const first = await app.inject({ method: 'GET', url: path });
    expect(first.statusCode).toBe(200);
    expect(origin.requests.filter((p) => p === '/photo.jpg')).toHaveLength(1);

    const second = await app.inject({ method: 'GET', url: path });
    expect(second.statusCode).toBe(200);
    expect(origin.requests.filter((p) => p === '/photo.jpg')).toHaveLength(1);
    expect(second.body).toEqual(first.body);
  });

  it('rejects thumbnail redirects to blocked hosts', async () => {
    const url = origin.url('/redirect-blocked');
    const path = engine.resolver.thumbnailPath(url);

    const response = await app.inject({ method: 'GET', url: path });
    expect([400, 404]).toContain(response.statusCode);
  });

  it('rate limits thumbnail requests exceeding 60 per minute per client', async () => {
    const url = origin.url('/photo.jpg');
    const path = engine.resolver.thumbnailPath(url);
    const ip = '198.51.100.99';
    let hitRateLimit = false;

    for (let i = 0; i < 65; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: { 'x-forwarded-for': ip },
      });
      if (response.statusCode === 429) {
        hitRateLimit = true;
        break;
      }
    }

    expect(hitRateLimit).toBe(true);
  });
});
