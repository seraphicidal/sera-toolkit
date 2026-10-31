import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AbuseGuard,
  isPathAllowed,
  loadConfig,
  ProviderRegistry,
  SeraEngine,
  silentLogger,
} from '@sera/engine';
import { classifyYtdlpFailure } from '../packages/engine/src/extract/ytdlp.js';
import { buildServer } from '../apps/api/src/server.js';
import type { LegalReportResponse } from '@sera/contracts/types';

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-eu-compliance-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'test-compliance-secret-12345678',
      SERA_DATA_DIR: dataDir,
      SERA_RETENTION_SECONDS: '1800',
      SERA_BLOCKED_HOSTS: 'blocked-site.com',
      SERA_DISABLED_PROVIDERS: 'snapchat',
    }),
    logger: silentLogger(),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('EU Compliance: GDPR & Ephemeral Data Processing', () => {
  it('enforces ephemeral IP rate limiting with in-memory hashing', () => {
    const abuse = new AbuseGuard({ maxFailures: 2, cooldownMs: 60_000 });
    const ip = '198.51.100.42';

    expect(() => abuse.assertAllowed(ip)).not.toThrow();
    abuse.recordFailure(ip, 'INVALID_URL');
    expect(() => abuse.assertAllowed(ip)).not.toThrow();
    abuse.recordFailure(ip, 'INVALID_URL');
    expect(() => abuse.assertAllowed(ip)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
  });

  it('defaults workspace retention to 1800 seconds (30 minutes)', () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    expect(config.retentionSeconds).toBe(1800);
  });

  it('exposes service information with configured limits and retention', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/info' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { limits: { retentionSeconds: number } };
    expect(body.limits.retentionSeconds).toBe(1800);
  });
});

describe('EU Compliance: Digital Services Act (DSA Arts. 11, 12, 14, 16)', () => {
  it('receives structured takedown report and engages automated mitigation', async () => {
    const reportPayload = {
      targetUrl: 'https://malicious-infringing.eu/virus.mp4',
      category: 'malware',
      explanation: 'Distribution of malware disguised as video media.',
      notifierName: 'EU Cyber Security Analyst',
      notifierEmail: 'analyst@cert.europa.eu',
      goodFaithConfirmed: true,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/legal/report',
      payload: reportPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as LegalReportResponse;
    expect(body.reportId).toMatch(/^rep_/);
    expect(body.status).toBe('action_taken');
    expect(body.mitigated).toBe(true);

    expect(engine.denylist.isBlocked('https://malicious-infringing.eu/virus.mp4').blocked).toBe(
      true,
    );

    const persistedRaw = await readFile(join(dataDir, 'reports', `${body.reportId}.json`), 'utf-8');
    const persisted = JSON.parse(persistedRaw) as { clientIp: string };
    expect(persisted.clientIp).toBeDefined();
    expect(persisted.clientIp).not.toBe('127.0.0.1');
    expect(persisted.clientIp.length).toBe(22);
  });

  it('strictly rejects takedown reports without mandatory good-faith confirmation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/legal/report',
      payload: {
        targetUrl: 'https://example.com/item.mp3',
        category: 'copyright',
        explanation: 'Valid explanation',
        notifierName: 'Claimant',
        notifierEmail: 'test@example.com',
        goodFaithConfirmed: false,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('aborts MediaResolver resolution immediately when host is denylisted', async () => {
    const resolver = engine.resolver;
    await expect(resolver.resolve('https://blocked-site.com/media/test')).rejects.toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }),
    );
  });
});

describe('EU Compliance: DRM Protection & Technical Access Boundaries', () => {
  it('refuses Widevine and FairPlay DRM without attempting circumvention', () => {
    const widevineErr = classifyYtdlpFailure('ERROR: Content is protected by Widevine DRM', 1);
    expect(widevineErr.code).toBe('DRM_PROTECTED');
    expect(widevineErr.httpStatus).toBe(403);

    const fairplayErr = classifyYtdlpFailure('ERROR: Protected by FairPlay DRM', 1);
    expect(fairplayErr.code).toBe('DRM_PROTECTED');
    expect(fairplayErr.httpStatus).toBe(403);
  });

  it('refuses paywalls and subscriber-only boundaries cleanly', () => {
    const paywallErr = classifyYtdlpFailure(
      'ERROR: This article is behind a paywall; subscription required',
      1,
    );
    expect(paywallErr.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(paywallErr.httpStatus).toBe(501);
  });
});

describe('EU Compliance: InfoSoc Directive & Platform Exclusion (robots.txt)', () => {
  it('honors platform robots exclusion before extraction', () => {
    const robots = 'User-agent: sera-toolkit\nDisallow: /restricted-library';
    expect(isPathAllowed(robots, '/restricted-library/audio.mp3')).toBe(false);
    expect(isPathAllowed(robots, '/public-showcase/audio.mp3')).toBe(true);
  });
});

describe('EU Compliance: Configurable Provider Registry', () => {
  it('excludes disabled providers from extraction pipelines', () => {
    const registry = new ProviderRegistry(undefined, engine.config);
    expect(registry.get('snapchat')).toBeUndefined();
    expect(registry.detect(new URL('https://www.snapchat.com/add/test'))?.id).not.toBe('snapchat');
  });
});
