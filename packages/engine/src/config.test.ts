import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };

describe('per-provider resolve timeouts', () => {
  it('uses each provider its own ceiling by default, and the shared one for the rest', () => {
    const config = loadConfig({ ...base, SERA_RESOLVE_TIMEOUT_SECONDS: '45' });
    expect(config.resolveTimeoutMsFor('youtube')).toBe(60_000);
    expect(config.resolveTimeoutMsFor('reddit')).toBe(25_000);
    expect(config.resolveTimeoutMsFor('vimeo')).toBe(45_000);
  });

  it('takes 0 to mean the shared ceiling', () => {
    const config = loadConfig({
      ...base,
      SERA_RESOLVE_TIMEOUT_SECONDS: '50',
      SERA_RESOLVE_TIMEOUT_YOUTUBE_SECONDS: '0',
    });
    expect(config.resolveTimeoutMsFor('youtube')).toBe(50_000);
    expect(config.resolveTimeoutMsFor('instagram')).toBe(30_000);
  });

  it('still refuses a negative or fractional ceiling, and a shared ceiling of 0', () => {
    expect(() => loadConfig({ ...base, SERA_RESOLVE_TIMEOUT_REDDIT_SECONDS: '-1' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, SERA_RESOLVE_TIMEOUT_TWITTER_SECONDS: '2.5' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, SERA_RESOLVE_TIMEOUT_SECONDS: '0' })).toThrow(ConfigError);
  });
});

describe('production secret and worker token hardening', () => {
  it('requires SERA_SECRET to be at least 32 characters in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SERA_SECRET: 'short-secret-123' })).toThrow(
      ConfigError,
    );
    const ok = loadConfig({
      NODE_ENV: 'production',
      SERA_SECRET: 'a'.repeat(32),
    });
    expect(ok.isProduction).toBe(true);
  });

  it('never falls back workerToken to SERA_ADMIN_TOKEN or legacy node token', () => {
    const withLegacy = loadConfig({
      ...base,
      SERA_EXTRACTION_NODE_TOKEN: 'legacy-node-token',
      SERA_ADMIN_TOKEN: 'super-admin-token',
    });
    expect(withLegacy.extractionNodes.workerToken).toBe('');

    const withExplicit = loadConfig({
      ...base,
      SERA_EXTRACTION_NODE_TOKENS: 'node1:tok1',
      SERA_EXTRACTION_WORKER_TOKEN: 'worker-secret-token',
      SERA_ADMIN_TOKEN: 'super-admin-token',
    });
    expect(withExplicit.extractionNodes.workerToken).toBe('worker-secret-token');
  });
});
