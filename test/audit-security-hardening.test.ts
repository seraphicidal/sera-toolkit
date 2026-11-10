import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, SeraEngine, silentLogger } from '@sera/engine';
import { isPublicAddress, unwrapIpv4Mapped } from '@sera/engine';
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
