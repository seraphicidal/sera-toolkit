import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ExtractionNodeRegistry,
  JobRunner,
  loadConfig,
  seraError,
  SeraEngine,
  silentLogger,
  WorkspaceManager,
  type RemoteTask,
  type ResolvedMedia,
} from '@sera/engine';
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
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false },
    });
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

  it('enforces size limit across concurrent uploads and preserves intact files on single upload error', async () => {
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

    const chunk1 = Buffer.alloc(40 * 1024, 0x41);
    const chunk2 = Buffer.alloc(40 * 1024, 0x42);

    const [res1, res2] = await Promise.all([
      fetch(`http://127.0.0.1:${String(port)}/internal/extraction/${task.id}/file?name=part1.mp4`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: chunk1,
      }),
      fetch(`http://127.0.0.1:${String(port)}/internal/extraction/${task.id}/file?name=part2.mp4`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: chunk2,
      }),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(413);

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

  it('long-polls for progress updates and returns when progress is reported', async () => {
    const dispatched = await app.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: auth,
      payload: {
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        providerId: 'youtube',
      },
    });
    const { taskId } = dispatched.json<{ taskId: string }>();

    const pollPromise = app.inject({
      method: 'GET',
      url: `/internal/extraction/dispatch/${taskId}?wait=5`,
      headers: auth,
    });

    await new Promise((r) => setTimeout(r, 50));

    const claimRes = await app.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: auth,
      payload: {
        nodeId: 'test-node-poll',
        providers: ['youtube'],
        capacity: 1,
        features: ['trim'],
      },
    });
    expect(claimRes.statusCode).toBe(200);
    const task = claimRes.json<{ id: string }>();

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/progress`,
      headers: auth,
      payload: { percent: 42, step: 'Extracting' },
    });

    const pollRes = await pollPromise;
    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.json<{ progress?: { percent: number; step: string } }>().progress).toEqual({
      percent: 42,
      step: 'Extracting',
    });
  });
});

describe('multi-node authentication and isolation', () => {
  const LAPTOP_TOKEN = 'tok-laptop-1234567890';
  const PHONE_TOKEN = 'tok-phone-0987654321';
  const WORKER_TOKEN = 'tok-worker-abcdef123456';

  let multiDataDir: string;
  let multiEngine: SeraEngine;
  let multiApp: FastifyInstance;

  beforeAll(async () => {
    multiDataDir = await mkdtemp(join(tmpdir(), 'sera-multi-node-'));
    multiEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'integration-secret',
        SERA_DATA_DIR: multiDataDir,
        SERA_EXTRACTION_NODE_TOKENS: `laptop:${LAPTOP_TOKEN},phone:${PHONE_TOKEN}`,
        SERA_EXTRACTION_NODE_TOKEN: 'old-legacy-secret',
        SERA_EXTRACTION_WORKER_TOKEN: WORKER_TOKEN,
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
    });
    multiApp = await buildServer(multiEngine);
    await multiApp.ready();
  });

  afterAll(async () => {
    await multiApp?.close();
    await multiEngine?.close?.();
    await rm(multiDataDir, { recursive: true, force: true });
  });

  it('rejects old legacy shared token when per-node tokens are configured', async () => {
    const legacyClaim = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: 'Bearer old-legacy-secret' },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    expect(legacyClaim.statusCode).toBe(401);
  });

  it('allows laptop and phone to claim with their respective tokens', async () => {
    const laptopClaim = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    expect(laptopClaim.statusCode).toBe(204);

    const phoneClaim = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      payload: { nodeId: 'phone', providers: ['youtube'], capacity: 1 },
    });
    expect(phoneClaim.statusCode).toBe(204);
  });

  it('rejects claim with wrong token with 401', async () => {
    const wrong = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('rejects claim when token does not match claimed nodeId with 403', async () => {
    const mismatch = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { nodeId: 'phone', providers: ['youtube'], capacity: 1 },
    });
    expect(mismatch.statusCode).toBe(403);
  });

  it('rejects node token on worker dispatch and nodes endpoints with 401', async () => {
    const dispatchWithNode = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { kind: 'resolve', url: 'https://www.youtube.com/watch?v=x', providerId: 'youtube' },
    });
    expect(dispatchWithNode.statusCode).toBe(401);

    const nodesWithNode = await multiApp.inject({
      method: 'GET',
      url: '/internal/extraction/nodes',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
    });
    expect(nodesWithNode.statusCode).toBe(401);
  });

  it('accepts worker token on dispatch and nodes endpoints', async () => {
    const nodes = await multiApp.inject({
      method: 'GET',
      url: '/internal/extraction/nodes',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    expect(nodes.statusCode).toBe(200);

    const dispatch = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { kind: 'resolve', url: 'https://www.youtube.com/watch?v=x', providerId: 'youtube' },
    });
    expect(dispatch.statusCode).toBe(200);

    const { taskId } = dispatch.json<{ taskId: string }>();
    await multiApp.inject({
      method: 'DELETE',
      url: `/internal/extraction/dispatch/${taskId}`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
  });

  it('prevents a different node from modifying or completing a claimed task', async () => {
    multiEngine.extractionNodes.register('laptop', ['youtube'], 1);
    const resolvePromise = multiEngine.extractionNodes.dispatch({
      kind: 'resolve',
      url: 'https://www.youtube.com/watch?v=test',
      providerId: 'youtube',
    });

    const claimed = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    expect(claimed.statusCode).toBe(200);
    const task = claimed.json<{ id: string }>();

    const phoneProgress = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/progress`,
      headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      payload: { percent: 50, step: 'downloading' },
    });
    expect(phoneProgress.statusCode).toBe(403);

    const phoneResolved = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/resolved`,
      headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      payload: { media: remoteMedia },
    });
    expect(phoneResolved.statusCode).toBe(403);

    const phoneFailed = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/failed`,
      headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      payload: { code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(phoneFailed.statusCode).toBe(403);

    const phoneFile = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file`,
      headers: {
        authorization: `Bearer ${PHONE_TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('bytes'),
    });
    expect(phoneFile.statusCode).toBe(403);

    const phoneComplete = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: { authorization: `Bearer ${PHONE_TOKEN}` },
      payload: {},
    });
    expect(phoneComplete.statusCode).toBe(403);

    const laptopResolved = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/resolved`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { media: remoteMedia },
    });
    expect(laptopResolved.statusCode).toBe(200);
    await resolvePromise;
  });

  it('returns 404 for task operations when taskId is unknown or unowned', async () => {
    const unknownId = '11112222333344445555666677778888';
    const progress = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${unknownId}/progress`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { percent: 10, step: 'resolving' },
    });
    expect(progress.statusCode).toBe(404);

    const failed = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${unknownId}/failed`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(failed.statusCode).toBe(404);

    const complete = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${unknownId}/complete`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: {},
    });
    expect(complete.statusCode).toBe(404);

    const file = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${unknownId}/file`,
      headers: {
        authorization: `Bearer ${LAPTOP_TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('data'),
    });
    expect(file.statusCode).toBe(404);
  });

  it('rejects malformed resolved payload with 400', async () => {
    multiEngine.extractionNodes.register('laptop', ['youtube'], 1);
    const resolvePromise = multiEngine.extractionNodes
      .dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=badpayload',
        providerId: 'youtube',
      })
      .catch(() => undefined);

    const claimed = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    const task = claimed.json<{ id: string }>();

    const badPayload = await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/resolved`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { media: { invalid: true } },
    });
    expect(badPayload.statusCode).toBe(400);

    multiEngine.extractionNodes.fail(task.id, seraError('SOURCE_BLOCKED'));
    await resolvePromise;
  });

  it('wakes dispatch long-poll immediately on initial progress transition', async () => {
    multiEngine.extractionNodes.register('laptop', ['youtube'], 1);
    const dispatch = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: {
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=wake',
        providerId: 'youtube',
      },
    });
    const { taskId } = dispatch.json<{ taskId: string }>();

    const claimed = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
    });
    const task = claimed.json<{ id: string }>();

    const pollPromise = multiApp.inject({
      method: 'GET',
      url: `/internal/extraction/dispatch/${taskId}?wait=5`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    await new Promise((r) => setTimeout(r, 30));
    await multiApp.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/progress`,
      headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
      payload: { percent: 25, step: 'Resolving stream' },
    });

    const polled = await pollPromise;
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({
      state: 'pending',
      progress: { percent: 25, step: 'Resolving stream' },
    });

    await multiApp.inject({
      method: 'DELETE',
      url: `/internal/extraction/dispatch/${taskId}`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
  });

  it('returns 400 on array querystrings and 415 on non-octet-stream /file uploads, and rejects workerToken on /claim', async () => {
    const badWait = await multiApp.inject({
      method: 'GET',
      url: '/internal/extraction/dispatch/missing-id?wait=1&wait=2',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    const badName = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/11112222333344445555666677778888/file?name=a&name=b',
      headers: {
        authorization: `Bearer ${LAPTOP_TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('x'),
    });
    expect(badName.statusCode).toBe(400);
    expect([400, 404]).toContain(badWait.statusCode);

    const wrongMime = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/11112222333344445555666677778888/file',
      headers: {
        authorization: `Bearer ${LAPTOP_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(wrongMime.statusCode).toBe(415);

    const workerClaim = await multiApp.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { nodeId: 'worker-as-node', providers: ['youtube'], capacity: 1 },
    });
    expect(workerClaim.statusCode).toBe(401);
  });

  it('rate-limits repeated invalid internal auth attempts without throttling valid nodes, and rejects javascript: legal targetUrl', async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), 'sera-node-rl-'));
    const isolatedEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'isolated-secret',
        SERA_DATA_DIR: isolatedDir,
        SERA_EXTRACTION_NODE_TOKENS: `laptop:${LAPTOP_TOKEN}`,
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
    });
    const isolatedApp = await buildServer(isolatedEngine);
    await isolatedApp.ready();
    try {
      const badReport = await isolatedApp.inject({
        method: 'POST',
        url: '/api/legal/report',
        payload: {
          targetUrl: 'javascript:alert(1)',
          category: 'copyright',
          explanation: 'Malicious javascript pseudo-protocol URL submitted in report.',
          notifierName: 'Test Notifier',
          notifierEmail: 'notifier@example.com',
          goodFaithConfirmed: true,
        },
      });
      expect(badReport.statusCode).toBe(400);

      let saw429 = false;
      for (let i = 0; i < 35; i += 1) {
        const res = await isolatedApp.inject({
          method: 'POST',
          url: '/internal/extraction/claim',
          headers: { authorization: 'Bearer wrong-token' },
          payload: { nodeId: 'x', providers: ['youtube'], capacity: 1 },
        });
        if (res.statusCode === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);

      const validNode = await isolatedApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: { authorization: `Bearer ${LAPTOP_TOKEN}` },
        payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
      });
      expect(validNode.statusCode).toBe(204);
    } finally {
      await isolatedApp.close();
      await isolatedEngine.close?.();
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

describe('mobile resilience, metadata, manifest hash, and routing', () => {
  it('returns X-Sera-Manifest-Hash on claim 204 and 200 and updates on override change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-claim-hash-'));
    const claimEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'hash-secret',
        SERA_DATA_DIR: dir,
        SERA_EXTRACTION_NODE_TOKEN: TOKEN,
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
    });
    const claimApp = await buildServer(claimEngine);
    await claimApp.ready();

    try {
      const idleClaim = await claimApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: auth,
        payload: {
          nodeId: 'android-node',
          providers: ['youtube', 'instagram'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'cellular',
          appVersion: '1.2.0',
          ytdlpVersion: '2026.10.26',
          ffmpegVersion: '7.1',
          features: ['trim', 'subtitles', 'items', 'instagram-session'],
        },
      });
      expect(idleClaim.statusCode).toBe(204);
      const firstHash = idleClaim.headers['x-sera-manifest-hash'];
      expect(typeof firstHash).toBe('string');
      expect((firstHash as string).length).toBe(64);

      const nodeStatus = claimEngine.extractionNodes
        .status()
        .find((node) => node.id === 'android-node');
      expect(nodeStatus).toMatchObject({
        id: 'android-node',
        networkClass: 'residential',
        transport: 'cellular',
        appVersion: '1.2.0',
        ytdlpVersion: '2026.10.26',
        ffmpegVersion: '7.1',
      });

      await mkdir(join(dir, 'updates'), { recursive: true });
      await writeFile(
        join(dir, 'updates', 'manifest.json'),
        JSON.stringify({
          providerConfig: { youtube: { playerClients: ['android', 'web_safari'] } },
        }),
      );

      const dispatched = claimEngine.extractionNodes.dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        providerId: 'youtube',
      });

      const workClaim = await claimApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: auth,
        payload: {
          nodeId: 'android-node',
          providers: ['youtube', 'instagram'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'wifi',
          features: ['trim', 'subtitles', 'items'],
        },
      });
      expect(workClaim.statusCode).toBe(200);
      const updatedHash = workClaim.headers['x-sera-manifest-hash'];
      expect(typeof updatedHash).toBe('string');
      expect(updatedHash).not.toBe(firstHash);

      const task = workClaim.json<{ id: string }>();
      claimEngine.extractionNodes.fail(task.id, seraError('CANCELLED'));
      await dispatched.catch(() => undefined);
    } finally {
      await claimApp.close();
      await claimEngine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports idempotent full retry and offset/Content-Range resume on /file', async () => {
    engine.extractionNodes.register('mobile-resume-node', ['youtube'], 1);
    const dispatched = engine.extractionNodes.dispatchJob({
      kind: 'job',
      url: 'https://www.youtube.com/watch?v=resume',
      providerId: 'youtube',
      planKeys: ['video/mp4/1080p'],
    });
    const claimed = await app.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: auth,
      payload: {
        nodeId: 'mobile-resume-node',
        providers: ['youtube'],
        capacity: 1,
        features: ['trim', 'subtitles'],
      },
    });
    expect(claimed.statusCode).toBe(200);
    const task = claimed.json<{ id: string }>();

    const firstHalf = Buffer.alloc(24 * 1024, 0x41);
    const secondHalf = Buffer.alloc(24 * 1024, 0x42);
    const full = Buffer.concat([firstHalf, secondHalf]);

    const chunk1 = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=mobile.mp4&mime=video%2Fmp4`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${firstHalf.length - 1}/${full.length}`,
      },
      payload: firstHalf,
    });
    expect(chunk1.statusCode).toBe(200);
    expect(chunk1.json()).toEqual({ accepted: true, complete: false, sizeBytes: firstHalf.length });

    const statusBefore = await app.inject({
      method: 'GET',
      url: `/internal/extraction/${task.id}/file?name=mobile.mp4`,
      headers: auth,
    });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json()).toEqual({
      exists: true,
      complete: false,
      sizeBytes: firstHalf.length,
    });

    const badOffset = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=mobile.mp4&offset=${full.length + 100}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: secondHalf,
    });
    expect(badOffset.statusCode).toBe(416);
    expect(badOffset.headers['x-sera-received-bytes']).toBe(String(firstHalf.length));

    const chunk2 = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=mobile.mp4&offset=${firstHalf.length}&mime=video%2Fmp4`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${firstHalf.length}-${full.length - 1}/${full.length}`,
      },
      payload: secondHalf,
    });
    expect(chunk2.statusCode).toBe(200);
    expect(chunk2.json()).toEqual({ accepted: true, sizeBytes: full.length });

    const duplicateRetry = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=mobile.mp4&mime=video%2Fmp4`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: full,
    });
    expect(duplicateRetry.statusCode).toBe(200);
    expect(duplicateRetry.json()).toEqual({ accepted: true, sizeBytes: full.length });

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: auth,
      payload: {},
    });

    const files = await dispatched;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('mobile.mp4');
    expect(await readFile(files[0]!.path)).toEqual(full);
  });

  it('configures default leaseMs from SERA_EXTRACTION_LEASE_SECONDS', async () => {
    const previous = process.env.SERA_EXTRACTION_LEASE_SECONDS;
    process.env.SERA_EXTRACTION_LEASE_SECONDS = '1';
    try {
      const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000);
      const dispatched = nodes.dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=lease',
        providerId: 'youtube',
      });
      const first = await nodes.claim('android-a', ['youtube'], 1, 200);
      expect(first).toBeDefined();

      const retaken = await nodes.claim('android-b', ['youtube'], 1, 1500);
      expect(retaken).toBeDefined();
      expect(retaken!.id).not.toBe(first!.id);
      nodes.completeResolve(retaken!.id, remoteMedia);
      await expect(dispatched).resolves.toMatchObject({ title: 'Resolved somewhere else' });
    } finally {
      if (previous === undefined) {
        delete process.env.SERA_EXTRACTION_LEASE_SECONDS;
      } else {
        process.env.SERA_EXTRACTION_LEASE_SECONDS = previous;
      }
    }
  });

  it('routes YouTube and Instagram (video and session photo) to Android when laptop is offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-android-routing-'));
    const androidEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'android-routing-secret',
        SERA_DATA_DIR: dir,
        SERA_NETWORK_CLASS: 'datacenter',
        SERA_EXTRACTION_NODE_TOKENS: 'android:tok-android-123456',
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
      probe: (_url, opts) => {
        if (opts.providerId === 'instagram') {
          return Promise.reject(
            seraError('RATE_LIMITED', { detail: 'instagram datacenter rate-limit reached' }),
          );
        }
        return Promise.reject(
          seraError('SOURCE_BLOCKED', { detail: "Sign in to confirm you're not a bot" }),
        );
      },
    });
    const androidApp = await buildServer(androidEngine);
    await androidApp.ready();

    try {
      const androidHeaders = { authorization: 'Bearer tok-android-123456' };
      await androidApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: androidHeaders,
        payload: {
          nodeId: 'android',
          providers: ['youtube', 'instagram'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'cellular',
          features: ['trim', 'subtitles', 'items', 'instagram-session'],
        },
      });

      const igReelResolvePromise = androidApp.inject({
        method: 'POST',
        url: '/api/media/info',
        payload: { url: 'https://www.instagram.com/reel/Cxyz12345/' },
      });

      let igTask: { id: string; providerId: string } | undefined;
      for (let i = 0; i < 8 && !igTask; i += 1) {
        const res = await androidApp.inject({
          method: 'POST',
          url: '/internal/extraction/claim',
          headers: androidHeaders,
          payload: {
            nodeId: 'android',
            providers: ['youtube', 'instagram'],
            capacity: 2,
            networkClass: 'residential',
            transport: 'cellular',
            features: ['trim', 'subtitles', 'items', 'instagram-session'],
          },
        });
        if (res.statusCode === 200) igTask = res.json();
      }
      expect(igTask).toBeDefined();
      expect(igTask!.providerId).toBe('instagram');

      await androidApp.inject({
        method: 'POST',
        url: `/internal/extraction/${igTask!.id}/resolved`,
        headers: androidHeaders,
        payload: {
          media: {
            provider: 'instagram',
            providerLabel: 'Instagram',
            url: 'https://www.instagram.com/reel/Cxyz12345/',
            type: 'single',
            title: 'IG Reel',
            items: [
              {
                index: 0,
                kind: 'video',
                plans: [
                  {
                    kind: 'video',
                    container: 'mp4',
                    label: 'Original',
                    requiresConversion: false,
                    recommended: true,
                    fetch: { via: 'ytdlp', selector: 'best' },
                  },
                ],
              },
            ],
          },
        },
      });

      const igReelInfo = await igReelResolvePromise;
      expect(igReelInfo.statusCode).toBe(200);
      expect(igReelInfo.json<{ title: string }>().title).toBe('IG Reel');
    } finally {
      await androidApp.close();
      await androidEngine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards requires: [instagram-session] and networkClass in JobRunner.run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-runner-ig-session-'));
    try {
      const cfg = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'runner-ig-secret',
        SERA_DATA_DIR: dir,
      });
      const workspaces = new WorkspaceManager(dir, 3600, silentLogger());
      const dispatchedTasks: Omit<RemoteTask, 'id' | 'createdAt'>[] = [];
      const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

      const igSessionMedia: ResolvedMedia = {
        provider: 'instagram',
        providerLabel: 'Instagram',
        url: 'https://www.instagram.com/p/DcOX3hWFiey/',
        type: 'single',
        title: 'IG Photo',
        remoteBackend: 'instagram-session',
        metadata: { source: 'web-api' },
        items: [
          {
            index: 0,
            kind: 'image',
            plans: [
              {
                kind: 'image',
                container: 'jpg',
                label: 'Original',
                requiresConversion: false,
                recommended: true,
                fetch: { via: 'direct', url: 'https://scontent.cdninstagram.com/v/photo.jpg' },
              },
            ],
          },
        ],
      };

      const runner = new JobRunner({
        config: cfg,
        logger: silentLogger(),
        resolver: {
          resolveCanonical: () => Promise.resolve(igSessionMedia),
          dispatcher: undefined,
        } as never,
        workspaces,
        remote: {
          status: () => [
            {
              id: 'android',
              providers: ['youtube', 'instagram'],
              networkClass: 'residential',
              capacity: 2,
              features: ['trim', 'subtitles', 'items', 'instagram-session'],
              transport: 'cellular',
              inFlight: 0,
              lastSeenMs: 10,
              healthy: true,
            },
          ],
          availableProviders: () => ['youtube', 'instagram'],
          hasHealthyNode: () => true,
          networkClasses: () => ['residential'],
          hasFeature: () => true,
          dispatch: () => Promise.reject(new Error('unexpected')),
          dispatchJob: async (
            task,
          ): Promise<
            readonly { readonly name: string; readonly mimeType: string; readonly path: string }[]
          > => {
            dispatchedTasks.push(task);
            const path = join(dir, 'ig-photo.jpg');
            await writeFile(path, jpegBytes);
            return [{ name: 'ig-photo.jpg', mimeType: 'image/jpeg', path }];
          },
        },
      });

      const result = await runner.run(
        {
          jobId: 'dddddddddddddddddddddddddddddddd',
          provider: 'instagram',
          url: igSessionMedia.url,
          selections: [{ itemIndex: 0, planKey: 'image/jpg/Original' }],
          packaging: 'auto',
          resolvedMedia: igSessionMedia,
          resolvedAt: Date.now(),
        },
        () => undefined,
      );

      expect(result.filename).toBe('ig-photo.jpg');
      expect(dispatchedTasks).toHaveLength(1);
      expect(dispatchedTasks[0]).toMatchObject({
        kind: 'job',
        providerId: 'instagram',
        networkClass: 'residential',
        requires: ['instagram-session'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('WS2 security hardening and upload lifecycle fixes', () => {
  it('enforces strict provider, SSRF, denylist, and allowlist validation on /resolved', async () => {
    const secDir = await mkdtemp(join(tmpdir(), 'sera-resolved-sec-'));
    const secEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'resolved-sec-secret',
        SERA_DATA_DIR: secDir,
        SERA_BLOCKED_HOSTS: 'evil-blocked.example',
        SERA_EXTRACTION_NODE_TOKEN: TOKEN,
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
    });
    secEngine.denylist.blockHost('denied-cdn.example', 'Takedown');
    const secApp = await buildServer(secEngine);
    await secApp.ready();

    try {
      secEngine.extractionNodes.register('sec-node', ['youtube'], 1);
      const pending = secEngine.extractionNodes
        .dispatch({
          kind: 'resolve',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          providerId: 'youtube',
        })
        .catch(() => undefined);

      const claimed = await secApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: auth,
        payload: { nodeId: 'sec-node', providers: ['youtube'], capacity: 1 },
      });
      expect(claimed.statusCode).toBe(200);
      const task = claimed.json<{ id: string }>();

      const submit = (media: Record<string, unknown>) =>
        secApp.inject({
          method: 'POST',
          url: `/internal/extraction/${task.id}/resolved`,
          headers: auth,
          payload: { media },
        });

      const wrongProvider = await submit({ ...remoteMedia, provider: 'instagram' });
      expect(wrongProvider.statusCode).toBe(400);
      expect(wrongProvider.json().error.code).toBe('VALIDATION_ERROR');

      const privateDirectUrl = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                fetch: { via: 'direct', url: 'http://169.254.169.254/latest/meta-data/' },
              },
            ],
          },
        ],
      });
      expect(privateDirectUrl.statusCode).toBe(400);
      expect(privateDirectUrl.json().error.code).toBe('BLOCKED_ADDRESS');

      const localhostThumb = await submit({
        ...remoteMedia,
        thumbnailUrl: 'http://localhost:4000/internal/secret.jpg',
      });
      expect(localhostThumb.statusCode).toBe(400);
      expect(localhostThumb.json().error.code).toBe('BLOCKED_ADDRESS');

      const blockedTarget = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                fetch: {
                  via: 'ytdlp',
                  selector: 'best',
                  target: 'https://evil-blocked.example/video.mp4',
                },
              },
            ],
          },
        ],
      });
      expect(blockedTarget.statusCode).toBe(400);
      expect(blockedTarget.json().error.code).toBe('BLOCKED_ADDRESS');

      const deniedDirect = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                fetch: { via: 'direct', url: 'https://denied-cdn.example/video.mp4' },
              },
            ],
          },
        ],
      });
      expect(deniedDirect.statusCode).toBe(422);
      expect(deniedDirect.json().error.code).toBe('UNSUPPORTED_SOURCE');

      const badExtractorArg = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                fetch: {
                  via: 'ytdlp',
                  selector: 'best',
                  extractorArgs: ['youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'],
                },
              },
            ],
          },
        ],
      });
      expect(badExtractorArg.statusCode).toBe(400);
      expect(badExtractorArg.json().error.code).toBe('VALIDATION_ERROR');

      const badSelector = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                fetch: { via: 'ytdlp', selector: '--exec touch /tmp/pwn' },
              },
            ],
          },
        ],
      });
      expect(badSelector.statusCode).toBe(400);
      expect(badSelector.json().error.code).toBe('VALIDATION_ERROR');

      const badContainer = await submit({
        ...remoteMedia,
        items: [
          {
            ...remoteMedia.items[0],
            plans: [
              {
                ...remoteMedia.items[0]!.plans[0],
                container: 'sh',
              },
            ],
          },
        ],
      });
      expect(badContainer.statusCode).toBe(400);
      expect(badContainer.json().error.code).toBe('VALIDATION_ERROR');

      secEngine.extractionNodes.fail(task.id, seraError('CANCELLED'));
      await pending;
    } finally {
      await secApp.close();
      await secEngine.close();
      await rm(secDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns 409 superseded on concurrent replacement upload instead of 502', async () => {
    const claimFresh = (nodeId: string) =>
      app.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: auth,
        payload: { nodeId, providers: ['youtube'], capacity: 4, features: ['trim', 'subtitles'] },
      });

    engine.extractionNodes.register('ws2-superseded-node', ['youtube'], 4);
    const dispatched = engine.extractionNodes
      .dispatchJob({
        kind: 'job',
        url: 'https://www.youtube.com/watch?v=superseded',
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
      })
      .catch(() => []);
    const claimed = await claimFresh('ws2-superseded-node');
    expect(claimed.statusCode).toBe(200);
    const task = claimed.json<{ id: string }>();

    const firstResult = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: `/internal/extraction/${task.id}/file?name=race.mp4&mime=video%2Fmp4`,
          headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(1024, 0x41));
      setTimeout(() => {
        if (!req.destroyed) req.end();
      }, 2000);
    });

    await new Promise((r) => setTimeout(r, 60));

    const replacement = Buffer.alloc(2048, 0x42);
    const second = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/file?name=race.mp4&mime=video%2Fmp4`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: replacement,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: true, sizeBytes: replacement.length });

    const first = await firstResult;
    expect(first.status).toBe(409);
    expect(JSON.parse(first.body)).toEqual({ accepted: false, superseded: true });

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/complete`,
      headers: auth,
      payload: {},
    });
    const files = await dispatched;
    expect(files).toHaveLength(1);
    expect(await readFile(files[0]!.path)).toEqual(replacement);
  });

  it('aborts active uploads before removing remote directory on /failed', async () => {
    engine.extractionNodes.register('ws2-failabort-node', ['youtube'], 4);
    const dispatched = engine.extractionNodes
      .dispatchJob({
        kind: 'job',
        url: 'https://www.youtube.com/watch?v=failabort',
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
      })
      .catch(() => []);
    const claimed = await app.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: auth,
      payload: {
        nodeId: 'ws2-failabort-node',
        providers: ['youtube'],
        capacity: 4,
        features: ['trim', 'subtitles'],
      },
    });
    expect(claimed.statusCode).toBe(200);
    const task = claimed.json<{ id: string }>();

    const activeUpload = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: `/internal/extraction/${task.id}/file?name=abort-me.mp4&mime=video%2Fmp4`,
          headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(2048, 0x43));
      setTimeout(() => {
        if (!req.destroyed) req.end();
      }, 2000);
    });

    await new Promise((r) => setTimeout(r, 60));

    const failed = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task.id}/failed`,
      headers: auth,
      payload: { code: 'NETWORK_ERROR', detail: 'simulated node crash' },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ accepted: true });

    const uploadOutcome = await activeUpload;
    expect(uploadOutcome.status).toBe(409);
    expect(JSON.parse(uploadOutcome.body)).toEqual({ accepted: false, cancelled: true });
    expect(existsSync(join(dataDir, `remote-${task.id}`))).toBe(false);
    await dispatched;
  });

  it('rejects Content-Length/Content-Range mismatches and cleans up remote task dirs on dispatch cancel', async () => {
    engine.extractionNodes.register('ws2-cleanup-node', ['youtube'], 4);
    const dispatchRes = await app.inject({
      method: 'POST',
      url: '/internal/extraction/dispatch',
      headers: auth,
      payload: {
        kind: 'job',
        url: 'https://www.youtube.com/watch?v=cleanup3way',
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
      },
    });
    expect(dispatchRes.statusCode).toBe(200);
    const { taskId: dispatchId } = dispatchRes.json<{ taskId: string }>();

    const claimed = await app.inject({
      method: 'POST',
      url: '/internal/extraction/claim',
      headers: auth,
      payload: {
        nodeId: 'ws2-cleanup-node',
        providers: ['youtube'],
        capacity: 4,
        features: ['trim', 'subtitles'],
      },
    });
    expect(claimed.statusCode).toBe(200);
    const nodeTask = claimed.json<{ id: string }>();
    expect(nodeTask.id).not.toBe(dispatchId);

    const mismatch = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${nodeTask.id}/file?name=bad-range.mp4`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'content-range': 'bytes 0-99/200',
      },
      payload: Buffer.alloc(50, 0x44),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('VALIDATION_ERROR');

    const partial = await app.inject({
      method: 'POST',
      url: `/internal/extraction/${nodeTask.id}/file?name=orphaned.mp4`,
      headers: {
        ...auth,
        'content-type': 'application/octet-stream',
        'content-range': 'bytes 0-99/200',
      },
      payload: Buffer.alloc(100, 0x45),
    });
    expect(partial.statusCode).toBe(200);
    expect(existsSync(join(dataDir, `remote-${nodeTask.id}`))).toBe(true);

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/internal/extraction/dispatch/${dispatchId}`,
      headers: auth,
    });
    expect(cancelled.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(join(dataDir, `remote-${nodeTask.id}`))).toBe(false);
  });
});

describe('PC primary vs phone backup routing, all-websites node default, and connectivity hardening', () => {
  it('propagates role and priority on /claim and exposes primaryNodes/backupNodes in /api/info', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-role-routing-'));
    const roleEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'role-routing-secret',
        SERA_DATA_DIR: dir,
        SERA_EXTRACTION_NODE_TOKENS: 'pc:tok-pc-123456,phone:tok-phone-123456',
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
        SERA_EXTRACTION_PRIMARY_GRACE_MS: '400',
      }),
    });
    const roleApp = await buildServer(roleEngine);
    await roleApp.ready();

    try {
      const pcHeaders = { authorization: 'Bearer tok-pc-123456' };
      const phoneHeaders = { authorization: 'Bearer tok-phone-123456' };

      const phoneManifest = await roleApp.inject({
        method: 'GET',
        url: '/internal/extraction/updates/manifest',
        headers: phoneHeaders,
      });
      expect(phoneManifest.statusCode).toBe(200);
      expect(phoneManifest.headers['x-sera-node-id']).toBe('phone');

      const pcRegister = await roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: pcHeaders,
        payload: {
          nodeId: 'pc',
          providers: ['*'],
          capacity: 1,
          networkClass: 'residential',
          role: 'primary',
          priority: 10,
          features: ['trim', 'subtitles', 'items'],
        },
      });
      expect(pcRegister.statusCode).toBe(204);

      const phoneRegister = await roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: phoneHeaders,
        payload: {
          nodeId: 'phone',
          providers: ['*'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'cellular',
          role: 'backup',
          priority: 0,
          features: ['trim', 'subtitles', 'items'],
        },
      });
      expect(phoneRegister.statusCode).toBe(204);

      const info = (await roleApp.inject({ method: 'GET', url: '/api/info' })).json<{
        nodeAvailability?: {
          primaryNodes?: number;
          backupNodes?: number;
          healthyNodes: number;
          providers: string[];
        };
      }>();
      expect(info.nodeAvailability).toMatchObject({
        healthyNodes: 2,
        primaryNodes: 1,
        backupNodes: 1,
        providers: ['*'],
      });

      const phoneWaiting = roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: phoneHeaders,
        payload: {
          nodeId: 'phone',
          providers: ['*'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'cellular',
          role: 'backup',
          features: ['trim', 'subtitles', 'items'],
        },
      });

      const genericResolve = roleApp.inject({
        method: 'POST',
        url: '/api/media/info',
        payload: { url: 'https://example.com/blog/video-post' },
      });

      await new Promise((resolve) => setTimeout(resolve, 60));

      const pcClaim = await roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: pcHeaders,
        payload: {
          nodeId: 'pc',
          providers: ['*'],
          capacity: 1,
          networkClass: 'residential',
          role: 'primary',
          priority: 10,
          features: ['trim', 'subtitles', 'items'],
        },
      });
      expect(pcClaim.statusCode).toBe(200);
      const task = pcClaim.json<{ id: string; providerId: string }>();
      expect(task.providerId).toBe('generic');

      const resolvedSubmit = await roleApp.inject({
        method: 'POST',
        url: `/internal/extraction/${task.id}/resolved`,
        headers: pcHeaders,
        payload: {
          media: {
            provider: 'generic',
            providerLabel: 'Web page',
            url: 'https://example.com/blog/video-post',
            type: 'single',
            title: 'Generic page from PC',
            items: [
              {
                index: 0,
                kind: 'video',
                plans: [
                  {
                    kind: 'video',
                    container: 'mp4',
                    label: 'Original',
                    requiresConversion: false,
                    recommended: true,
                    fetch: { via: 'direct', url: 'https://cdn.example.com/video.mp4' },
                  },
                ],
              },
            ],
          },
        },
      });
      expect(resolvedSubmit.statusCode).toBe(200);

      const visitorRes = await genericResolve;
      expect(visitorRes.statusCode).toBe(200);
      expect(visitorRes.json<{ title: string }>().title).toBe('Generic page from PC');

      const phoneRes = await phoneWaiting;
      expect(phoneRes.statusCode).toBe(204);

      const failoverResolve = roleApp.inject({
        method: 'POST',
        url: '/api/media/info',
        payload: { url: 'https://example.com/direct-clip.mp4' },
      });

      const pcFailClaim = await roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: pcHeaders,
        payload: {
          nodeId: 'pc',
          providers: ['*'],
          capacity: 1,
          networkClass: 'residential',
          role: 'primary',
          features: ['trim', 'subtitles', 'items'],
        },
      });
      expect(pcFailClaim.statusCode).toBe(200);
      const failedTask = pcFailClaim.json<{ id: string; providerId: string }>();
      expect(failedTask.providerId).toBe('direct');

      const phoneTakeoverPromise = roleApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: phoneHeaders,
        payload: {
          nodeId: 'phone',
          providers: ['*'],
          capacity: 2,
          networkClass: 'residential',
          transport: 'cellular',
          role: 'backup',
          features: ['trim', 'subtitles', 'items'],
        },
      });

      await roleApp.inject({
        method: 'POST',
        url: `/internal/extraction/${failedTask.id}/failed`,
        headers: pcHeaders,
        payload: { code: 'NETWORK_ERROR', detail: 'pc network dropped' },
      });

      const phoneTakeover = await phoneTakeoverPromise;
      expect(phoneTakeover.statusCode).toBe(200);
      const backupTask = phoneTakeover.json<{ id: string; providerId: string; avoid?: string[] }>();
      expect(backupTask.providerId).toBe('direct');
      expect(backupTask.avoid).toContain('pc');

      await roleApp.inject({
        method: 'POST',
        url: `/internal/extraction/${backupTask.id}/resolved`,
        headers: phoneHeaders,
        payload: {
          media: {
            provider: 'direct',
            providerLabel: 'Direct file',
            url: 'https://example.com/direct-clip.mp4',
            type: 'single',
            title: 'Direct clip from phone backup',
            items: [
              {
                index: 0,
                kind: 'video',
                plans: [
                  {
                    kind: 'video',
                    container: 'mp4',
                    label: 'Original',
                    requiresConversion: false,
                    recommended: true,
                    fetch: { via: 'direct', url: 'https://example.com/direct-clip.mp4' },
                  },
                ],
              },
            ],
          },
        },
      });

      const failoverVisitor = await failoverResolve;
      expect(failoverVisitor.statusCode).toBe(200);
      expect(failoverVisitor.json<{ title: string }>().title).toBe('Direct clip from phone backup');
    } finally {
      await roleApp.close();
      await roleEngine.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('disables broken HTTP/3 Alt-Svc in Caddyfile and removes UDP 443 mapping in Oracle compose', async () => {
    const caddyfile = await readFile(join(process.cwd(), 'deploy', 'Caddyfile'), 'utf8');
    const oracleCompose = await readFile(
      join(process.cwd(), 'deploy', 'docker-compose.oracle.yml'),
      'utf8',
    );
    const autoUpdate = await readFile(join(process.cwd(), 'deploy', 'auto-update.sh'), 'utf8');

    expect(caddyfile).toContain('protocols h1 h2');
    expect(caddyfile).toContain('Alt-Svc "clear"');
    expect(oracleCompose).not.toContain('443:443/udp');
    expect(oracleCompose).toContain('SERA_EXTRACTION_PRIMARY_GRACE_MS');
    expect(oracleCompose).toContain('SERA_EXTRACTION_PREFER_NODES');
    expect(autoUpdate).toContain('SERA_REDIS_PASSWORD');
    expect(autoUpdate).toContain('SERA_EXTRACTION_WORKER_TOKEN');
    expect(autoUpdate).toContain('caddy reload');
    expect(oracleCompose).toContain('user: redis');
    expect(oracleCompose).not.toContain('- gosu');
    expect(oracleCompose).not.toContain('- su-exec');
  });

  it('wakes dispatch long-poll immediately when claimedBy changes for callers passing seenClaimedBy', async () => {
    const wakeLaptopToken = 'wake-laptop-token-0123456789';
    const wakeWorkerToken = 'wake-worker-token-0123456789';
    const dir = await mkdtemp(join(tmpdir(), 'sera-claim-wake-'));
    const wakeEngine = await SeraEngine.create({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SERA_SECRET: 'wake-secret',
        SERA_DATA_DIR: dir,
        SERA_EXTRACTION_NODE_TOKENS: `laptop:${wakeLaptopToken}`,
        SERA_EXTRACTION_WORKER_TOKEN: wakeWorkerToken,
        SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      }),
    });
    const wakeApp = await buildServer(wakeEngine);
    await wakeApp.ready();

    try {
      const dispatch = await wakeApp.inject({
        method: 'POST',
        url: '/internal/extraction/dispatch',
        headers: { authorization: `Bearer ${wakeWorkerToken}` },
        payload: {
          kind: 'resolve',
          url: 'https://www.youtube.com/watch?v=wake1',
          providerId: 'youtube',
        },
      });
      const { taskId } = dispatch.json<{ taskId: string }>();

      const started = Date.now();
      const pollPromise = wakeApp.inject({
        method: 'GET',
        url: `/internal/extraction/dispatch/${taskId}?wait=5&seenClaimedBy=`,
        headers: { authorization: `Bearer ${wakeWorkerToken}` },
      });
      await new Promise((r) => setTimeout(r, 30));
      const claimed = await wakeApp.inject({
        method: 'POST',
        url: '/internal/extraction/claim',
        headers: { authorization: `Bearer ${wakeLaptopToken}` },
        payload: { nodeId: 'laptop', providers: ['youtube'], capacity: 1 },
      });
      expect(claimed.statusCode).toBe(200);

      const polled = await pollPromise;
      expect(polled.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(polled.json()).toMatchObject({ state: 'pending', claimedBy: 'laptop' });

      await wakeApp.inject({
        method: 'DELETE',
        url: `/internal/extraction/dispatch/${taskId}`,
        headers: { authorization: `Bearer ${wakeWorkerToken}` },
      });
    } finally {
      await wakeApp.close();
      await wakeEngine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
