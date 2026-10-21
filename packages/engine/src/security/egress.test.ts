import { spawnSync } from 'node:child_process';
import type { LookupAddress } from 'node:dns';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { SeraError } from '../errors.js';
import { download } from '../extract/ytdlp.js';
import { confineToHttp, EgressGuard } from './egress.js';
import { isPublicAddress } from './ip.js';

function table(entries: Record<string, string[]>) {
  return (hostname: string): Promise<LookupAddress[]> => {
    const addresses = entries[hostname];
    if (!addresses) {
      return Promise.reject(Object.assign(new Error(`no ${hostname}`), { code: 'ENOTFOUND' }));
    }
    return Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return SeraError.from(error).code;
  }
  return 'resolved';
}

describe('EgressGuard.assertPublicDestination', () => {
  const guard = new EgressGuard({
    resolve: table({
      'video.example': ['93.184.216.34'],
      'intranet.example': ['10.1.2.3'],
      'home.example': ['192.168.1.20'],
      'loopback.example': ['127.0.0.1'],
      'metadata.example': ['169.254.169.254'],
      'metadata6.example': ['fd00:ec2::254'],
      'v6-loopback.example': ['::1'],
      'mapped.example': ['::ffff:127.0.0.1'],
      'link-local6.example': ['fe80::1'],
      'split.example': ['93.184.216.34', '10.0.0.1'],
    }),
  });

  it('lets a public site through', async () => {
    await expect(
      guard.assertPublicDestination('https://video.example/watch/1'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['an intranet address', 'http://intranet.example/'],
    ['a home network', 'http://home.example/'],
    ['loopback', 'http://loopback.example/video.mp4'],
    ['cloud metadata', 'http://metadata.example/latest/meta-data'],
    ['IPv6 cloud metadata', 'http://metadata6.example/'],
    ['IPv6 loopback', 'http://v6-loopback.example/'],
    ['an IPv4-mapped address', 'http://mapped.example/'],
    ['link-local IPv6', 'http://link-local6.example/'],
    ['a literal IPv4 loopback', 'http://127.0.0.1/video.mp4'],
    ['a literal IPv6 loopback', 'http://[::1]/video.mp4'],
    ['a literal metadata address', 'http://169.254.169.254/secret'],
    ['a name that resolves to a public and a private address', 'http://split.example/'],
  ])('refuses %s', async (_label, url) => {
    expect(await codeOf(guard.assertPublicDestination(url))).toBe('BLOCKED_ADDRESS');
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://video.example/file.mp4'],
    ['rtmp', 'rtmp://video.example/live/1'],
    ['rtsp', 'rtsp://video.example/stream'],
    ['mms', 'mms://video.example/stream'],
    ['data', 'data:text/plain;base64,AAAA'],
  ])('refuses %s protocol', async (_label, url) => {
    expect(await codeOf(guard.assertPublicDestination(url))).toBe('BLOCKED_ADDRESS');
  });

  it('allows private destination when allowPrivateAddresses is true', async () => {
    const permissive = new EgressGuard({
      resolve: table({
        'intranet.example': ['10.1.2.3'],
      }),
      allowPrivateAddresses: true,
    });
    await expect(
      permissive.assertPublicDestination('http://intranet.example/video.mp4'),
    ).resolves.toBeUndefined();
  });
});

let origin: Server;
let originPort: number;
const served: string[] = [];

let guard: EgressGuard;
let proxyUrl: string;

beforeAll(async () => {
  origin = createServer((req, res) => {
    served.push(req.url ?? '');
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
      return;
    }
    if (req.url === '/to-intranet') {
      res.writeHead(302, { location: 'http://intranet.test/secret' }).end();
      return;
    }
    if (req.url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      return;
    }
    if (req.url === '/to-self') {
      res.writeHead(302, { location: `http://site.test:${String(originPort)}/hello` }).end();
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((done) => {
    origin.listen(0, '127.0.0.1', () => {
      originPort = (origin.address() as { port: number }).port;
      done();
    });
  });

  guard = new EgressGuard({
    resolve: table({
      'site.test': ['127.0.0.1'],
      'intranet.test': ['10.0.0.5'],
      'metadata.test': ['169.254.169.254'],
      'loopback.test': ['127.0.0.2'],
    }),
    isAllowedAddress: (address) => address === '127.0.0.1' || isPublicAddress(address),
    connectTimeoutMs: 2_000,
  });
  proxyUrl = await guard.proxyUrl();
});

afterAll(async () => {
  await guard.close();
  await new Promise<void>((done) => origin.close(() => done()));
});

afterEach(() => {
  served.length = 0;
});

function viaProxy(
  url: string,
  proxyEndpoint = proxyUrl,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyEndpoint);
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: proxy.hostname,
        port: proxy.port,
        path: url,
        headers: { host: target.host },
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectVia(authority: string, proxyEndpoint = proxyUrl): Promise<string> {
  const proxy = new URL(proxyEndpoint);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.once('data', (data: string) => {
      resolve(data.split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

describe('the egress proxy', () => {
  it('forwards a request to an allowed host', async () => {
    const response = await viaProxy(`http://site.test:${String(originPort)}/hello`);
    expect(response).toEqual({ status: 200, body: 'hello' });
    expect(served).toEqual(['/hello']);
  });

  it('refuses a request whose host resolves to a private address', async () => {
    const response = await viaProxy(`http://intranet.test:${String(originPort)}/secret`);
    expect(response.status).toBe(403);
    expect(served).toEqual([]);
  });

  it('passes a redirect back instead of following it', async () => {
    const response = await viaProxy(`http://site.test:${String(originPort)}/to-intranet`);
    expect(response.status).toBe(302);
    expect(served).toEqual(['/to-intranet']);
  });

  it('opens a tunnel to an allowed host', async () => {
    expect(await connectVia(`site.test:${String(originPort)}`)).toBe(
      'HTTP/1.1 200 Connection Established',
    );
  });

  it.each([
    ['a private address', 'intranet.test:443'],
    ['cloud metadata', 'metadata.test:80'],
    ['loopback', 'loopback.test:443'],
    ['a literal metadata address', '169.254.169.254:80'],
    ['a literal IPv6 loopback', '[::1]:443'],
  ])('refuses a tunnel to %s', async (_label, authority) => {
    expect(await connectVia(authority)).toBe('HTTP/1.1 403 Forbidden');
  });

  it.each([
    ['an invalid port zero', 'site.test:0'],
    ['an invalid port too high', 'site.test:70000'],
  ])('refuses a tunnel to %s with bad request', async (_label, authority) => {
    expect(await connectVia(authority)).toBe('HTTP/1.1 400 Bad Request');
  });
});

describe('upstream proxy chaining', () => {
  let upstreamServer: Server;
  let upstreamPort: number;
  let upstreamProxyUrl: string;
  let chainedGuardUrl: string;
  const upstreamRequests: string[] = [];

  beforeAll(async () => {
    upstreamServer = createServer((req, res) => {
      upstreamRequests.push(`HTTP ${req.url ?? ''}`);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('via-upstream');
    });
    upstreamServer.on('connect', (_req, client: Duplex) => {
      upstreamRequests.push(`CONNECT ${_req.url ?? ''}`);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const originSocket = connect(originPort, '127.0.0.1', () => {
        client.pipe(originSocket);
        originSocket.pipe(client);
      });
      client.once('close', () => originSocket.destroy());
      originSocket.once('close', () => client.destroy());
    });

    await new Promise<void>((done) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (upstreamServer.address() as { port: number }).port;
        upstreamProxyUrl = `http://127.0.0.1:${String(upstreamPort)}`;
        done();
      });
    });

    chainedGuardUrl = await guard.proxyUrl(upstreamProxyUrl);
  });

  afterAll(async () => {
    await new Promise<void>((done) => upstreamServer.close(() => done()));
  });

  afterEach(() => {
    upstreamRequests.length = 0;
  });

  it('chains plain HTTP request through upstream proxy', async () => {
    const res = await viaProxy(`http://site.test:${String(originPort)}/hello`, chainedGuardUrl);
    expect(res.status).toBe(200);
    expect(res.body).toBe('via-upstream');
    expect(upstreamRequests).toContain(`HTTP http://site.test:${String(originPort)}/hello`);
  });

  it('chains CONNECT request through upstream proxy', async () => {
    const status = await connectVia(`site.test:${String(originPort)}`, chainedGuardUrl);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    expect(upstreamRequests).toContain(`CONNECT site.test:${String(originPort)}`);
  });

  it('refuses private host without forwarding to upstream proxy', async () => {
    const res = await viaProxy(
      `http://intranet.test:${String(originPort)}/secret`,
      chainedGuardUrl,
    );
    expect(res.status).toBe(403);
    expect(upstreamRequests).toHaveLength(0);
  });
});

const config = loadConfig({ NODE_ENV: 'test', SERA_SECRET: 'test-secret' });
const hasYtdlp = spawnSync(config.ytdlpPath, ['--version']).status === 0;

describe.skipIf(!hasYtdlp)('yt-dlp behind the egress proxy', () => {
  let workdir: string;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sera-egress-'));
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function fetchWithYtdlp(path: string): Promise<SeraError | undefined> {
    try {
      await download({
        binary: config.ytdlpPath,
        timeoutMs: 30_000,
        url: `http://site.test:${String(originPort)}${path}`,
        format: 'best',
        workdir,
        outputTemplate: 'media.%(ext)s',
        proxy: proxyUrl,
        useExtractors: 'default',
      });
      return undefined;
    } catch (error) {
      return SeraError.from(error);
    }
  }

  it('cannot follow a redirect onto the cloud metadata address', async () => {
    const failure = await fetchWithYtdlp('/to-metadata');
    expect(failure).toBeDefined();
    expect(failure!.detail).toMatch(/403/);
    expect(new Set(served)).toEqual(new Set(['/to-metadata']));
  });

  it('cannot follow a redirect onto a private address', async () => {
    const failure = await fetchWithYtdlp('/to-intranet');
    expect(failure).toBeDefined();
    expect(failure!.detail).toMatch(/403/);
    expect(new Set(served)).toEqual(new Set(['/to-intranet']));
  });

  it('still follows a redirect that stays on public addresses', async () => {
    await fetchWithYtdlp('/to-self');
    expect(new Set(served)).toEqual(new Set(['/to-self', '/hello']));
  });
});

describe('confineToHttp', () => {
  const HTTP = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']";

  it('filters the atoms yt-dlp chooses for itself', () => {
    expect(confineToHttp('best')).toBe(`best${HTTP}`);
    expect(confineToHttp('bestvideo+bestaudio/best')).toBe(
      `bestvideo${HTTP}+bestaudio${HTTP}/best${HTTP}`,
    );
    expect(confineToHttp('bestaudio[acodec^=mp4a]/140')).toBe(`bestaudio[acodec^=mp4a]${HTTP}/140`);
  });

  it('leaves formats chosen by id alone, since they were filtered when listed', () => {
    expect(confineToHttp('137+140')).toBe('137+140');
    expect(confineToHttp('hls-720p')).toBe('hls-720p');
  });

  it.skipIf(!hasYtdlp)('keeps yt-dlp off a format it would reach outside the proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-confine-'));
    try {
      const infoPath = join(dir, 'info.json');
      await writeFile(
        infoPath,
        JSON.stringify({
          id: 'x',
          title: 'x',
          extractor: 'test',
          extractor_key: 'Test',
          webpage_url: 'https://video.example/x',
          formats: [
            {
              format_id: 'web',
              url: 'https://video.example/x.mp4',
              ext: 'mp4',
              protocol: 'https',
              height: 360,
            },
            {
              format_id: 'stream',
              url: 'rtmp://10.0.0.5/live',
              ext: 'flv',
              protocol: 'rtmp',
              height: 1080,
            },
          ],
        }),
      );
      const pick = (selector: string): string =>
        spawnSync(
          config.ytdlpPath,
          [
            '--ignore-config',
            '--no-warnings',
            '--load-info-json',
            infoPath,
            '--simulate',
            '--print',
            'format_id',
            '-f',
            selector,
          ],
          { encoding: 'utf8' },
        ).stdout.trim();

      expect(pick('best')).toBe('stream');
      expect(pick(confineToHttp('best'))).toBe('web');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
