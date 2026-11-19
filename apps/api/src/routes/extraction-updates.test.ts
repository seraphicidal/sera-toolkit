import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { nodeUpdateManifestSchema, type NodeUpdateManifest } from '@sera/contracts';
import { loadConfig, SeraEngine } from '@sera/engine';
import { clientKeyPlugin } from '../plugins/client.js';
import { errorHandlerPlugin } from '../plugins/errors.js';
import rateLimit from '@fastify/rate-limit';
import {
  createExtractionUpdatesService,
  registerExtractionUpdateRoutes,
  type ExtractionUpdatesOptions,
} from './extraction-updates.js';

const NODE_TOKEN = 'updates-node-token-0123456789';
const WORKER_TOKEN = 'updates-worker-token-0123456789';

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function createUpdatesApp(
  envOverrides: Record<string, string> = {},
  serviceOptions: ExtractionUpdatesOptions = {},
): Promise<{
  app: FastifyInstance;
  engine: SeraEngine;
  dataDir: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sera-updates-'));
  const engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'updates-secret',
      SERA_DATA_DIR: dataDir,
      SERA_EXTRACTION_NODE_TOKENS: `android:${NODE_TOKEN}`,
      SERA_EXTRACTION_WORKER_TOKEN: WORKER_TOKEN,
      ...envOverrides,
    }),
  });
  const app = Fastify({
    loggerInstance: engine.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(errorHandlerPlugin);
  await app.register(clientKeyPlugin, { engine });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.clientKey,
    allowList: (request) => request.canary,
  });
  const updates = createExtractionUpdatesService(engine, serviceOptions);
  registerExtractionUpdateRoutes(app, engine, updates);
  await app.ready();
  return { app, engine, dataDir };
}

describe('extraction update endpoints', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn().catch(() => undefined);
    }
  });

  it('rejects unauthenticated, wrong-token, and worker-token callers with 401 and rate-limits bad callers', async () => {
    const { app, engine, dataDir } = await createUpdatesApp();
    cleanups.push(async () => {
      await app.close();
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    for (const path of [
      '/internal/extraction/updates/manifest',
      '/internal/extraction/updates/ytdlp',
      '/internal/extraction/updates/apk',
    ]) {
      const anon = await app.inject({ method: 'GET', url: path });
      expect(anon.statusCode, path).toBe(401);
      expect(anon.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

      const worker = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      });
      expect(worker.statusCode, path).toBe(401);
    }

    let saw429 = false;
    for (let i = 0; i < 35; i += 1) {
      const bad = await app.inject({
        method: 'GET',
        url: '/internal/extraction/updates/manifest',
        headers: { authorization: 'Bearer bad-token' },
      });
      if (bad.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);

    const valid = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/manifest',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(valid.statusCode).toBe(200);
  });

  it('reads tools.manifest.json, filters internal potProviderUrl, and applies local overrides', async () => {
    const toolsDir = await mkdtemp(join(tmpdir(), 'sera-tools-manifest-'));
    const manifestPath = join(toolsDir, 'tools.manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        ytdlp: {
          version: '2026.11.01',
          repo: 'yt-dlp/yt-dlp',
          checksumAsset: 'SHA2-256SUMS',
          assets: { 'android-arm64': 'yt-dlp' },
        },
      }),
    );

    const { app, engine, dataDir } = await createUpdatesApp(
      {
        SERA_YOUTUBE_PLAYER_CLIENTS: 'web_safari,android',
        SERA_YOUTUBE_POT_PROVIDER_URL: 'http://potoken:4416',
      },
      { toolsManifestPath: manifestPath },
    );
    cleanups.push(async () => {
      await app.close();
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/manifest',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = nodeUpdateManifestSchema.parse(res.json());
    expect(res.headers['x-sera-manifest-hash']).toBe(body.manifestHash);
    expect(body.ytdlp.version).toBe('2026.11.01');
    expect(body.ytdlp.assetName).toBe('yt-dlp');
    expect(body.ytdlp.proxyPath).toBe('/internal/extraction/updates/ytdlp');
    expect(body.androidNodeApp).toBeUndefined();
    expect(body.providerConfig.youtube.playerClients).toEqual(['web_safari', 'android']);
    expect(body.providerConfig.youtube.remoteComponents).toEqual(['ejs:github']);
    expect(body.providerConfig.youtube.potProviderUrl).toBeUndefined();
    expect(body.providerConfig.instagram).toMatchObject({
      webApiAppId: '936619743392459',
      cdnHosts: ['cdninstagram.com', 'fbcdn.net'],
      strategyOrder: ['ytdlp', 'web-api', 'oembed'],
    });

    const apkSha = sha256Hex('fake-apk-payload');
    await mkdir(join(dataDir, 'updates'), { recursive: true });
    await writeFile(
      join(dataDir, 'updates', 'android-node.json'),
      JSON.stringify({
        versionCode: 12,
        versionName: '1.2.0',
        sha256: apkSha,
        apkUrl:
          'https://github.com/seraphicidal/sera-toolkit/releases/download/v1.2.0/sera-node.apk',
        minVersionCode: 10,
      }),
    );
    await writeFile(
      join(dataDir, 'updates', 'manifest.json'),
      JSON.stringify({
        ytdlp: { sha256: sha256Hex('ytdlp-bin') },
        providerConfig: {
          youtube: {
            extraArgs: ['--sleep-requests', '1'],
            potProviderUrl: 'https://pot.example.com',
          },
        },
      }),
    );

    const updatedRes = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/manifest',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(updatedRes.statusCode).toBe(200);
    const updated = updatedRes.json<NodeUpdateManifest>();
    expect(updated.manifestHash).not.toBe(body.manifestHash);
    expect(updated.ytdlp.sha256).toBe(sha256Hex('ytdlp-bin'));
    expect(updated.androidNodeApp).toMatchObject({
      versionCode: 12,
      versionName: '1.2.0',
      sha256: apkSha,
      proxyPath: '/internal/extraction/updates/apk',
      minVersionCode: 10,
    });
    expect(updated.providerConfig.youtube.extraArgs).toEqual(['--sleep-requests', '1']);
    expect(updated.providerConfig.youtube.potProviderUrl).toBe('https://pot.example.com');
  });

  it('fetches GitHub Releases with TTL caching and proxies/caches SHA-256 verified ytdlp and apk', async () => {
    const ytdlpBinary = Buffer.from('#!/usr/bin/env python3\nprint("yt-dlp")\n');
    const ytdlpSha = sha256Hex(ytdlpBinary);
    const apkBinary = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('apk-data'),
    ]);
    const apkSha = sha256Hex(apkBinary);

    const calls: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);

      if (url === 'https://api.github.com/repos/seraphicidal/sera-toolkit/releases?per_page=10') {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'android-node-v1.5.0',
              draft: false,
              body: 'Cellular upload fix',
              assets: [
                {
                  name: 'android-node-manifest.json',
                  browser_download_url:
                    'https://github.com/seraphicidal/sera-toolkit/releases/download/android-node-v1.5.0/android-node-manifest.json',
                },
                {
                  name: 'sera-node-1.5.0.apk',
                  browser_download_url:
                    'https://github.com/seraphicidal/sera-toolkit/releases/download/android-node-v1.5.0/sera-node-1.5.0.apk',
                },
              ],
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith('/android-node-manifest.json')) {
        return new Response(
          JSON.stringify({
            versionCode: 15,
            versionName: '1.5.0',
            sha256: apkSha,
            assetName: 'sera-node-1.5.0.apk',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest') {
        return new Response(JSON.stringify({ tag_name: '2026.11.15' }), { status: 200 });
      }
      if (url === 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.15/SHA2-256SUMS') {
        return new Response(`${ytdlpSha}  yt-dlp\n`, { status: 200 });
      }
      if (url === 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.15/yt-dlp') {
        return new Response(ytdlpBinary, { status: 200 });
      }
      if (url.endsWith('/sera-node-1.5.0.apk')) {
        return new Response(apkBinary, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const { app, engine, dataDir } = await createUpdatesApp(
      {},
      {
        fetch: mockFetch,
        enableRemoteLookup: true,
        ytdlpTrack: 'latest',
        cacheTtlMs: 60_000,
      },
    );
    cleanups.push(async () => {
      await app.close();
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const manifest1 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/manifest',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(manifest1.statusCode).toBe(200);
    const m1 = manifest1.json<NodeUpdateManifest>();
    expect(m1.ytdlp.version).toBe('2026.11.15');
    expect(m1.ytdlp.sha256).toBe(ytdlpSha);
    expect(m1.androidNodeApp).toMatchObject({
      versionCode: 15,
      versionName: '1.5.0',
      sha256: apkSha,
      releaseNotes: 'Cellular upload fix',
      proxyPath: '/internal/extraction/updates/apk',
    });

    const callsAfterManifest = calls.length;
    const manifest2 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/manifest',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(manifest2.statusCode).toBe(200);
    expect(manifest2.json<NodeUpdateManifest>().manifestHash).toBe(m1.manifestHash);
    expect(calls.length).toBe(callsAfterManifest);

    const ytdlpRes1 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/ytdlp',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(ytdlpRes1.statusCode).toBe(200);
    expect(ytdlpRes1.headers['x-sera-sha256']).toBe(ytdlpSha);
    expect(ytdlpRes1.rawPayload).toEqual(ytdlpBinary);

    const callsAfterYtdlp1 = calls.length;
    const ytdlpRes2 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/ytdlp',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(ytdlpRes2.statusCode).toBe(200);
    expect(ytdlpRes2.rawPayload).toEqual(ytdlpBinary);
    expect(calls.length).toBe(callsAfterYtdlp1);

    const ytdlpNotModified = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/ytdlp',
      headers: {
        authorization: `Bearer ${NODE_TOKEN}`,
        'if-none-match': `"${ytdlpSha}"`,
      },
    });
    expect(ytdlpNotModified.statusCode).toBe(304);

    const apkRes1 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/apk',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(apkRes1.statusCode).toBe(200);
    expect(apkRes1.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(apkRes1.headers['x-sera-sha256']).toBe(apkSha);
    expect(apkRes1.rawPayload).toEqual(apkBinary);

    const callsAfterApk1 = calls.length;
    const apkRes2 = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/apk',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(apkRes2.statusCode).toBe(200);
    expect(calls.length).toBe(callsAfterApk1);

    const cacheEntries = await readdir(join(dataDir, 'updates', 'cache'));
    expect(cacheEntries.some((entry) => entry.startsWith('ytdlp-'))).toBe(true);
    expect(cacheEntries.some((entry) => entry.startsWith('apk-'))).toBe(true);
  });

  it('rejects checksum mismatches and non-APK payloads without caching tampered artifacts', async () => {
    const tamperedBytes = Buffer.from('not-really-an-apk');
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/SHA2-256SUMS')) {
        return new Response(`${'a'.repeat(64)}  yt-dlp\n`, { status: 200 });
      }
      return new Response(tamperedBytes, { status: 200 });
    };

    const { app, engine, dataDir } = await createUpdatesApp(
      {},
      { fetch: mockFetch, enableRemoteLookup: true },
    );
    cleanups.push(async () => {
      await app.close();
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const badYtdlp = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/ytdlp',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(badYtdlp.statusCode).toBe(503);

    const missingApk = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/apk',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(missingApk.statusCode).toBe(404);

    await mkdir(join(dataDir, 'updates'), { recursive: true });
    await writeFile(
      join(dataDir, 'updates', 'android-node.json'),
      JSON.stringify({
        versionCode: 20,
        versionName: '2.0.0',
        sha256: sha256Hex(tamperedBytes),
        apkUrl: 'https://github.com/seraphicidal/sera-toolkit/releases/download/v2.0.0/bad.apk',
      }),
    );

    const notAZipApk = await app.inject({
      method: 'GET',
      url: '/internal/extraction/updates/apk',
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(notAZipApk.statusCode).toBe(503);

    const cacheDir = join(dataDir, 'updates', 'cache');
    const files = existsSync(cacheDir) ? await readdir(cacheDir) : [];
    expect(files.filter((name) => !name.endsWith('.sha256'))).toEqual([]);
  });
});
