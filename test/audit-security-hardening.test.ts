import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  InFlightCoalescer,
  isPublicAddress,
  loadConfig,
  SeraEngine,
  silentLogger,
  unwrapIpv4Mapped,
} from '@sera/engine';
import { parseGalleryDlJson } from '../packages/engine/src/extract/gallerydl.js';
import { buildServer } from '../apps/api/src/server.js';

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-security-audit-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'test-audit-security-secret-key-1234',
      SERA_DATA_DIR: dataDir,
      SERA_ADMIN_TOKEN: 'admin-audit-secret-token',
      SERA_CORS_ORIGINS: 'https://sera.example.com',
      SERA_TRUST_PROXY: 'true',
    }),
    logger: silentLogger(),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('Security Hardening: CORS and Rate Limiting', () => {
  it('permits HEAD in CORS preflight method checks', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/info',
      headers: {
        origin: 'https://sera.example.com',
        'access-control-request-method': 'HEAD',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('HEAD');
  });

  it('enforces meta rate limit on /api/info for public callers', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/info',
        headers: {
          'x-forwarded-for': '198.51.100.99',
        },
      });
      responses.push(res.statusCode);
      if (res.statusCode === 429) break;
    }

    expect(responses.some((code) => code === 429)).toBe(true);
  });

  it('enforces polling rate limit on /api/jobs/:id', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 130; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/jobs/0123456789abcdef0123456789abcdef',
        headers: {
          'x-forwarded-for': '198.51.100.123',
        },
      });
      responses.push(res.statusCode);
      if (res.statusCode === 429) break;
    }

    expect(responses.some((code) => code === 429)).toBe(true);
  });
});

describe('Security Hardening: SSRF and Address Guards', () => {
  it('blocks private IPv4 and loopback addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('172.16.0.1')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('0.0.0.0')).toBe(false);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
  });

  it('blocks IPv6 loopback, site-local and mapped private addresses', () => {
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('::')).toBe(false);
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.5')).toBe(false);
  });

  it('unwraps IPv4 mapped addresses from dotted and hex forms', () => {
    expect(unwrapIpv4Mapped('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(unwrapIpv4Mapped('::ffff:7f00:0001')).toBe('127.0.0.1');
    expect(unwrapIpv4Mapped('::ffff:a00:1')).toBe('10.0.0.1');
  });

  it('allows public addresses', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('Security Hardening: Path Traversal Defenses', () => {
  it('rejects path traversal attempts on /api/admin/reports/:id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/reports/..%2F..%2Fetc%2Fpasswd',
      headers: { authorization: 'Bearer admin-audit-secret-token' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('Security Hardening: IDOR, Coalescing & Extractor Filtering', () => {
  it('hides job existence and endpoints across different client keys', async () => {
    const jobId = 'abcdef0123456789abcdef0123456789';
    const now = new Date().toISOString();
    await engine.backend.submit({
      id: jobId,
      state: 'queued',
      step: 'Queued',
      progress: { percent: 0, currentFile: 1, totalFiles: 1 },
      provider: 'direct',
      createdAt: now,
      updatedAt: now,
      clientKey: 'other-client-key-0001',
      spec: {
        jobId,
        provider: 'direct',
        url: 'https://example.com/clip.mp4',
        selections: [{ itemIndex: 0, planKey: 'video/mp4' }],
        packaging: 'auto',
      },
    });

    const headers = { 'x-forwarded-for': '198.51.100.200' };
    const getRes = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers });
    const delRes = await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}`, headers });
    const sseRes = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/events`, headers });
    const dlRes = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/download`, headers });

    expect(getRes.statusCode).toBe(404);
    expect(delRes.statusCode).toBe(404);
    expect(sseRes.statusCode).toBe(404);
    expect(dlRes.statusCode).toBe(404);
  });

  it('isolates single-caller aborts inside InFlightCoalescer until all callers abort', async () => {
    const coalescer = new InFlightCoalescer<string>();
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pA = coalescer.run(
      'k1',
      async (sig) => {
        seenSignal = sig;
        await gate;
        return 'ok';
      },
      ctrlA.signal,
    );
    const pB = coalescer.run('k1', async () => 'should-reuse', ctrlB.signal);

    ctrlA.abort(new Error('caller-a-left'));
    await expect(pA).rejects.toThrow('caller-a-left');
    expect(seenSignal?.aborted).toBe(false);

    release();
    await expect(pB).resolves.toBe('ok');

    const ctrlC = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const pC = coalescer.run(
      'k2',
      async (sig) => {
        sharedSignal = sig;
        return await new Promise<string>((_resolve, reject) => {
          sig.addEventListener('abort', () => reject(new Error('upstream-aborted')), {
            once: true,
          });
        });
      },
      ctrlC.signal,
    );
    ctrlC.abort(new Error('last-caller-left'));
    await expect(pC).rejects.toThrow('last-caller-left');
    expect(sharedSignal?.aborted).toBe(true);
  });

  it('filters gallery-dl extracted URLs against blockedHosts', () => {
    const stdout = JSON.stringify([
      [2, { title: 'Test', uploader: 'alice' }],
      [3, 'https://blocked.example/a.jpg', { extension: 'jpg' }],
      [3, 'https://cdn.good.example/b.png', { extension: 'png' }],
    ]);

    const parsed = parseGalleryDlJson(stdout, false, ['blocked.example']);
    expect(parsed.entries.map((entry) => entry.url)).toEqual(['https://cdn.good.example/b.png']);
  });
});
