import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig, type EngineConfig } from './config.js';
import { seraError } from './errors.js';
import { classifyFailure } from './extract/failure.js';
import { discoverMedia } from './extract/html.js';
import { RemoteOverHttp } from './extract/remote-http.js';
import { runStrategies } from './extract/strategy.js';
import { scrubCredentials } from './extract/ytdlp.js';
import type { YtdlpInfo } from './extract/ytdlp-types.js';
import { JobRunner, watchGrowth } from './jobs/runner.js';
import { JobService } from './jobs/service.js';
import { silentLogger } from './logging.js';
import { buildAudioPlans, buildVideoPlans } from './normalize/plans.js';
import type { UsableFormat } from './normalize/formats.js';
import { BlueskyProvider } from './providers/bluesky.js';
import { GoogleDriveProvider } from './providers/cloud.js';
import { classify } from './providers/direct.js';
import { MastodonProvider } from './providers/mastodon.js';
import { RedditProvider } from './providers/reddit.js';
import { readViaEmbed } from './providers/threads-embed.js';
import { TwitterProvider } from './providers/twitter.js';
import { YtdlpProvider } from './providers/ytdlp-base.js';
import { planKey, type ProviderContext, type ResolvedMedia } from './providers/types.js';
import { MemoryJobBackend } from './queue/memory.js';
import { MediaResolver } from './resolver.js';
import { AbuseGuard } from './security/abuse.js';
import { Denylist } from './security/denylist.js';
import { confineToHttp, EgressGuard } from './security/egress.js';
import type { OpenResponse } from './security/http.js';
import { isPublicAddress } from './security/ip.js';
import { isAllowed as isRobotsAllowed, parseRobots } from './security/robots.js';
import { normalizeUrl } from './security/url.js';
import { WorkspaceManager } from './storage/workspace.js';
import { contentDispositionValue } from './util/filename.js';
import { sliceUtf16Safe } from './util/format.js';
import { sniffTextImposter } from './util/sniff.js';
import { signToken, verifyToken } from './util/tokens.js';

function testConfig(overrides: Record<string, string> = {}): EngineConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SERA_SECRET: 'test-secret',
    SERA_DATA_DIR: '.data/test',
    SERA_BLOCKED_HOSTS: 'blocked.example',
    SERA_REDDIT_CLIENT_ID: 'cid',
    SERA_REDDIT_CLIENT_SECRET: 'csec',
    ...overrides,
  });
}

function testContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    config: testConfig(),
    logger: silentLogger(),
    probe: () =>
      Promise.reject(
        seraError('PROVIDER_UNAVAILABLE', { detail: 'Requested format is not available' }),
      ),
    fetchText: () => Promise.reject(seraError('NETWORK_ERROR')),
    head: (target) =>
      Promise.resolve({
        status: 200,
        contentType: 'application/octet-stream',
        url: target.toString(),
      }),
    ...overrides,
  };
}

describe('audit pass 1 regressions', () => {
  it('matches SERA_EXTRACTION_PROXY_PROVIDERS case-insensitively in proxyFor', () => {
    const cfg = testConfig({
      SERA_EXTRACTION_PROXY_URL: 'http://127.0.0.1:8888',
      SERA_EXTRACTION_PROXY_PROVIDERS: 'YouTube, Instagram',
    });
    expect(cfg.proxyFor('youtube')).toBe('http://127.0.0.1:8888');
    expect(cfg.proxyFor('YouTube')).toBe('http://127.0.0.1:8888');
    expect(cfg.proxyFor('instagram')).toBe('http://127.0.0.1:8888');
    expect(cfg.proxyFor('tiktok')).toBeUndefined();
  });
  it('strips trailing dots in normalizeUrl hostnames', () => {
    const normalized = normalizeUrl(new URL('https://Example.COM./watch?v=1'));
    expect(normalized.hostname).toBe('example.com');
    expect(normalized.toString()).toBe('https://example.com/watch?v=1');
  });

  it('blocks 6to4 relay and RFC 9637 / 9602 IP ranges', () => {
    expect(isPublicAddress('192.88.99.1')).toBe(false);
    expect(isPublicAddress('3fff::1')).toBe(false);
    expect(isPublicAddress('5f00::1')).toBe(false);
  });

  it('cleans temporary files when Denylist save fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-deny-'));
    try {
      const targetPath = join(dir, 'denylist.json');
      await mkdir(targetPath);
      const list = new Denylist({ filePath: targetPath });
      list.blockHost('evil.example', 'test');
      await list.flush();
      const remaining = await readdir(dir);
      expect(remaining.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects SVG and script imposters in sniffTextImposter', () => {
    expect(sniffTextImposter(Buffer.from('<script>alert(1)</script>'))).toBe('html');
    expect(sniffTextImposter(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'xml',
    );
    expect(sniffTextImposter(Buffer.from('<!DOCTYPE svg><svg/>'))).toBe('xml');
    expect(sniffTextImposter(Buffer.from('<!DOCTYPE xml><root/>'))).toBe('xml');
  });

  it('rejects array token payloads and mismatched signature lengths in verifyToken', () => {
    const secret = Buffer.from('test-secret-value-at-least-32-chars!!');
    const body = Buffer.from('[1,2,3]').toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    expect(() => verifyToken(`${body}.${sig}`, secret)).toThrow();
    expect(() => verifyToken(`${body}.short`, secret)).toThrow();
  });

  it('percent-encodes RFC 5987 attribute characters in contentDispositionValue', () => {
    const header = contentDispositionValue("clip'!(star)*.mp4");
    expect(header).toContain("filename*=UTF-8''clip%27%21%28star%29%2A.mp4");
  });

  it('redacts token-only credentials in scrubCredentials', () => {
    expect(scrubCredentials('https://secret-token@proxy.example:8080/')).toBe(
      'https://[redacted]@proxy.example:8080/',
    );
  });

  it('never classifies SVG as an image', () => {
    expect(classify('image/svg+xml', 'svg')).toBe('unknown');
    expect(classify('', 'svg')).toBe('unknown');
  });

  it('blocks SVG and active XML/JS responses in cloud downloads', async () => {
    const provider = new GoogleDriveProvider();
    for (const mime of [
      'image/svg+xml',
      'application/xhtml+xml',
      'application/javascript',
      'application/xml',
    ]) {
      await expect(
        provider.resolve(
          new URL('https://drive.google.com/file/d/AbCdEfGhIjK/view'),
          testContext({
            head: (target) =>
              Promise.resolve({ status: 200, contentType: mime, url: target.toString() }),
          }),
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    }
  });

  it('filters Mastodon attachments and previews via allowUrl', async () => {
    const provider = new MastodonProvider();
    const media = await provider.resolve(
      new URL('https://mastodon.social/@user/123456'),
      testContext({
        allowUrl: (candidate) => {
          const u = new URL(candidate.toString());
          if (u.hostname.includes('denied')) throw seraError('UNSUPPORTED_SOURCE');
          return u;
        },
        fetchText: (target) =>
          Promise.resolve({
            url: target.toString(),
            body: JSON.stringify({
              content: '<p>post</p>',
              media_attachments: [
                {
                  id: 'bad',
                  type: 'image',
                  url: 'https://denied.example/bad.jpg',
                },
                {
                  id: 'good',
                  type: 'image',
                  url: 'https://files.mastodon.social/good.jpg',
                  preview_url: 'https://denied.example/thumb.jpg',
                },
              ],
            }),
          }),
      }),
    );
    expect(media.items).toHaveLength(1);
    expect(media.items[0]?.sourceId).toBe('good');
    expect(media.items[0]?.thumbnailUrl).toBeUndefined();
  });

  it('preserves BLOCKED_ADDRESS and enforces allowUrl in BlueskyProvider', async () => {
    const provider = new BlueskyProvider();
    const formatMissing = () =>
      Promise.reject(
        seraError('PROVIDER_UNAVAILABLE', { detail: 'Requested format is not available' }),
      );
    await expect(
      provider.resolve(
        new URL('https://bsky.app/profile/did:plc:abc123/post/xyz'),
        testContext({
          probe: formatMissing,
          fetchText: () => Promise.reject(seraError('BLOCKED_ADDRESS')),
        }),
      ),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });

    const media = await provider.resolve(
      new URL('https://bsky.app/profile/did:plc:abc123/post/xyz'),
      testContext({
        probe: formatMissing,
        allowUrl: (candidate) => {
          const u = new URL(candidate.toString());
          if (u.hostname.includes('denied')) throw seraError('BLOCKED_ADDRESS');
          return u;
        },
        fetchText: (target) =>
          Promise.resolve({
            url: target.toString(),
            body: JSON.stringify({
              thread: {
                post: {
                  author: { handle: 'alice.bsky.social' },
                  record: { text: 'hello' },
                  embed: {
                    images: [
                      { fullsize: 'https://denied.example/bad.jpg' },
                      {
                        fullsize: 'https://cdn.bsky.app/img/feed_fullsize/ok@jpeg',
                        thumb: 'https://denied.example/bad-thumb.jpg',
                      },
                    ],
                  },
                },
              },
            }),
          }),
      }),
    );
    expect(media.items).toHaveLength(1);
    expect(media.items[0]?.thumbnailUrl).toBe('https://cdn.bsky.app/img/feed_fullsize/ok@jpeg');
  });

  it('rejects unsupported upstream proxy schemes cleanly in RedditProvider', async () => {
    const provider = new RedditProvider();
    await expect(
      provider.resolve(
        new URL('https://www.reddit.com/r/pics/comments/abc123/test/'),
        testContext({
          egressProxy: () => Promise.resolve('socks5://127.0.0.1:1080'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_ERROR' });
  });

  it('decodes HTML entities and enforces allowUrl on expanded t.co links', async () => {
    const provider = new TwitterProvider();
    let seenUrl: string | undefined;
    await expect(
      provider.resolve(
        new URL('https://t.co/AbCd'),
        testContext({
          open: () =>
            Promise.resolve({
              status: 200,
              headers: {},
              body: Readable.from([
                '<meta http-equiv="refresh" content="0;url=https://x.com/user/status/42?a=1&amp;b=2">',
              ]),
              url: 'https://t.co/AbCd',
            } as unknown as OpenResponse),
          allowUrl: (candidate) => {
            seenUrl = candidate.toString();
            throw seraError('BLOCKED_ADDRESS');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    expect(seenUrl).toBe('https://x.com/user/status/42?a=1&b=2');
  });

  it('defaults extensionless Threads embed image containers to jpg instead of bin', async () => {
    const media = await readViaEmbed(
      new URL('https://www.threads.com/@alice/post/AbC123'),
      () =>
        Promise.resolve({
          body: '<div class="OuterContainerFull"><img src="https://scontent.cdninstagram.com/v/t51.12345-15/noext" /><span class="BodyTextContainer">hi</span></div>PostDateContainer',
        }),
      10,
    );
    expect(media.items[0]?.container).toBe('jpg');
  });

  it('short-circuits runStrategies on cancellation and sets firstError when index 0 skips', async () => {
    const ctrl = new AbortController();
    let secondCalls = 0;
    await expect(
      runStrategies(
        [
          {
            id: 'first',
            label: 'first',
            run: () => {
              ctrl.abort();
              return Promise.reject(seraError('NETWORK_ERROR'));
            },
          },
          {
            id: 'second',
            label: 'second',
            run: () => {
              secondCalls += 1;
              return Promise.reject(seraError('MEDIA_UNAVAILABLE'));
            },
          },
        ],
        new URL('https://example.com/v'),
        testContext({ signal: ctrl.signal }),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(secondCalls).toBe(0);

    await expect(
      runStrategies(
        [
          {
            id: 'skip-first',
            label: 'skip-first',
            available: () => false,
            run: () => Promise.reject(seraError('INTERNAL')),
          },
          {
            id: 'two',
            label: 'two',
            run: () => Promise.reject(seraError('SOURCE_BLOCKED', { detail: 'real-first' })),
          },
          {
            id: 'three',
            label: 'three',
            run: () => Promise.reject(seraError('NETWORK_ERROR')),
          },
        ],
        new URL('https://example.com/v'),
        testContext(),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
  });

  it('never fires watchGrowth onStall after stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-watch-'));
    let stalled = false;
    try {
      const stop = watchGrowth(dir, 20, () => {
        stalled = true;
      });
      stop();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles non-JSON remote node responses cleanly and retains nodes over transient refresh errors', async () => {
    let failNodes = false;
    let nodeGets = 0;
    const srv = createServer((req, res) => {
      if (req.url === '/internal/extraction/nodes') {
        nodeGets += 1;
        if (failNodes) {
          res.writeHead(500).end('err');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            nodes: [
              {
                id: 'n1',
                providers: ['youtube'],
                networkClass: 'residential',
                capacity: 1,
                inFlight: 0,
                lastSeenMs: 10,
                healthy: true,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/internal/extraction/dispatch') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not json</html>');
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()));
    const port = (srv.address() as { port: number }).port;
    const remote = new RemoteOverHttp(`http://127.0.0.1:${port}`, 'tok', silentLogger(), 5000, 10);
    try {
      await (remote as unknown as { refresh(): Promise<void> }).refresh();
      expect(remote.hasHealthyNode()).toBe(true);
      failNodes = true;
      await (remote as unknown as { refresh(): Promise<void> }).refresh();
      const getsBefore = nodeGets;
      expect(remote.status()).toHaveLength(1);
      expect(remote.status()).toHaveLength(1);
      expect(nodeGets).toBe(getsBefore);

      await expect(
        remote.dispatch({
          kind: 'resolve',
          url: 'https://www.youtube.com/watch?v=x',
          providerId: 'youtube',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    } finally {
      remote.close();
      await new Promise<void>((done) => srv.close(() => done()));
    }
  });
});

describe('audit pass 2 regressions', () => {
  it('accepts ~34k-char info tokens (<40k MAX_INFO_TOKEN_LENGTH) and rejects >40k tokens', async () => {
    const config = testConfig();
    const resolver = new MediaResolver({ config, logger: silentLogger() });
    try {
      const longUrl = `https://example.com/${'a'.repeat(25_000)}`;
      const longToken = signToken({ u: longUrl, p: 'generic' }, config.secret, 600);
      expect(longToken.length).toBeGreaterThan(30_000);
      expect(longToken.length).toBeLessThanOrEqual(40_000);
      expect(resolver.verifyInfoId(longToken).u).toBe(longUrl);

      const oversizedUrl = `https://example.com/${'a'.repeat(35_000)}`;
      const oversizedToken = signToken({ u: oversizedUrl, p: 'generic' }, config.secret, 600);
      expect(oversizedToken.length).toBeGreaterThan(40_000);
      expect(() => resolver.verifyInfoId(oversizedToken)).toThrow();
    } finally {
      await resolver.close();
    }
  });

  it('rejects PE executable direct downloads, oversized combined multi-file outputs, and keeps info.json outside scratch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-runner-sec-'));
    const srv = createServer((req, res) => {
      if (req.url === '/exe.mp4') {
        res
          .writeHead(200, { 'content-type': 'video/mp4' })
          .end(Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64)]));
        return;
      }
      if (req.url === '/img1.jpg' || req.url === '/img2.jpg') {
        res
          .writeHead(200, { 'content-type': 'image/jpeg' })
          .end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600)]));
        return;
      }
      if (req.url === '/small.jpg') {
        res
          .writeHead(200, { 'content-type': 'image/jpeg' })
          .end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()));
    const port = (srv.address() as { port: number }).port;
    const config = testConfig({
      SERA_DATA_DIR: dir,
      SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
      SERA_MAX_FILESIZE_BYTES: '1000',
    });
    const resolver = new MediaResolver({ config, logger: silentLogger() });
    const workspaces = new WorkspaceManager(dir, 600, silentLogger());
    const runner = new JobRunner({ config, logger: silentLogger(), resolver, workspaces });

    try {
      const exePlan = {
        kind: 'video' as const,
        container: 'mp4' as const,
        label: 'Video',
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct' as const, url: `http://127.0.0.1:${port}/exe.mp4` },
      };
      const exeResolved: ResolvedMedia = {
        provider: 'generic',
        providerLabel: 'Web',
        url: `http://127.0.0.1:${port}/exe.mp4`,
        type: 'single',
        title: 'exe-test',
        items: [{ index: 0, kind: 'video', plans: [exePlan] }],
      };
      await expect(
        runner.run(
          {
            jobId: 'deadbeef0000000000000001',
            provider: 'generic',
            url: exeResolved.url,
            packaging: 'auto',
            resolvedMedia: exeResolved,
            selections: [{ itemIndex: 0, planKey: planKey(exePlan) }],
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });

      const jpg1Plan = {
        kind: 'image' as const,
        container: 'jpg' as const,
        label: 'Image',
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct' as const, url: `http://127.0.0.1:${port}/img1.jpg` },
      };
      const jpg2Plan = {
        ...jpg1Plan,
        fetch: { via: 'direct' as const, url: `http://127.0.0.1:${port}/img2.jpg` },
      };
      const pairResolved: ResolvedMedia = {
        provider: 'generic',
        providerLabel: 'Web',
        url: `http://127.0.0.1:${port}/gallery`,
        type: 'collection',
        title: 'pair-test',
        items: [
          { index: 0, kind: 'image', plans: [jpg1Plan] },
          { index: 1, kind: 'image', plans: [jpg2Plan] },
        ],
      };
      await expect(
        runner.run(
          {
            jobId: 'deadbeef0000000000000002',
            provider: 'generic',
            url: pairResolved.url,
            packaging: 'auto',
            resolvedMedia: pairResolved,
            selections: [
              { itemIndex: 0, planKey: planKey(jpg1Plan) },
              { itemIndex: 1, planKey: planKey(jpg2Plan) },
            ],
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'TOO_LARGE' });

      const smallPlan = {
        kind: 'image' as const,
        container: 'jpg' as const,
        label: 'Image',
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct' as const, url: `http://127.0.0.1:${port}/small.jpg` },
      };
      const smallResolved: ResolvedMedia = {
        provider: 'generic',
        providerLabel: 'Web',
        url: `http://127.0.0.1:${port}/small.jpg`,
        type: 'single',
        title: 'small-test',
        items: [{ index: 0, kind: 'image', plans: [smallPlan] }],
      };
      const result = await runner.run(
        {
          jobId: 'deadbeef0000000000000003',
          provider: 'generic',
          url: smallResolved.url,
          packaging: 'auto',
          resolvedMedia: smallResolved,
          rawInfoJson: JSON.stringify({ id: '1' }),
          selections: [{ itemIndex: 0, planKey: planKey(smallPlan) }],
        },
        () => undefined,
      );
      expect(result.filename.endsWith('.jpg')).toBe(true);
      expect(existsSync(join(dir, 'deadbeef0000000000000003', 'info-0', 'info.json'))).toBe(false);
      expect(existsSync(join(dir, 'deadbeef0000000000000003', 'work', 'info.json'))).toBe(false);
    } finally {
      await resolver.close();
      await rm(dir, { recursive: true, force: true });
      await new Promise<void>((done) => srv.close(() => done()));
    }
  });

  it('cancels a queued job cleanly before worker execution starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-cancel-'));
    const config = testConfig({ SERA_DATA_DIR: dir });
    const resolver = new MediaResolver({ config, logger: silentLogger() });
    const workspaces = new WorkspaceManager(dir, 600, silentLogger());
    const backend = new MemoryJobBackend(silentLogger());
    let runnerCalls = 0;
    const service = new JobService({
      config,
      logger: silentLogger(),
      resolver,
      workspaces,
      backend,
      runner: {
        run: () => {
          runnerCalls += 1;
          return Promise.reject(seraError('INTERNAL'));
        },
      } as unknown as JobRunner,
    });

    try {
      const infoToken = signToken({ u: 'https://example.com/v', p: 'generic' }, config.secret, 600);
      const hash = resolver.resolutionHash('https://example.com/v', 'generic');
      const optionToken = signToken(
        { h: hash, i: 0, k: 'video:mp4:720p:best' },
        config.secret,
        600,
      );

      const job = await service.create(
        { infoId: infoToken, optionIds: [optionToken], packaging: 'auto' },
        'client-1',
      );
      expect(job.state).toBe('queued');
      expect(await service.cancel(job.id, 'client-1')).toBe(true);

      const worker = service.startWorker(1);
      await new Promise((r) => setTimeout(r, 40));
      await worker.close();

      expect(runnerCalls).toBe(0);
      expect((await service.get(job.id, 'client-1'))?.state).toBe('cancelled');
    } finally {
      await resolver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks non-standard ports in EgressGuard and confines yt-dlp selectors to http protocols', async () => {
    const guard = new EgressGuard({
      resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      allowPrivateAddresses: false,
      allowNonStandardPorts: false,
    });
    try {
      const proxy = await guard.proxyUrl();
      const proxyUrl = new URL(proxy);
      const status = await new Promise<number>((resolve, reject) => {
        import('node:http')
          .then(({ request }) => {
            const clientReq = request(
              {
                host: proxyUrl.hostname,
                port: Number(proxyUrl.port),
                method: 'GET',
                path: 'http://example.com:8080/secret',
              },
              (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
              },
            );
            clientReq.on('error', reject);
            clientReq.end();
          })
          .catch(reject);
      });
      expect(status).toBe(403);
      expect(confineToHttp('bestvideo+bestaudio')).toContain("protocol~='^(https?|m3u8");
    } finally {
      await guard.close();
    }
  });

  it('matches www-stripped hosts, subdomains, and queryless canonical URLs in Denylist', () => {
    const list = new Denylist();
    list.blockHost('WWW.BadSite.COM.');
    expect(list.isBlocked('https://sub.badsite.com/path').blocked).toBe(true);
    list.blockUrl('https://good.example/post/42');
    expect(list.isBlocked('https://good.example/post/42?utm=1').blocked).toBe(true);
  });

  it('ignores empty User-agent lines when parsing robots.txt', () => {
    const rules = parseRobots('User-agent:\nDisallow: /\n\nUser-agent: *\nAllow: /', 'SERABot');
    expect(isRobotsAllowed(rules, '/video.mp4')).toBe(true);
  });

  it('evicts stale AbuseGuard entries incrementally without dropping active blocks', () => {
    const guard = new AbuseGuard({
      maxFailures: 2,
      windowMs: 1000,
      cooldownMs: 20_000,
      maxTracked: 20,
    });
    guard.recordFailure('hot', 'INVALID_URL', 1000);
    guard.recordFailure('hot', 'INVALID_URL', 1000);
    for (let i = 0; i < 60; i += 1) {
      guard.recordFailure(`stale-${i}`, 'INVALID_URL', 1000);
    }
    guard.recordFailure('trigger', 'INVALID_URL', 10_000);
    expect(() => guard.assertAllowed('hot', 10_000)).toThrow();
  });

  it('never leaves dangling UTF-16 surrogates in sliceUtf16Safe or contentDispositionValue', () => {
    const emojis = '🎵'.repeat(20);
    const sliced = sliceUtf16Safe(emojis, 5);
    expect(sliced).toBe('🎵🎵');
    expect(contentDispositionValue(`${'🎵'.repeat(80)}.mp4`)).toContain("filename*=UTF-8''");
  });

  it('prioritizes definitive ErrorCodes over bot phrases in classifyFailure and retains failures in runStrategies', async () => {
    expect(
      classifyFailure(
        seraError('DRM_PROTECTED', { detail: "Sign in to confirm you're not a bot" }),
      ),
    ).toBe('PRIVATE_CONTENT');
    expect(classifyFailure(seraError('UNSUPPORTED_SOURCE', { detail: 'HTTP Error 403' }))).toBe(
      'UNSUPPORTED_MEDIA',
    );

    await expect(
      runStrategies(
        [
          {
            id: 'primary',
            label: 'primary',
            run: () => Promise.reject(seraError('UNSUPPORTED_SOURCE', { detail: 'explicit' })),
          },
          {
            id: 'secondary',
            label: 'secondary',
            run: () => Promise.reject(seraError('NETWORK_ERROR')),
          },
        ],
        new URL('https://example.com/item'),
        testContext(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
  });

  it('skips non-media og:video:type and survives malformed JSON-LD in discoverMedia', () => {
    const htmlPage = discoverMedia(
      `<html><head>
        <meta property="og:video" content="https://example.com/embed.html" />
        <meta property="og:video:type" content="text/html" />
      </head></html>`,
      new URL('https://example.com/post'),
    );
    expect(htmlPage.media).toEqual([]);

    const page = discoverMedia(
      `<html><head>
        <meta property="og:video" content="https://example.com/clip.mp4" />
        <script type="application/ld+json">{"@graph":{"@type":"VideoObject"},"name":42,"author":{"name":99}}</script>
      </head></html>`,
      new URL('https://example.com/post'),
    );
    expect(page.media.map((m) => m.url)).toEqual(['https://example.com/clip.mp4']);
    expect(page.title).toBeUndefined();
    expect(page.author).toBe('example.com');
  });

  it('parses nested spans with cheerio and rejects unsafe ports/userinfo in threads-embed', async () => {
    const media = await readViaEmbed(
      new URL('https://www.threads.com/@alice/post/Nested1'),
      () =>
        Promise.resolve({
          body: '<div class="OuterContainerFull"><img src="https://user@scontent.cdninstagram.com:8443/v/t51.12345-15/bad.jpg" /><img src="https://scontent.cdninstagram.com/v/t51.12345-15/good.jpg" /><div class="BodyTextContainer"><span>Hello <span>world</span>!</span></div></div>PostDateContainer',
        }),
      10,
    );
    expect(media.items).toHaveLength(1);
    expect(media.items[0]?.sourceId).toBe('good.jpg');
    expect(media.title).toContain('Hello world!');
  });

  it('handles www.t.co and avoids assigning mp4 sources to thumbnailUrl in TwitterProvider', async () => {
    const provider = new TwitterProvider();
    expect(provider.canHandle(new URL('https://www.t.co/AbCd'), 'www.t.co')).toBe(true);

    const resolved = await provider.resolve(
      new URL('https://x.com/user/status/999'),
      testContext({
        fetchText: (target) => {
          const s = target.toString();
          if (s.includes('api.fxtwitter.com')) {
            return Promise.resolve({
              url: s,
              body: JSON.stringify({
                tweet: {
                  id: '999',
                  author: { name: 'Bob', screen_name: 'bob' },
                  media: {
                    all: [
                      {
                        type: 'video',
                        url: 'https://video.twimg.com/ext_tw_video/1/vid/720x1280/clip.mp4',
                        width: 720,
                        height: 1280,
                      },
                    ],
                  },
                },
              }),
            });
          }
          return Promise.reject(seraError('UNSUPPORTED_SOURCE'));
        },
      }),
    );
    expect(resolved.items[0]?.thumbnailUrl).toBeUndefined();
  });

  it('sanitizes YtdlpProvider URLs, honors 1-based playlist_index, and flags is_upcoming live status', async () => {
    class TestYtdlpProvider extends YtdlpProvider {
      readonly id = 'test-ytdlp';
      readonly label = 'Test';
      readonly hosts = ['example.com'];
    }
    const provider = new TestYtdlpProvider();
    const info: YtdlpInfo = {
      id: 'pl',
      title: 'Upcoming',
      webpage_url: 'javascript:alert(1)',
      uploader_url: 'http://user:pass@example.com:8080/ch',
      playlist_index: 3,
      live_status: 'is_upcoming',
      ext: 'mp4',
      formats: [
        { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360, width: 640 },
      ],
    };
    const resolved = await provider.resolve(
      new URL('https://example.com/watch?v=1'),
      testContext({ probe: () => Promise.resolve(info) }),
    );
    expect(resolved.url).toBe('https://example.com/watch?v=1');
    expect(resolved.authorUrl).toBeUndefined();
    expect(resolved.items[0]?.index).toBe(2);
    expect(resolved.items[0]?.isLive).toBe(true);
  });

  it('keeps unrepresented progressive heights in buildVideoPlans and marks aac copyable in buildAudioPlans', () => {
    const formats: UsableFormat[] = [
      {
        id: 'v1080',
        ext: 'mp4',
        protocol: 'https',
        vcodec: 'avc1.640028',
        acodec: undefined,
        hasVideo: true,
        hasAudio: false,
        height: 1080,
        width: 1920,
        tbr: 4000,
        filesizeIsApproximate: false,
      },
      {
        id: 'p480',
        ext: 'mp4',
        protocol: 'https',
        vcodec: 'avc1.4d401f',
        acodec: 'aac',
        hasVideo: true,
        hasAudio: true,
        height: 480,
        width: 854,
        tbr: 900,
        filesizeIsApproximate: false,
      },
      {
        id: 'a128',
        ext: 'm4a',
        protocol: 'https',
        vcodec: undefined,
        acodec: 'aac',
        hasVideo: false,
        hasAudio: true,
        abr: 128,
        filesizeIsApproximate: false,
      },
    ];
    const videos = buildVideoPlans(formats, 60, {});
    expect(videos.map((v) => v.height)).toContain(480);

    const audios = buildAudioPlans(formats, 60, {});
    const m4a = audios.find((a) => a.container === 'm4a');
    expect(m4a?.requiresConversion).toBe(false);
  });
});
