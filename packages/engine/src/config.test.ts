import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

/**
 * The settings whose meaning is more than "a number": here, the per-provider resolve
 * ceilings, whose 0 is documented as "use the shared one" and used to be refused instead.
 */

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
