import { Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from './server.js';
import { ThumbnailCache } from './routes/media.js';

const lines: Record<string, unknown>[] = [];
let engine: SeraEngine;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-server-log-'));
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'trace',
      SERA_SECRET: 'server-log-secret',
      SERA_DATA_DIR: dataDir,
      SERA_TRUST_PROXY: 'true',
    }),
    logger: pino({ level: 'trace' }, sink),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('request logging', () => {
  it("writes the route, never the path or query, and none of Fastify's own request lines", async () => {
    const marker = 'https%3A%2F%2Fprivate.example%2Fwatch%3Fv%3Dsecret';
    const response = await app.inject({ method: 'GET', url: `/api/info?u=${marker}` });
    expect(response.statusCode).toBe(200);

    const text = JSON.stringify(lines);
    expect(text).not.toContain('private.example');
    expect(text).not.toContain(marker);
    expect(lines.some((line) => line.msg === 'incoming request')).toBe(false);
    expect(lines.some((line) => line.msg === 'request completed')).toBe(false);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'request', route: '/api/info', method: 'GET', status: 200 }),
    );
  });
});

describe('server hardening', () => {
  it('configures non-zero requestTimeout and headersTimeout', () => {
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.server.headersTimeout).toBeGreaterThan(0);
    expect(app.server.headersTimeout).toBeLessThanOrEqual(app.server.requestTimeout);
  });

  it('maps Zod schema errors to VALIDATION_ERROR with retryable: false', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: 'abc', optionIds: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', retryable: false },
    });
  });

  it('caps concurrent SSE connections per client and releases slots on close', async () => {
    const jobId = 'feedface0123456789abcdef01234567';
    const jobs = engine.jobs as unknown as {
      get: typeof engine.jobs.get;
      events: typeof engine.jobs.events;
    };
    const originalGet = jobs.get.bind(engine.jobs);
    const originalEvents = jobs.events.bind(engine.jobs);
    const releases: (() => void)[] = [];

    jobs.get = (id, clientKeys) =>
      id === jobId
        ? Promise.resolve({
            id: jobId,
          } as unknown as Awaited<ReturnType<typeof engine.jobs.get>>)
        : originalGet(id, clientKeys);
    jobs.events = async function* (id, signal, clientKeys) {
      if (id === jobId) {
        yield { type: 'ping' };
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      yield* originalEvents(id, signal, clientKeys);
    };

    try {
      const headers = { 'x-forwarded-for': '198.51.100.222' };
      const pending = Array.from({ length: 8 }, () =>
        app.inject({ method: 'GET', url: `/api/jobs/${jobId}/events`, headers }),
      );
      while (releases.length < 8) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const ninth = await app.inject({
        method: 'GET',
        url: `/api/jobs/${jobId}/events`,
        headers,
      });
      expect(ninth.statusCode).toBe(429);
      expect(ninth.json()).toMatchObject({
        error: { code: 'RATE_LIMITED', retryable: true },
      });

      releases.pop()?.();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const reopened = app.inject({
        method: 'GET',
        url: `/api/jobs/${jobId}/events`,
        headers,
      });
      while (releases.length < 8) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      while (releases.length) releases.pop()?.();
      const all = await Promise.all([...pending, reopened]);
      for (const res of all) {
        expect(res.statusCode).toBe(200);
      }
    } finally {
      while (releases.length) releases.pop()?.();
      jobs.get = originalGet;
      jobs.events = originalEvents;
    }
  });

  it('returns 404 and marks job expired when workspace file vanishes before download', async () => {
    const jobId = 'cafe0123456789abcdef0123456789ab';
    const ws = await engine.workspaces.create(jobId);
    await ws.writeManifest({
      jobId,
      primary: 'gone.mp4',
      isArchive: false,
      files: [{ name: 'gone.mp4', sizeBytes: 12, mimeType: 'video/mp4' }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const jobs = engine.jobs as unknown as {
      get: typeof engine.jobs.get;
      markExpired: typeof engine.jobs.markExpired;
    };
    const originalGet = jobs.get.bind(engine.jobs);
    const originalMarkExpired = jobs.markExpired.bind(engine.jobs);
    const expiredIds: string[] = [];
    jobs.get = (id, clientKeys) =>
      id === jobId
        ? Promise.resolve({
            id: jobId,
            provider: 'direct',
          } as unknown as Awaited<ReturnType<typeof engine.jobs.get>>)
        : originalGet(id, clientKeys);
    jobs.markExpired = async (id) => {
      expiredIds.push(id);
      await originalMarkExpired(id);
    };

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs/${jobId}/download`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: 'NOT_FOUND', retryable: false },
      });
      expect(expiredIds).toContain(jobId);
    } finally {
      jobs.get = originalGet;
      jobs.markExpired = originalMarkExpired;
      await engine.workspaces.destroy(jobId);
    }
  });

  it('bounds default ThumbnailCache memory to 32 MiB and 128 entries', () => {
    const cache = new ThumbnailCache();
    const chunk = Buffer.alloc(1024 * 1024, 0xaa);
    for (let i = 0; i < 40; i += 1) {
      cache.set(`https://cdn.example.com/${String(i)}.jpg`, chunk, 'image/jpeg');
    }
    expect(cache.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(cache.size).toBeLessThanOrEqual(128);
  });
});
