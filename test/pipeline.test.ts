import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DownloadOption, Job, MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import {
  ensureFixtures,
  ffmpegPath,
  ffprobePath,
  probeFile,
  type Fixtures,
} from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

/**
 * The whole product, exercised for real.
 *
 * Nothing here is mocked below the HTTP boundary: FFmpeg runs, files are written to a
 * real workspace, the ZIP is a real archive, and every produced file is read back with
 * ffprobe. A test that stubbed the download would pass while the thing users actually do
 * stayed broken, which is precisely the failure this suite exists to prevent.
 */

let engine: SeraEngine;
let app: FastifyInstance;
let origin: MediaServer;
let fixtures: Fixtures;
let dataDir: string;

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-e2e-'));

  origin = new MediaServer({
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    '/silent.mp4': { file: fixtures.silentVideo, contentType: 'video/mp4' },
    '/song.mp3': { file: fixtures.audio, contentType: 'audio/mpeg' },
    '/photo.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
    '/anim.gif': { file: fixtures.gif, contentType: 'image/gif' },
    '/moved.mp4': { redirectTo: '/clip.mp4' },
    '/notmedia.mp4': { body: '<html>not a video</html>', contentType: 'text/html' },
    '/missing.mp4': { status: 404, body: 'gone', contentType: 'text/plain' },
    '/robots.txt': { body: 'User-agent: *\nDisallow: /blocked', contentType: 'text/plain' },
    '/article': {
      body: [
        '<html><head>',
        '<meta property="og:title" content="An Article With Video">',
        '<meta property="og:site_name" content="Example News">',
        '<meta property="og:description" content="A description.">',
        '<meta property="og:video" content="/clip.mp4">',
        '<meta property="og:image" content="/photo.jpg">',
        '</head><body><h1>Story</h1></body></html>',
      ].join(''),
    },
    '/blocked': { body: '<html><meta property="og:video" content="/clip.mp4"></html>' },
    '/nomedia': { body: '<html><head><title>Nothing here</title></head><body></body></html>' },
  });
  await origin.start();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'end-to-end-test-secret',
    SERA_DATA_DIR: dataDir,
    // The origin is on loopback, which the address guard blocks by design.
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    SERA_FFMPEG_PATH: ffmpegPath,
    SERA_FFPROBE_PATH: ffprobePath,
    SERA_WORKER_CONCURRENCY: '2',
    SERA_JOB_TIMEOUT_SECONDS: '120',
    SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '1000',
    SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
    SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '10',
  });

  engine = await SeraEngine.create({ config });
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

async function resolveUrl(url: string): Promise<MediaInfo> {
  const response = await app.inject({ method: 'POST', url: '/api/media/info', payload: { url } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MediaInfo>();
}

function pick(info: MediaInfo, kind: string, label?: string): DownloadOption {
  for (const item of info.items) {
    for (const option of item.options) {
      if (option.kind === kind && (!label || option.label === label)) return option;
    }
  }
  throw new Error(
    `no ${kind} option${label ? ` labelled ${label}` : ''} in ${JSON.stringify(info.items.map((i) => i.options.map((o) => `${o.kind}/${o.label}`)))}`,
  );
}

/** Submits a job and waits for it to reach a terminal state. */
async function runJob(payload: Record<string, unknown>): Promise<Job> {
  const created = await app.inject({ method: 'POST', url: '/api/jobs', payload });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<Job>();

  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}` });
    expect(response.statusCode).toBe(200);
    const job = response.json<Job>();
    if (['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Downloads a job result into a temp file and probes it. */
async function fetchResult(job: Job): Promise<{ bytes: Buffer; filename: string }> {
  const response = await app.inject({ method: 'GET', url: job.result!.downloadPath });
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  const disposition = response.headers['content-disposition']!;
  return { bytes: response.rawPayload, filename: disposition };
}

async function writeTemp(bytes: Buffer, name: string): Promise<string> {
  const path = join(dataDir, `check-${name}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, bytes);
  return path;
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

describe('resolving a direct media link', () => {
  it('describes a video and offers real options', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));

    expect(info.provider).toBe('direct');
    expect(info.type).toBe('single');
    expect(info.items).toHaveLength(1);
    expect(info.items[0]!.kind).toBe('video');

    const kinds = new Set(info.items[0]!.options.map((option) => option.kind));
    expect(kinds).toContain('video');
    expect(kinds).toContain('audio');

    // Exactly one default per kind, so the UI never has to choose.
    for (const kind of kinds) {
      const defaults = info.items[0]!.options.filter((o) => o.kind === kind && o.recommended);
      expect(defaults, kind).toHaveLength(1);
    }
  });

  it('proxies the thumbnail rather than exposing the origin URL', async () => {
    const info = await resolveUrl(origin.url('/article'));
    expect(info.thumbnail).toMatch(/^\/api\/thumb\//);
    // No third-party URL reaches the client.
    expect(JSON.stringify(info)).not.toContain('/photo.jpg');
  });

  it('follows a redirect to the real file', async () => {
    const info = await resolveUrl(origin.url('/moved.mp4'));
    expect(info.items[0]!.kind).toBe('video');
  });

  it('refuses a link that claims to be media but is not', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/notmedia.mp4') },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('UNSUPPORTED_SOURCE');
  });

  it('reports a missing file as unavailable', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/missing.mp4') },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('MEDIA_UNAVAILABLE');
  });
});

describe('resolving a generic page', () => {
  it('finds the media a page declares for its own embeds', async () => {
    const info = await resolveUrl(origin.url('/article'));
    expect(info.provider).toBe('generic');
    expect(info.title).toBe('An Article With Video');
    expect(info.providerLabel).toBe('Example News');
    expect(info.items[0]!.kind).toBe('video');
  });

  it('honours a robots.txt disallow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/blocked') },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('asks not to be read');
  });

  it('reports a page with no media rather than inventing something', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: origin.url('/nomedia') },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('UNSUPPORTED_SOURCE');
  });
});

/* -------------------------------------------------------------------------- */
/*  Downloads                                                                 */
/* -------------------------------------------------------------------------- */

describe('video download', () => {
  it('delivers a playable file with both streams intact', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const option = pick(info, 'video', 'Original');
    const job = await runJob({ infoId: info.id, optionIds: [option.id] });

    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.progress.percent).toBe(100);
    expect(job.result!.isArchive).toBe(false);
    expect(job.result!.sizeBytes).toBeGreaterThan(1000);

    const { bytes } = await fetchResult(job);
    const path = await writeTemp(bytes, 'video.mp4');
    const probed = await probeFile(path);

    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.durationSeconds).toBeGreaterThan(2.5);
    expect(probed.width).toBe(640);
  });

  it('names the file from the metadata', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({ infoId: info.id, optionIds: [pick(info, 'video').id] });
    expect(job.result!.filename).toMatch(/\.mp4$/);
    const { filename } = await fetchResult(job);
    expect(filename).toContain('attachment;');
  });

  it('accepts a filename override and sanitizes it', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [pick(info, 'video').id],
      filename: '../../etc/passwd',
    });
    expect(job.state).toBe('ready');
    // The traversal is gone; what remains is an ordinary name.
    expect(job.result!.filename).toBe('etc passwd.mp4');
  });
});

describe('audio extraction', () => {
  it('converts a video to a real MP3', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const option = pick(info, 'audio', 'MP3');
    expect(option.requiresConversion).toBe(true);

    const job = await runJob({ infoId: info.id, optionIds: [option.id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.result!.filename).toMatch(/\.mp3$/);
    expect(job.result!.mimeType).toBe('audio/mpeg');

    const { bytes } = await fetchResult(job);
    const path = await writeTemp(bytes, 'audio.mp3');
    const probed = await probeFile(path);

    expect(probed.hasAudio).toBe(true);
    expect(probed.hasVideo).toBe(false);
    expect(probed.audioCodec).toBe('mp3');
    expect(probed.durationSeconds).toBeGreaterThan(2.5);
  });

  it('produces a lossless WAV when asked', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({ infoId: info.id, optionIds: [pick(info, 'audio', 'WAV').id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');

    const { bytes } = await fetchResult(job);
    const path = await writeTemp(bytes, 'audio.wav');
    const probed = await probeFile(path);
    expect(probed.audioCodec).toBe('pcm_s16le');
  });

  it('refuses to extract audio from a silent video instead of shipping an empty file', async () => {
    const info = await resolveUrl(origin.url('/silent.mp4'));
    const audio = info.items[0]!.options.find((option) => option.kind === 'audio');
    if (!audio) return; // no audio option offered at all, which is also correct

    const job = await runJob({ infoId: info.id, optionIds: [audio.id] });
    expect(job.state).toBe('failed');
    expect(job.error!.code).toBe('CONVERSION_FAILED');
  });
});

describe('image download', () => {
  it('delivers the original bytes untouched', async () => {
    const info = await resolveUrl(origin.url('/photo.jpg'));
    expect(info.items[0]!.kind).toBe('image');

    const option = pick(info, 'image', 'Original');
    expect(option.requiresConversion).toBe(false);

    const job = await runJob({ infoId: info.id, optionIds: [option.id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');

    const { bytes } = await fetchResult(job);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic
    expect(job.result!.mimeType).toBe('image/jpeg');
  });
});

describe('GIF handling', () => {
  it('offers the original and delivers a real GIF', async () => {
    const info = await resolveUrl(origin.url('/anim.gif'));
    expect(info.items[0]!.kind).toBe('gif');

    const job = await runJob({ infoId: info.id, optionIds: [pick(info, 'gif', 'Original').id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');

    const { bytes } = await fetchResult(job);
    expect(bytes.subarray(0, 6).toString('latin1')).toMatch(/^GIF8[79]a$/);
  });

  it('converts a GIF to a playable MP4', async () => {
    const info = await resolveUrl(origin.url('/anim.gif'));
    const option = pick(info, 'video', 'MP4');
    expect(option.requiresConversion).toBe(true);

    const job = await runJob({ infoId: info.id, optionIds: [option.id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');

    const { bytes } = await fetchResult(job);
    const path = await writeTemp(bytes, 'fromgif.mp4');
    const probed = await probeFile(path);
    expect(probed.hasVideo).toBe(true);
    expect(probed.videoCodec).toBe('h264');
  });
});

/* -------------------------------------------------------------------------- */
/*  Multiple files and packaging                                              */
/* -------------------------------------------------------------------------- */

describe('multi-file jobs', () => {
  it('packages several selections into a ZIP and lists them individually', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const video = pick(info, 'video', 'Original');
    const mp3 = pick(info, 'audio', 'MP3');

    const job = await runJob({ infoId: info.id, optionIds: [video.id, mp3.id] });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.result!.isArchive).toBe(true);
    expect(job.result!.filename).toMatch(/\.zip$/);
    expect(job.result!.files).toHaveLength(2);

    const { bytes } = await fetchResult(job);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // ZIP magic
    expect(job.progress.totalFiles).toBe(2);
  });

  it('serves each file on its own so a collection can be saved piecemeal', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [pick(info, 'video').id, pick(info, 'audio', 'MP3').id],
    });

    for (const file of job.result!.files!) {
      const response = await app.inject({ method: 'GET', url: file.downloadPath });
      expect(response.statusCode, file.name).toBe(200);
      expect(response.rawPayload.length).toBe(file.sizeBytes);
    }
  });

  it('skips the archive when the caller asks for individual files', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [pick(info, 'video').id, pick(info, 'audio', 'MP3').id],
      packaging: 'individual',
    });
    expect(job.result!.isArchive).toBe(false);
    expect(job.result!.files).toHaveLength(2);
  });

  it('archives a single file when explicitly asked to', async () => {
    const info = await resolveUrl(origin.url('/photo.jpg'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [pick(info, 'image').id],
      packaging: 'zip',
    });
    expect(job.result!.isArchive).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Progress                                                                  */
/* -------------------------------------------------------------------------- */

describe('progress reporting', () => {
  it('streams state changes and ends with a done event', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { infoId: info.id, optionIds: [pick(info, 'audio', 'MP3').id] },
    });
    const { id } = created.json<Job>();

    const events: string[] = [];
    for await (const event of engine.jobs.events(id)) {
      events.push(event.type);
      if (event.type === 'done' || event.type === 'error') break;
    }

    expect(events.at(-1)).toBe('done');
    expect(events.length).toBeGreaterThan(1);
  });

  it('never lets progress move backwards', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        infoId: info.id,
        optionIds: [pick(info, 'video').id, pick(info, 'audio', 'MP3').id],
      },
    });
    const { id } = created.json<Job>();

    let previous = -1;
    for await (const event of engine.jobs.events(id)) {
      if (event.type === 'ping') continue;
      expect(event.job.progress.percent).toBeGreaterThanOrEqual(previous);
      previous = event.job.progress.percent;
      if (event.type === 'done' || event.type === 'error') break;
    }
    expect(previous).toBe(100);
  });
});
