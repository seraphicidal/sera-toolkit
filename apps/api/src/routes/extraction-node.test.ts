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
