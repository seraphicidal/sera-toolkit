import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ImportedPostNode, ImportRequest, Job, MediaInfo } from '@sera/contracts/types';
import { JobRunner, loadConfig, SeraEngine, type JobSpec } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { ensureFixtures, ffmpegPath, ffprobePath, type Fixtures } from './helpers/fixtures.js';
import { MediaServer, type MediaServerRoute } from './helpers/media-server.js';

/**
 * Visitor import, end to end, with the visitor's browser played by the test.
 *
 * The browser's half — reading the post on instagram.com with the visitor's own session — is
 * the one part that cannot run here, and the one part SERA never trusts anyway. Everything
 * after it is real: the route, the token, the queue, the runner, the fetch from a CDN that is
 * a loopback server standing in for Instagram's, and a ZIP read back at the end.
 */

let engine: SeraEngine;
let app: FastifyInstance;
let origin: MediaServer;
let fixtures: Fixtures;
let dataDir: string;

const routes: Record<string, MediaServerRoute> = {};
const CODE = 'DcOX3hWFiey';
const POST = `https://www.instagram.com/p/${CODE}/`;

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-import-'));

  Object.assign(routes, {
    '/photo-1.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
    '/photo-2.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    // What Instagram's CDN says to a link whose signature it no longer honours.
    '/refused.jpg': { status: 403, body: 'URL signature expired', contentType: 'text/plain' },
  } satisfies Record<string, MediaServerRoute>);
  origin = new MediaServer(routes);
  await origin.start();
  // The same file, reached by a redirect to a host name that was never approved.
  routes['/elsewhere.jpg'] = {
    redirectTo: `http://localhost:${new URL(origin.origin).port}/photo-1.jpg`,
  };

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'visitor-import-suite-secret',
    SERA_DATA_DIR: dataDir,
    // The stand-in CDN is on loopback, which the address guard blocks by design.
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    SERA_FFMPEG_PATH: ffmpegPath,
    SERA_FFPROBE_PATH: ffprobePath,
    SERA_WORKER_CONCURRENCY: '2',
    SERA_JOB_TIMEOUT_SECONDS: '120',
    SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '1000',
    SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
    SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '10',
    SERA_MAX_ITEMS_PER_JOB: '6',
  });

  engine = await SeraEngine.create({
    config,
    // The loopback origin is the approved CDN here, over plain HTTP only because it is a test
    // server. Nothing in the environment can do this; production is Instagram's hosts, HTTPS.
    importHosts: { hosts: ['127.0.0.1'], requireHttps: false },
    // A job made from an imported post must never re-resolve. If one tried, it would end here.
    probe: () => Promise.reject(new Error('an imported post must not be re-resolved')),
  });
  app = await buildServer(engine);
  engine.startWorker(2);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** A link on the stand-in CDN, signed the way Instagram's are, good for a day by default. */
function media(path: string, expiresInSeconds = 86_400): string {
  const oe = Math.floor(Date.now() / 1000 + expiresInSeconds).toString(16);
  return `${origin.url(path)}?stp=dst-jpg_e35&oh=00_signature&oe=${oe}`;
}

const photo = (id: string, url: string): ImportedPostNode => ({
  id,
  media_type: 1,
  image_versions2: { candidates: [{ url, width: 640, height: 480 }] },
});

const video = (id: string, url: string, cover: string): ImportedPostNode => ({
  id,
  media_type: 2,
  video_duration: 3,
  video_versions: [{ url, width: 640, height: 360 }],
  image_versions2: { candidates: [{ url: cover, width: 640, height: 360 }] },
});

function carousel(...slides: ImportedPostNode[]): ImportRequest {
  return {
    url: POST,
    node: {
      code: CODE,
      media_type: 8,
      user: { username: 'nasa', full_name: 'NASA' },
      caption: { text: 'A carousel' },
      carousel_media: slides,
    },
  };
}

let clients = 0;
/** A client address of its own, so one test's refusals cannot cool another test down. */
const freshClient = () => `198.51.100.${++clients}`;

function send(request: object, remoteAddress: string) {
  return app.inject({ method: 'POST', url: '/api/media/import', payload: request, remoteAddress });
}

async function imported(request: ImportRequest): Promise<MediaInfo> {
  const response = await send(request, freshClient());
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MediaInfo>();
}

/** Submits a job and waits for it to reach a terminal state. */
async function runJob(payload: Record<string, unknown>): Promise<Job> {
  const created = await app.inject({ method: 'POST', url: '/api/jobs', payload });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<Job>();

  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}` });
    const job = response.json<Job>();
    if (['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The token with its approved media edited, and the original signature left on. */
function withEditedMedia(infoId: string, url: string): string {
  const [body, signature] = infoId.split('.');
  const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
  payload.m[0].url = url;
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

/* -------------------------------------------------------------------------- */

describe('a post sent from the visitor’s browser', () => {
  it('becomes a download of every slide, fetched straight from the CDN', async () => {
    const before = origin.requests.length;
    const info = await imported(
      carousel(
        photo('slide-1', media('/photo-1.jpg')),
        video('slide-2', media('/clip.mp4'), media('/photo-2.jpg')),
        photo('slide-3', media('/photo-2.jpg')),
      ),
    );

    expect(info.provider).toBe('instagram');
    expect(info.items.map((item) => item.kind)).toEqual(['image', 'video', 'image']);
    // Nothing was fetched to answer that: the browser had already read the post.
    expect(origin.requests.length).toBe(before);

    const originals = info.items.map(
      (item) => item.options.find((option) => option.label === 'Original')!.id,
    );
    const job = await runJob({ infoId: info.id, optionIds: originals });

    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.result!.delivery?.backend).toBe('visitor-browser');
    expect(job.result!.isArchive).toBe(true);
    expect(job.result!.files).toHaveLength(3);
    expect(job.result!.filename).toMatch(/A carousel\.zip$/);

    const archive = await app.inject({ method: 'GET', url: job.result!.downloadPath });
    expect(archive.statusCode).toBe(200);
    expect(archive.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    // Exactly the three approved files, and nothing else.
    expect(origin.requests.slice(before).sort()).toEqual([
      '/clip.mp4',
      '/photo-1.jpg',
      '/photo-2.jpg',
    ]);
  });

  it('refuses media anywhere but the approved hosts, and cools the sender down', async () => {
    const client = freshClient();
    // The approved host in this suite is the loopback CDN, so Instagram's real one does
    // nicely as "anywhere else".
    const forged = carousel(
      photo('slide-1', 'https://scontent-vie1-1.cdninstagram.com/v/a.jpg?oe=FFFFFFFF'),
    );

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await send(forged, client);
      statuses.push(response.statusCode);
      if (response.statusCode === 429) break;
      expect(response.json().error.code).toBe('BLOCKED_ADDRESS');
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((status) => status === 400).length).toBeLessThanOrEqual(12);

    // The cooldown belongs to the sender, so for now even a genuine post is refused...
    const genuine = carousel(photo('slide-1', media('/photo-1.jpg')));
    expect((await send(genuine, client)).statusCode).toBe(429);
    // ...and nobody else is affected.
    expect((await send(genuine, freshClient())).statusCode).toBe(200);
  });

  it('refuses a body too large to be a trimmed post, before reading it', async () => {
    const response = await send(
      { ...carousel(photo('slide-1', media('/photo-1.jpg'))), padding: 'x'.repeat(600 * 1024) },
      freshClient(),
    );
    expect(response.statusCode).toBe(413);
  });

  it('refuses more slides than one download may carry', async () => {
    const slides = (count: number) =>
      Array.from({ length: count }, (_, index) => photo(`slide-${index}`, media('/photo-1.jpg')));

    const overLimit = await send(carousel(...slides(7)), freshClient());
    expect(overLimit.statusCode).toBe(413);
    expect(overLimit.json().error.code).toBe('TOO_LARGE');

    // And the schema's own ceiling, whatever this server's limit is set to.
    expect((await send(carousel(...slides(51)), freshClient())).statusCode).toBe(400);
  });

  it('will not spend an option from one import against another import of the same post', async () => {
    const first = await imported(carousel(photo('slide-1', media('/photo-1.jpg'))));
    const second = await imported(carousel(photo('slide-1', media('/photo-2.jpg'))));

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: second.id, optionIds: [first.items[0]!.options[0]!.id] },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.message).toContain('different link');
  });

  it('will not fetch media edited into a token after it was signed', async () => {
    const info = await imported(carousel(photo('slide-1', media('/photo-1.jpg'))));

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        infoId: withEditedMedia(info.id, media('/photo-2.jpg')),
        optionIds: [info.items[0]!.options[0]!.id],
      },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('EXPIRED');
  });

  it('follows no redirect off the approved hosts', async () => {
    const info = await imported(carousel(photo('slide-1', media('/elsewhere.jpg'))));
    const asked = () => origin.requests.filter((path) => path === '/photo-1.jpg').length;
    const before = asked();

    const job = await runJob({ infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] });

    expect(job.state).toBe('failed');
    expect(job.error!.code).toBe('BLOCKED_ADDRESS');
    // The redirect was asked for, and where it pointed never was.
    expect(origin.requests).toContain('/elsewhere.jpg');
    expect(asked()).toBe(before);
  });

  it('says Instagram refused the links, rather than blaming the network', async () => {
    const info = await imported(carousel(photo('slide-1', media('/refused.jpg'))));
    const job = await runJob({ infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] });

    expect(job.state).toBe('failed');
    expect(job.error!.code).toBe('EXPIRED');
    expect(job.error!.hint).toContain('Open the post on Instagram again');
  });

  it('refuses a queued job whose links ran out before it started, without fetching', async () => {
    const runner = new JobRunner({
      config: engine.config,
      logger: engine.logger,
      resolver: engine.resolver,
      workspaces: engine.workspaces,
    });
    const spec: JobSpec = {
      jobId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      provider: 'instagram',
      url: `https://www.instagram.com/p/${CODE}`,
      selections: [{ itemIndex: 0, sourceId: 'slide-1', planKey: 'image/jpg/Original' }],
      packaging: 'auto',
      imported: {
        entries: [{ s: 'slide-1', kind: 'image', url: media('/photo-1.jpg'), container: 'jpg' }],
        title: 'A post',
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      },
    };
    const before = origin.requests.length;

    await expect(runner.run(spec, () => undefined)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(origin.requests.length).toBe(before);
    await engine.workspaces.destroy(spec.jobId).catch(() => undefined);
  });
});
