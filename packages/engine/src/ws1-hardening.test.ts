import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { SeraEngine } from './engine.js';
import { downloadDirect } from './extract/direct-download.js';
import { extractWithGalleryDl, resetGalleryDlAvailabilityCache } from './extract/gallerydl.js';
import { JobService } from './jobs/service.js';
import { silentLogger } from './logging.js';
import { buildImagePlans } from './normalize/plans.js';
import { assertRobotsAllows } from './providers/generic.js';
import { RedditTokenSource } from './providers/reddit-api.js';
import type { ProviderContext, ResolvedMedia } from './providers/types.js';
import { MemoryJobBackend } from './queue/memory.js';
import { MediaResolver } from './resolver.js';
import { createSafeDispatcher } from './security/http.js';
import { WorkspaceManager } from './storage/workspace.js';
import { TtlCache } from './util/cache.js';

describe('WS1 hardening regressions', () => {
  it('rejects truncated direct downloads when Content-Length does not match received bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-trunc-'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1000' });
      res.write(Buffer.alloc(200, 0x41));
      res.socket?.destroy();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    const dispatcher = createSafeDispatcher({ allowPrivateAddresses: true });
    const destination = join(dir, 'clip.mp4');

    try {
      await expect(
        downloadDirect({
          url: `http://127.0.0.1:${String(port)}/clip.mp4`,
          destination,
          dispatcher,
          maxBytes: 1024 * 1024,
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await expect(stat(destination)).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prevents remote cache poisoning and enforces TtlCache byte budgets', async () => {
    const cache = new TtlCache<string>(100, 60_000, {
      maxBytes: 100,
      sizeOf: (v) => v.length,
    });
    cache.set('a', 'x'.repeat(60));
    cache.set('b', 'y'.repeat(60));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('y'.repeat(60));
    expect(cache.bytes).toBe(60);

    const poisoned: ResolvedMedia = {
      provider: 'youtube',
      providerLabel: 'YouTube',
      url: 'https://www.youtube.com/watch?v=victimVideo1',
      type: 'single',
      title: 'Attacker video',
      items: [
        {
          index: 0,
          kind: 'video',
          plans: [
            {
              kind: 'video',
              container: 'mp4',
              label: '720p',
              requiresConversion: false,
              recommended: true,
              fetch: { via: 'ytdlp', selector: 'best' },
            },
          ],
        },
      ],
    };

    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const resolver = new MediaResolver({
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('force remote')),
      remoteBackends: () => [
        {
          id: 'residential',
          kind: 'remote',
          networkClass: 'residential',
          providers: ['youtube'],
          isHealthy: () => true,
          resolve: () => Promise.resolve(poisoned),
        },
      ],
    });

    try {
      const resolved = await resolver.resolveCanonical(
        new URL('https://www.youtube.com/watch?v=attacker123'),
        'youtube',
      );
      expect(resolved.url).toBe('https://www.youtube.com/watch?v=attacker123');
      expect(
        resolver.getCached('youtube', 'https://www.youtube.com/watch?v=victimVideo1'),
      ).toBeUndefined();
    } finally {
      await resolver.close();
    }
  });

  it('transitions ready jobs to expired on delete and destroys workspace on cancel race', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-job-del-'));
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SERA_DATA_DIR: dir });
    const resolver = new MediaResolver({ config, logger: silentLogger() });
    const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
    const backend = new MemoryJobBackend(silentLogger());
    const service = new JobService({
      config,
      logger: silentLogger(),
      resolver,
      workspaces,
      backend,
    });

    try {
      const id = 'a'.repeat(32);
      await workspaces.create(id);
      await backend.submit({
        id,
        state: 'ready',
        step: 'Ready',
        progress: { percent: 100 },
        provider: 'direct',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientKey: 'client-1',
        spec: {
          jobId: id,
          provider: 'direct',
          url: 'https://example.com/a.mp4',
          selections: [{ itemIndex: 0, planKey: 'video/mp4/Original' }],
          packaging: 'auto',
        },
      });
      expect(await service.delete(id, 'client-1')).toBe(true);
      const after = await service.get(id, 'client-1');
      expect(after?.state).toBe('expired');
      await expect(stat(join(dir, id))).rejects.toThrow();
    } finally {
      await backend.close();
      await resolver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles missing gallery-dl binary ENOENT cleanly and caches negative result', async () => {
    resetGalleryDlAvailabilityCache();
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('not used')),
      fetchText: () => Promise.reject(new Error('not used')),
      head: () => Promise.reject(new Error('not used')),
    };
    const missingBinary = 'nonexistent-gallery-dl-binary-xyz-999';
    await expect(
      extractWithGalleryDl(new URL('https://example.com/gallery'), context, {
        binary: missingBinary,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });

    const started = Date.now();
    await expect(
      extractWithGalleryDl(new URL('https://example.com/gallery'), context, {
        binary: missingBinary,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('keeps second RedditTokenSource caller alive when first caller aborts', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return new Response(JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const source = new RedditTokenSource(
      { clientId: 'id', clientSecret: 'sec', userAgent: 'ua' },
      silentLogger(),
      Date.now,
      fetchImpl,
    );
    const firstAbort = new AbortController();
    const p1 = source.token(firstAbort.signal);
    const p2 = source.token();
    firstAbort.abort();

    await expect(p1).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(p2).resolves.toBe('tok-ok');
    expect(calls).toBe(1);
  });

  it('negatively caches missing robots.txt and normalizes image containers in buildImagePlans', async () => {
    let fetches = 0;
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('not used')),
      head: () => Promise.reject(new Error('not used')),
      fetchText: () => {
        fetches += 1;
        return Promise.reject(new Error('404'));
      },
    };
    await assertRobotsAllows(new URL('https://no-robots.example/a'), context);
    await assertRobotsAllows(new URL('https://no-robots.example/b'), context);
    expect(fetches).toBe(1);

    const plans = buildImagePlans({ ext: 'jpeg' }, 'https://example.com/photo.jpeg');
    expect(plans[0]?.container).toBe('jpg');
    const heicPlans = buildImagePlans({ ext: 'heic' }, 'https://example.com/photo.heic');
    expect(heicPlans[0]?.container).toBe('jpg');
  });

  it('populates nodeAvailability telemetry in SeraEngine.serviceInfo()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-info-'));
    const engine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_DATA_DIR: dir,
        SERA_EXTRACTION_NODE_TOKENS: 'home:tok-1',
      }),
    });
    try {
      engine.extractionNodes.register('home', ['youtube'], 1, 'residential', ['trim']);
      engine.extractionNodes.register('phone', ['youtube'], 1, 'residential', ['trim'], {
        role: 'backup',
      });
      const info = engine.serviceInfo();
      expect(info.nodeAvailability).toEqual({
        enabled: true,
        totalNodes: 2,
        healthyNodes: 2,
        residentialNodes: 2,
        primaryNodes: 1,
        backupNodes: 1,
        features: ['trim'],
        providers: ['youtube'],
      });
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
