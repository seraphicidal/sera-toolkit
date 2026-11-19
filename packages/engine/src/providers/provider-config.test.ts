import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ProviderRegistry } from './index.js';

const base = { NODE_ENV: 'test', LOG_LEVEL: 'silent' };

describe('provider filtering by configuration', () => {
  it('disables providers listed in SERA_DISABLED_PROVIDERS', () => {
    const config = loadConfig({ ...base, SERA_DISABLED_PROVIDERS: 'youtube,tiktok,generic' });
    const registry = new ProviderRegistry(undefined, config);
    expect(registry.get('youtube')).toBeUndefined();
    expect(registry.get('tiktok')).toBeUndefined();
    expect(registry.get('twitter')).toBeDefined();
    expect(registry.detect(new URL('https://www.youtube.com/watch?v=123'))).toBeUndefined();
  });

  it('restricts providers to SERA_ENABLED_PROVIDERS when set', () => {
    const config = loadConfig({ ...base, SERA_ENABLED_PROVIDERS: 'youtube,vimeo' });
    const registry = new ProviderRegistry(undefined, config);
    expect(registry.get('youtube')).toBeDefined();
    expect(registry.get('vimeo')).toBeDefined();
    expect(registry.get('twitter')).toBeUndefined();
    expect(registry.detect(new URL('https://twitter.com/user/status/123'))).toBeUndefined();
  });
});
