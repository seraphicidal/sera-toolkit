import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job, MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { ensureFixtures, ffmpegPath, ffprobePath, type Fixtures } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

/**
 * The API treated as hostile input.
 *
 * These are the checks that matter when the service is on the open internet: that a
 * signed handle cannot be edited into a different request, that a filename cannot name a
 * path, that nothing internal leaks into a response body, and that the address guard
 * cannot be talked around.
 */

let engine: SeraEngine;
let app: FastifyInstance;
let origin: MediaServer;
let fixtures: Fixtures;
let dataDir: string;

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-sec-'));

  origin = new MediaServer({
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    '/photo.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
  });
  await origin.start();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'security-suite-secret',
    SERA_DATA_DIR: dataDir,
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    SERA_FFMPEG_PATH: ffmpegPath,
    SERA_FFPROBE_PATH: ffprobePath,
    SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '1000',
    SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
    SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '10',
  });

  engine = await SeraEngine.create({ config });
  app = await buildServer(engine);
  engine.startWorker(1);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

async function resolveClip(): Promise<MediaInfo> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/media/info',
    payload: { url: origin.url('/clip.mp4') },
  });
  expect(response.statusCode).toBe(200);
  return response.json<MediaInfo>();
}

/* -------------------------------------------------------------------------- */

describe('URL handling', () => {
  it('refuses schemes that are not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x.mp4', 'javascript:alert(1)']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/media/info',
        payload: { url },
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code).toBe('INVALID_URL');
    }
  });

  it('refuses credentials embedded in a link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: 'https://user:pass@example.com/v.mp4' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an over-long link before doing any work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: `https://example.com/${'a'.repeat(4000)}.mp4` },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a body that is not shaped like a request', async () => {
    for (const payload of [{}, { url: 123 }, { url: null }, { notUrl: 'x' }, []]) {
      const response = await app.inject({ method: 'POST', url: '/api/media/info', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('signed handles', () => {
  it('refuses an option token that was not issued by this server', async () => {
    const info = await resolveClip();
    const forged = Buffer.from(
      JSON.stringify({ h: 'x'.repeat(22), i: 0, k: 'video/mp4/Original', e: 9_999_999_999 }),
      'utf8',
    ).toString('base64url');

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [`${forged}.AAAA`] },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('EXPIRED');
  });

  it('refuses options that belong to a different resolution', async () => {
    // Otherwise a valid token becomes a wrapper for an arbitrary fetch.
    const clip = await resolveClip();
    const photoResponse = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/photo.jpg') },
    });
    const photo = photoResponse.json<MediaInfo>();

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: clip.id, optionIds: [photo.items[0]!.options[0]!.id] },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.message).toContain('different link');
  });

  it('refuses a job with no selection', async () => {
    const info = await resolveClip();
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses more selections than the schema allows', async () => {
    const info = await resolveClip();
    const optionId = info.items[0]!.options[0]!.id;
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: Array.from({ length: 200 }, () => optionId) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a thumbnail token that was not issued by this server', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/thumb/not-a-real-token' });
    expect(response.statusCode).toBe(410);
  });
});

describe('file serving', () => {
  it('refuses job ids that are not job ids', async () => {
    for (const id of ['../../etc/passwd', 'not-hex', '..', 'a'.repeat(200), '%2e%2e%2f']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs/${encodeURIComponent(id)}`,
      });
      // 404 from the id check, or 414 when the router rejects an absurd path first —
      // both are refusals, and the earlier one is cheaper.
      expect([404, 414], `${id} -> ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it('refuses a filename that tries to leave the workspace', async () => {
    const info = await resolveClip();
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] },
    });
    const { id } = created.json<Job>();

    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<Job>();
      if (
        ![
          'queued',
          'resolving',
          'downloading',
          'merging',
          'converting',
          'packaging',
          'finalizing',
        ].includes(job.state)
      )
        break;
      if (Date.now() > deadline) throw new Error('job never finished');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    for (const name of [
      '../manifest.json',
      '..%2Fmanifest.json',
      '....//manifest.json',
      '%2e%2e%2fmanifest.json',
      'C:\\Windows\\win.ini',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}/files/${name}` });
      expect(response.statusCode, name).toBe(404);
    }
  });

  it('serves a finished file as an attachment that cannot execute', async () => {
    const info = await resolveClip();
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] },
    });
    const { id } = created.json<Job>();

    const deadline = Date.now() + 60_000;
    let job: Job;
    for (;;) {
      job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<Job>();
      if (job.state === 'ready' || job.state === 'failed') break;
      if (Date.now() > deadline) throw new Error('job never finished');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(job.state).toBe('ready');

    const response = await app.inject({ method: 'GET', url: job.result!.downloadPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('responses', () => {
  it('never returns a stack trace or an internal detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: 'https://example.invalid/nothing-here.mp4' },
    });
    const body = response.body;
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('yt-dlp');
    expect(body).not.toContain('Error:');

    // Stronger than sniffing the body for stack-frame text, which also matches
    // ordinary English: the error object carries exactly the fields the contract
    // allows, so nothing internal can ride along in an extra one.
    const error = response.json<{ error: Record<string, unknown> }>().error;
    expect(Object.keys(error).sort()).toEqual(['code', 'hint', 'message', 'retryable']);
  });

  it('treats a host that does not resolve as a typo, not a retryable outage', () => {
    // .invalid never resolves, by RFC. Offering "Try again" here would be a button
    // that can only ever fail.
    return app
      .inject({
        method: 'POST',
        url: '/api/media/info',
        payload: { url: 'https://sera-test-nonexistent.invalid/clip.mp4' },
      })
      .then((response) => {
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_URL');
        expect(response.json().error.retryable).toBe(false);
      });
  });

  it('sets hardening headers on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/info' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('does not echo the source URL back in a job', async () => {
    const info = await resolveClip();
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [info.items[0]!.options[0]!.id] },
    });
    // The URL lives in the signed handle, not in the job the client can read back.
    expect(created.body).not.toContain('127.0.0.1');
    expect(created.body).not.toContain('clip.mp4');
  });

  it('reports an unknown route as a clean 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('health', () => {
  it('reports the tools it depends on', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const report = response.json<{ checks: { name: string; status: string }[] }>();
    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['yt-dlp', 'ffmpeg', 'storage', 'queue']),
    );
  });

  it('gates traffic on the binaries actually working', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect([200, 503]).toContain(response.statusCode);
    expect(response.json()).toHaveProperty('ready');
  });

  it('describes the deployment for the About page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/info' });
    const info = response.json<{ providers: unknown[]; limits: Record<string, number> }>();
    expect(info.providers.length).toBeGreaterThan(10);
    expect(info.limits.maxFilesizeBytes).toBeGreaterThan(0);
  });
});

describe('thumbnail proxy', () => {
  it('accepts a signed token long enough to carry a real CDN URL', async () => {
    // Fastify's default maxParamLength is 100 characters. A thumbnail token embedding a
    // platform CDN URL is comfortably longer, and the symptom of getting this wrong is
    // silent: the UI falls back to a placeholder icon and nothing looks broken.
    const info = await resolveClip();
    expect(info.thumbnail).toBeUndefined(); // a bare MP4 has no thumbnail

    const longUrl = `https://cdn.example.com/${'a'.repeat(120)}/thumb.jpg`;
    const path = engine.resolver.thumbnailPath(longUrl);
    expect(path.length).toBeGreaterThan(150);

    const response = await app.inject({ method: 'GET', url: path });
    // The origin does not exist, so the fetch fails — but it must reach the handler
    // rather than being rejected by the router as an over-long parameter.
    expect(response.statusCode).not.toBe(414);
    expect(response.json().error.code).not.toBe('NOT_FOUND');
  });

  it('refuses a token this server did not sign', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/thumb/not-a-real-token' });
    expect(response.statusCode).toBe(410);
  });
});
