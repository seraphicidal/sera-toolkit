import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { silentLogger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { RemoteOverHttp } from './remote-http.js';
import { remoteBackends } from './remote.js';

/**
 * The split every deployment with a separate worker actually runs.
 *
 * A node holds one connection to one process. On this deployment that process is the
 * API — and the worker, in its own container, is the one that does the downloads. It saw
 * no node at all, so a YouTube link resolved through the node and then failed at the
 * download step with the datacentre block. `fallbackAvailable: false` in the worker's
 * log, while the API's log had the node connecting a minute earlier.
 *
 * Nothing in the suite could see it: every other test runs both halves in one process.
 */

const TOKEN = 'over-http-token';

const media: ResolvedMedia = {
  provider: 'youtube',
  providerLabel: 'YouTube',
  url: 'https://www.youtube.com/watch?v=x',
  type: 'single',
  title: 'Resolved on the node',
  items: [
    {
      index: 0,
      kind: 'video',
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
let base: string;
/** What the fake control plane will do with the next dispatch. */
let behaviour: 'resolve' | 'job' | 'fail' | 'slow' = 'resolve';
let nodes: unknown[] = [];
const seen: { method: string; path: string; body?: unknown }[] = [];

beforeAll(async () => {
  app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    seen.push({ method: request.method, path: request.url });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return;
    }
    done();
  });

  app.get('/internal/extraction/nodes', () => ({ nodes }));

  let polls = 0;

  app.post('/internal/extraction/dispatch', (request) => {
    seen[seen.length - 1]!.body = request.body;
    // Each dispatch is a new task, so its poll count starts again.
    polls = 0;
    return { taskId: 'task-1' };
  });

  app.get('/internal/extraction/dispatch/:taskId', () => {
    polls += 1;
    if (behaviour === 'slow' && polls < 3) {
      return { state: 'pending', progress: { percent: polls * 25, step: 'Downloading' } };
    }
    if (behaviour === 'fail') {
      return {
        state: 'failed',
        error: {
          code: 'PRIVATE_CONTENT',
          message: 'That post is private.',
          detail: 'node said so',
        },
      };
    }
    if (behaviour === 'job') {
      return {
        state: 'done',
        files: [{ name: 'clip.mp4', mimeType: 'video/mp4', path: '/data/remote-1/clip.mp4' }],
      };
    }
    return { state: 'done', media };
  });

  app.delete('/internal/extraction/dispatch/:taskId', () => ({ cancelled: true }));

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterAll(async () => {
  await app.close();
});

const clientFor = () => new RemoteOverHttp(base, TOKEN, silentLogger(), 0, 10);

/** The status read is a background refresh, so the first look is empty by design. */
async function withStatus(client: RemoteOverHttp): Promise<RemoteOverHttp> {
  client.status();
  await new Promise((done) => setTimeout(done, 60));
  return client;
}

describe('a worker reaching the node through the API', () => {
  it('reports the nodes the API can see', async () => {
    nodes = [
      {
        id: 'home',
        providers: ['youtube'],
        networkClass: 'residential',
        capacity: 1,
        inFlight: 0,
        lastSeenMs: 100,
        healthy: true,
      },
    ];
    const client = await withStatus(clientFor());

    expect(client.hasHealthyNode()).toBe(true);
    expect(client.availableProviders()).toEqual(['youtube']);
    expect(client.networkClasses()).toEqual(['residential']);
  });

  it('offers the router a backend, which is the whole point', async () => {
    const client = await withStatus(clientFor());
    const backends = remoteBackends(client);

    expect(backends).toHaveLength(1);
    expect(backends[0]?.kind).toBe('remote');
    expect(backends[0]?.networkClass).toBe('residential');
    expect(backends[0]?.providers).toEqual(['youtube']);
  });

  it('counts an unhealthy or absent node as no fallback', async () => {
    nodes = [];
    const empty = await withStatus(clientFor());
    expect(empty.hasHealthyNode()).toBe(false);
    expect(remoteBackends(empty)).toEqual([]);

    nodes = [
      {
        id: 'stale',
        providers: ['youtube'],
        networkClass: 'residential',
        capacity: 1,
        inFlight: 0,
        lastSeenMs: 999_999,
        healthy: false,
      },
    ];
    const stale = await withStatus(clientFor());
    expect(stale.hasHealthyNode()).toBe(false);
  });

  it('treats an unreachable control plane as no nodes, not as an error', async () => {
    // The conservative answer: work stays local rather than waiting on a machine that
    // may not be there.
    const unreachable = new RemoteOverHttp('http://127.0.0.1:1', TOKEN, silentLogger(), 0, 10);
    await withStatus(unreachable);
    expect(unreachable.hasHealthyNode()).toBe(false);
  });

  it('dispatches a resolve and gets the media back', async () => {
    behaviour = 'resolve';
    const resolved = await clientFor().dispatch({
      kind: 'resolve',
      url: 'https://www.youtube.com/watch?v=x',
      providerId: 'youtube',
    });
    expect(resolved.title).toBe('Resolved on the node');

    const post = seen.find((entry) => entry.method === 'POST');
    expect(post?.body).toMatchObject({ kind: 'resolve', providerId: 'youtube' });
  });

  it('dispatches a job and gets the files the node uploaded', async () => {
    // No transfer: both containers mount the same volume, so the path is enough.
    behaviour = 'job';
    const files = await clientFor().dispatchJob({
      kind: 'job',
      url: 'https://www.youtube.com/watch?v=x',
      providerId: 'youtube',
      planKeys: ['video/mp4/1080p'],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('/data/remote-1/clip.mp4');
  });

  it('passes progress through while it waits', async () => {
    behaviour = 'slow';
    const percents: number[] = [];
    await clientFor().dispatch(
      { kind: 'resolve', url: 'https://www.youtube.com/watch?v=x', providerId: 'youtube' },
      { onProgress: (progress) => percents.push(progress.percent) },
    );
    expect(percents.length).toBeGreaterThan(0);
  });

  it('brings back the failure the node reported, not a generic one', async () => {
    // A private video has to stay a private video across the process boundary, or the
    // ladder's rule about definitive failures stops working on this deployment.
    behaviour = 'fail';
    await expect(
      clientFor().dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=x',
        providerId: 'youtube',
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
  });

  it('refuses to work without the token', async () => {
    behaviour = 'resolve';
    const wrong = new RemoteOverHttp(base, 'not-the-token', silentLogger(), 0, 10);
    await expect(
      wrong.dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=x',
        providerId: 'youtube',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
