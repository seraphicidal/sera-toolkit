import { describe, expect, it } from 'vitest';
import { Denylist } from './denylist.js';
import { loadConfig } from '../config.js';
import { MediaResolver } from '../resolver.js';
import { silentLogger } from '../logging.js';
import type { SeraError } from '../errors.js';

describe('Denylist', () => {
  it('identifies statically blocked hosts', () => {
    const denylist = new Denylist({ staticHosts: ['piratesite.com', 'bad.org'] });
    expect(denylist.isBlocked('https://piratesite.com/video').blocked).toBe(true);
    expect(denylist.isBlocked('https://sub.piratesite.com/video').blocked).toBe(true);
    expect(denylist.isBlocked('https://legit.com/video').blocked).toBe(false);
  });

  it('supports dynamically blocking hosts', () => {
    const denylist = new Denylist();
    expect(denylist.isBlocked('https://malicious.example/media').blocked).toBe(false);
    denylist.blockHost('malicious.example', 'DSA notice');
    expect(denylist.isBlocked('https://malicious.example/media').blocked).toBe(true);
    expect(denylist.isBlocked('https://cdn.malicious.example/media').blocked).toBe(true);
  });

  it('supports dynamically blocking specific URLs', () => {
    const denylist = new Denylist();
    denylist.blockUrl('https://example.com/infringing-track.mp3', 'DMCA notice');
    expect(denylist.isBlocked('https://example.com/infringing-track.mp3').blocked).toBe(true);
    expect(denylist.isBlocked('https://example.com/other-track.mp3').blocked).toBe(false);
  });

  it('aborts MediaResolver resolution immediately with UNSUPPORTED_SOURCE when blocked', async () => {
    const denylist = new Denylist();
    denylist.blockHost('denied-platform.com', 'Takedown notice');
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const resolver = new MediaResolver({ config, logger: silentLogger(), denylist });
    await expect(resolver.resolve('https://denied-platform.com/video/123')).rejects.toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_SOURCE',
      }) as unknown as SeraError,
    );
  });
});
