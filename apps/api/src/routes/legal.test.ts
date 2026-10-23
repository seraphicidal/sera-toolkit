import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, SeraEngine, silentLogger } from '@sera/engine';
import type { LegalReportResponse } from '@sera/contracts/types';
import { buildServer } from '../server.js';

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;
let createdReportId: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-legal-report-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'test-secret-report',
      SERA_DATA_DIR: dataDir,
      SERA_ADMIN_TOKEN: 'test-admin-token-12345',
      SERA_ALERT_NTFY_TOPIC: 'test-topic',
      SERA_DOMAIN: 'test.sera.example',
    }),
    logger: silentLogger(),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('POST /api/legal/report', () => {
  it('accepts a valid copyright report and mitigates the target URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('ok', { status: 200 })));

    const payload = {
      targetUrl: 'https://infringing.example.com/audio.mp3',
      category: 'copyright',
      explanation: 'This audio file infringes on registered copyright track #12345.',
      notifierName: 'Rights Holder LLC',
      notifierOrganization: 'Legal Enforcement',
      notifierEmail: 'dmca@example.com',
      goodFaithConfirmed: true,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/legal/report',
      payload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as LegalReportResponse;
    expect(body.reportId).toMatch(/^rep_/);
    createdReportId = body.reportId;
    expect(body.status).toBe('action_taken');
    expect(body.mitigated).toBe(true);

    const check = engine.denylist.isBlocked('https://infringing.example.com/audio.mp3');
    expect(check.blocked).toBe(true);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://ntfy.sh/test-topic',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Title: 'SERA: Legal Report (copyright)',
          Priority: 'high',
          Tags: 'warning,scales',
          Click: 'https://test.sera.example/legal/report',
        }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it('accepts a malware report and blocks the entire domain host', async () => {
    const payload = {
      targetUrl: 'https://malware-drop.example.org/payload.exe',
      category: 'malware',
      explanation: 'Host is distributing malicious trojan payloads disguised as media files.',
      notifierName: 'Security Researcher',
      notifierEmail: 'security@example.org',
      goodFaithConfirmed: true,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/legal/report',
      payload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as LegalReportResponse;
    expect(body.status).toBe('action_taken');
    expect(body.mitigated).toBe(true);

    const check = engine.denylist.isBlocked('https://malware-drop.example.org/anything');
    expect(check.blocked).toBe(true);
  });

  it('rejects an invalid payload missing goodFaithConfirmed', async () => {
    const payload = {
      targetUrl: 'https://example.com/something',
      category: 'other',
      explanation: 'Short',
      notifierName: 'X',
      notifierEmail: 'bad-email',
      goodFaithConfirmed: false,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/legal/report',
      payload,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/admin/reports', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/reports',
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects invalid admin tokens', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/reports',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns reports list for valid admin token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/reports',
      headers: { authorization: 'Bearer test-admin-token-12345' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reports: Record<string, unknown>[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.reports.length).toBeGreaterThanOrEqual(2);
    expect(body.reports[0]?.reportId).toBeDefined();
  });

  it('respects pagination limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/reports?limit=1',
      headers: { authorization: 'Bearer test-admin-token-12345' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reports: Record<string, unknown>[]; total: number };
    expect(body.reports.length).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/admin/reports/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/reports/${createdReportId}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for non-existent report', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/reports/rep_non_existent',
      headers: { authorization: 'Bearer test-admin-token-12345' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns report details for existing report id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/reports/${createdReportId}`,
      headers: { authorization: 'Bearer test-admin-token-12345' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.reportId).toBe(createdReportId);
    expect(body.category).toBe('copyright');
    expect(body.notifierName).toBe('Rights Holder LLC');
  });
});
