import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, SeraEngine, silentLogger } from '@sera/engine';
import type { LegalReportResponse } from '@sera/contracts/types';
import { buildServer } from '../server.js';

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-legal-report-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'test-secret-report',
      SERA_DATA_DIR: dataDir,
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
    expect(body.status).toBe('action_taken');
    expect(body.mitigated).toBe(true);

    const check = engine.denylist.isBlocked('https://infringing.example.com/audio.mp3');
    expect(check.blocked).toBe(true);
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
