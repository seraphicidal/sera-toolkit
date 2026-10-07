import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, seraError, SeraEngine, type ResolvedMedia } from '@sera/engine';
import { buildServer } from '../server.js';

const TOKEN = 'test-node-token-0123456789';

const remoteMedia: ResolvedMedia = {
  provider: 'youtube',
  providerLabel: 'YouTube',
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  type: 'single',
  title: 'Resolved somewhere else',
  items: [
    {
      index: 0,
      kind: 'video',
      title: 'Resolved somewhere else',
      plans: [
        {
          kind: 'video',
          container: 'mp4',
          label: '1080p',
          requiresConversion: false,
          recommended: true,
          fetch: { via: 'ytdlp', selector: 'best' },
        },
      ],
    },
  ],
};

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;
let port: number;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-node-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'integration-secret',
      SERA_DATA_DIR: dataDir,
      SERA_EXTRACTION_NODE_TOKEN: TOKEN,
      SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      SERA_MAX_FILESIZE_BYTES: String(64 * 1024),
    }),
    probe: () =>
      Promise.reject(
        seraError('SOURCE_BLOCKED', { detail: "Sign in to confirm you're not a bot" }),
      ),
  });
  app = await buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await engine?.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

function claim(features: readonly string[] = ['trim', 'subtitles']) {
  return app.inject({
    method: 'POST',
    url: '/internal/extraction/claim',
    headers: auth,
    payload: { nodeId: 'test-node', providers: ['youtube'], capacity: 1, features },
  });
}

describe('extraction node endpoints', () => {
  it('refuses every route without the token', async () => {
    for (const url of [
      '/internal/extraction/claim',
      '/internal/extraction/abc/progress',
      '/internal/extraction/abc/resolved',
      '/internal/extraction/abc/failed',
    ]) {
      const anonymous = await app.inject({ method: 'POST', url, payload: {} });
      expect(anonymous.statusCode, url).toBe(401);
      const wrongToken = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer not-the-token' },
        payload: {},
      });
      expect(wrongToken.statusCode, url).toBe(401);
    }
  });

  it('says nothing useful to an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'POST', url: '/internal/extraction/claim' });
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('answers a claim with 204 when there is nothing to do', async () => {
    const response = await claim();
    expect(response.statusCode).toBe(204);
  });

  it('carries a resolve from the visitor to the node and back', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const visitorRequest = app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
    });

    let task: { id: string; kind: string; providerId: string; url: string } | undefined;
    for (let attempt = 0; attempt < 8 && !task; attempt += 1) {
      const response = await claim();
      if (response.statusCode === 200) task = response.json();
    }
    expect(task, 'the node was never handed the task').toBeDefined();
    expect(task!.kind).toBe('resolve');
    expect(task!.providerId).toBe('youtube');

    const reported = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task!.id}/resolved`,
      headers: auth,
      payload: { media: remoteMedia },
    });
    expect(reported.json()).toEqual({ accepted: true });

    const visitor = await visitorRequest;
    expect(visitor.statusCode).toBe(200);
    const info = visitor.json();
    expect(info.title).toBe('Resolved somewhere else');
    expect(info.items).toHaveLength(1);
    expect(info.items[0].options[0].label).toBe('1080p');
  });

  it('tells a node when the visitor has gone away', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const abort = new AbortController();
    const dispatched = engine.extractionNodes
      .dispatch(
        { kind: 'resolve', url: 'https://www.youtube.com/watch?v=x', providerId: 'youtube' },
        { signal: abort.signal },
      )
      .catch(() => undefined);

    const task = (await claim()).json();
    const before = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/progress`,
      headers: auth,
      payload: { percent: 10, step: 'Downloading' },
    });
    expect(before.json()).toEqual({ cancelled: false });

    abort.abort();
    await dispatched;

    const after = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/progress`,
      headers: auth,
      payload: { percent: 20, step: 'Downloading' },
    });
    expect(after.json()).toEqual({ cancelled: true });
  });

  it('accepts an uploaded file and hands it back as a completed job', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes.dispatchJob({
      kind: 'job',
      url: 'https://www.youtube.com/watch?v=x',
      providerId: 'youtube',
      planKeys: ['video/mp4/1080p'],
    });

    const task = (await claim()).json();
    const bytes = Buffer.from('not really an mp4, but bytes all the same');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=${encodeURIComponent('clip.mp4')}&mime=video%2Fmp4`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual({ accepted: true, sizeBytes: bytes.length });

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: auth,
      payload: {},
    });

    const files = await dispatched;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('clip.mp4');
    expect(files[0]!.mimeType).toBe('video/mp4');
    expect(await readFile(files[0]!.path)).toEqual(bytes);
  });

  it('sanitizes the name a node asks for', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes.dispatchJob({
      kind: 'job',
      url: 'https://www.youtube.com/watch?v=x',
      providerId: 'youtube',
      planKeys: ['video/mp4/1080p'],
    });
    const task = (await claim()).json();

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=${encodeURIComponent('../../escape.mp4')}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: auth,
      payload: {},
    });

    const files = await dispatched;
    expect(files[0]!.name).not.toContain('..');
    expect(files[0]!.path).toContain(task.id);
  });

  it('stops an oversized upload while it is arriving, not after', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes
      .dispatchJob({
        kind: 'job',
        url: 'https://www.youtube.com/watch?v=x',
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
      })
      .catch(() => []);
    const task = (await claim()).json();

    expect(engine.config.maxFilesizeBytes).toBe(64 * 1024);
    const oversized = Buffer.alloc(engine.config.maxFilesizeBytes + 4096, 0x41);
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/internal/extraction/${task.id}/file?name=huge.mp4`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: oversized,
      },
    );

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('TOO_LARGE');
    engine.extractionNodes.fail(task.id, seraError('TOO_LARGE'));
    expect(await dispatched).toEqual([]);
  });

  it('puts an upload where the reaper can find it on its own', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes.dispatchJob({
      kind: 'job',
      url: 'https://www.youtube.com/watch?v=x',
      providerId: 'youtube',
      planKeys: ['video/mp4/1080p'],
    });
    const task = (await claim()).json();

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=clip.mp4`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('bytes'),
    });
    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: auth,
      payload: {},
    });

    const files = await dispatched;
    expect(files[0]!.path).toContain(`remote-${task.id}`);
    expect(relative(dataDir, files[0]!.path).split(/[\\/]/)).toHaveLength(2);
  });

  it('passes a node failure through as the failure it was', async () => {
    engine.extractionNodes.register('test-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes
      .dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=x',
        providerId: 'youtube',
      })
      .then(
        () => undefined,
        (error: unknown) => error as { code: string },
      );

    const task = (await claim()).json();
    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/failed`,
      headers: auth,
      payload: { code: 'PRIVATE_CONTENT', message: 'That video is private.' },
    });

    expect((await dispatched)?.code).toBe('PRIVATE_CONTENT');
  });
});

describe('the dispatch route a standalone worker uses', () => {
  it("carries a job's trim to the node that claims it", async () => {
    const dispatched = await app.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: auth,
      payload: {
        kind: 'job',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
        trim: { start: 10, end: 30 },
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBeLessThan(300);

    expect((await claim([])).statusCode).toBe(204);
    const claimed = await claim();
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ kind: string; trim?: unknown }>()).toMatchObject({
      kind: 'job',
      trim: { start: 10, end: 30 },
    });
  });
});
