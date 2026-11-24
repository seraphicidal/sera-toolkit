import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Denylist } from './denylist.js';
import { loadConfig } from '../config.js';
import { MediaResolver } from '../resolver.js';
import { silentLogger } from '../logging.js';
import type { SeraError } from '../errors.js';
import { MemoryJobBackend } from '../queue/memory.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { JobService } from '../jobs/service.js';
import { JobRunner } from '../jobs/runner.js';

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

  it('enforces the denylist on importSubmitted, thumbnail tokens, resolveCanonical, JobService.create, and JobRunner.run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-deny-'));
    try {
      const denylist = new Denylist();
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'denylist-test-secret',
        SERA_DATA_DIR: dir,
      });
      const resolver = new MediaResolver({
        config,
        logger: silentLogger(),
        denylist,
        importHosts: { hosts: ['cdn.allowed.example'], requireHttps: false },
      });
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const backend = new MemoryJobBackend(silentLogger());
      const service = new JobService({
        config,
        logger: silentLogger(),
        resolver,
        workspaces,
        backend,
      });
      const runner = new JobRunner({
        config,
        logger: silentLogger(),
        resolver,
        workspaces,
      });

      const importRequest = {
        url: 'https://www.instagram.com/p/DcOX3hWFiey/',
        node: {
          code: 'DcOX3hWFiey',
          media_type: 1 as const,
          image_versions2: {
            candidates: [
              {
                url: 'https://cdn.allowed.example/photo.jpg',
                width: 640,
                height: 480,
              },
            ],
          },
        },
      };

      const info = resolver.importSubmitted(importRequest);
      const thumbPath = resolver.thumbnailPath('https://thumbs.evil-later.example/p.jpg');
      const thumbToken = decodeURIComponent(thumbPath.split('/').pop()!);

      denylist.blockUrl('https://www.instagram.com/p/DcOX3hWFiey', 'DSA takedown');
      denylist.blockHost('thumbs.evil-later.example', 'Takedown');
      denylist.blockHost('canon-blocked.example', 'Takedown');
      denylist.blockHost('runner-blocked.example', 'Takedown');

      expect(() => resolver.importSubmitted(importRequest)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }) as unknown as SeraError,
      );

      expect(() => resolver.verifyThumbnailToken(thumbToken)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }) as unknown as SeraError,
      );

      await expect(
        resolver.resolveCanonical(new URL('https://canon-blocked.example/video'), 'generic'),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }) as unknown as SeraError,
      );

      await expect(
        service.create({ infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] }, 'client-1'),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }) as unknown as SeraError,
      );

      await expect(
        runner.run(
          {
            jobId: '7'.repeat(32),
            provider: 'direct',
            url: 'https://runner-blocked.example/clip.mp4',
            selections: [{ itemIndex: 0, planKey: 'video/mp4/Original' }],
            packaging: 'auto',
          },
          () => undefined,
        ),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }) as unknown as SeraError,
      );

      await backend.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('canonicalizes provider URLs and blocks query-mutated variants without false positives', async () => {
    const { ProviderRegistry, normalizeForProvider } = await import('../providers/index.js');
    const registry = new ProviderRegistry();
    const denylist = new Denylist({
      canonicalizeUrl: (url) => {
        const provider = registry.detect(url);
        return provider ? normalizeForProvider(provider, url) : url;
      },
    });
    denylist.blockUrl('https://youtu.be/dQw4w9WgXcQ', 'Copyright notice');
    expect(denylist.isBlocked('https://www.youtube.com/watch?v=dQw4w9WgXcQ').blocked).toBe(true);
    expect(
      denylist.isBlocked('https://www.youtube.com/watch?v=dQw4w9WgXcQ&extra=bypass&t=42').blocked,
    ).toBe(true);
    expect(denylist.isBlocked('https://www.youtube.com/watch?v=otherVideo12').blocked).toBe(false);
  });

  it('merges concurrent multi-process writes and notifies listeners on async disk reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-deny-sync-'));
    try {
      const filePath = join(dir, 'denylist.json');
      const a = new Denylist({ filePath });
      const b = new Denylist({ filePath });
      let bNotified = 0;
      b.onUpdate(() => {
        bNotified += 1;
      });

      a.blockHost('first-bad.example', 'from A');
      await a.flush();
      b.blockHost('second-bad.example', 'from B');
      await b.flush();

      await a.reload();
      expect(a.isBlocked('https://first-bad.example/x').blocked).toBe(true);
      expect(a.isBlocked('https://second-bad.example/y').blocked).toBe(true);
      expect(b.isBlocked('https://first-bad.example/x').blocked).toBe(true);
      expect(b.isBlocked('https://second-bad.example/y').blocked).toBe(true);

      const c = new Denylist({ filePath });
      let cNotified = 0;
      c.onUpdate(() => {
        cNotified += 1;
      });
      await c.reload();
      expect(cNotified).toBeGreaterThanOrEqual(1);
      expect(bNotified).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
