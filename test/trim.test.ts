import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DownloadOption, Job, MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { copyIsAccurate, keyframeAtOrBefore } from '../packages/engine/src/convert/trim.js';
import { sectionArgs } from '../packages/engine/src/extract/ytdlp.js';
import { sectionIsUsable } from '../packages/engine/src/jobs/runner.js';
import { taskTrim } from '../apps/extractor/src/node.js';
import {
  ensureFixtures,
  ffmpegPath,
  ffprobePath,
  probeFile,
  type Fixtures,
} from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

/**
 * Trimming, through the real pipeline, read back with ffprobe.
 *
 * The fixture video is 3 s of H.264 with a single keyframe, at 0 — so a cut from 0:01 cannot
 * be a copy without starting a second early, and has to be re-encoded, while a cut from 0:00
 * or of the audio is accurate as a copy. Every output's length is measured, not assumed.
 */

let origin: MediaServer;
let fixtures: Fixtures;
let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-trim-'));
  origin = new MediaServer({
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    '/song.mp3': { file: fixtures.audio, contentType: 'audio/mpeg' },
    '/photo.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
  });
  await origin.start();

  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'trim-secret',
      SERA_DATA_DIR: dataDir,
      SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
      SERA_FFMPEG_PATH: ffmpegPath,
      SERA_FFPROBE_PATH: ffprobePath,
      SERA_RATE_LIMIT_RESOLVE_PER_MINUTE: '1000',
      SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
      SERA_MAX_CONCURRENT_JOBS_PER_CLIENT: '10',
    }),
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

async function resolveUrl(url: string): Promise<MediaInfo> {
  const response = await app.inject({ method: 'POST', url: '/api/media/info', payload: { url } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MediaInfo>();
}

function option(info: MediaInfo, kind: string, label?: string): DownloadOption {
  const found = info.items
    .flatMap((item) => item.options)
    .find((o) => o.kind === kind && (!label || o.label === label));
  if (!found) throw new Error(`no ${kind} option`);
  return found;
}

async function runJob(payload: Record<string, unknown>): Promise<Job> {
  const created = await app.inject({ method: 'POST', url: '/api/jobs', payload });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<Job>();
  const deadline = Date.now() + 90_000;
  for (;;) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<Job>();
    if (['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Downloads a finished job's file and measures it. */
async function measure(job: Job) {
  const response = await app.inject({ method: 'GET', url: job.result!.downloadPath });
  expect(response.statusCode).toBe(200);
  const path = join(dataDir, `check-${job.id}-${job.result!.filename}`);
  await writeFile(path, response.rawPayload);
  return probeFile(path);
}

describe('trimming a video', () => {
  it('cuts from mid-stream accurately, re-encoding because no keyframe is there', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [option(info, 'video', 'Original').id],
      trim: { start: '0:01', end: '0:02' },
    });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.result!.filename).toMatch(/-trim-0m01s-0m02s\.mp4$/);

    const media = await measure(job);
    expect(media.hasVideo).toBe(true);
    expect(media.hasAudio).toBe(true);
    expect(media.durationSeconds).toBeGreaterThan(0.9);
    expect(media.durationSeconds).toBeLessThan(1.15);
  });

  it('keeps a cut from the start as a copy, accurate to the end', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [option(info, 'video', 'Original').id],
      trim: { end: '0:02' },
    });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    expect(job.result!.filename).toMatch(/-trim-0m00s-0m02s\.mp4$/);
    const media = await measure(job);
    expect(Math.abs(media.durationSeconds - 2)).toBeLessThan(0.15);
    expect(media.videoCodec).toBe('h264');
  });
});

describe('trimming audio', () => {
  it('cuts an MP3 accurately as a copy', async () => {
    const info = await resolveUrl(origin.url('/song.mp3'));
    const job = await runJob({
      infoId: info.id,
      optionIds: [option(info, 'audio').id],
      trim: { start: '0:01' },
    });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');
    const media = await measure(job);
    expect(media.hasAudio).toBe(true);
    expect(Math.abs(media.durationSeconds - 1)).toBeLessThan(0.15);
  });
});

describe('what the server refuses', () => {
  const refused = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/jobs', payload });
    expect(response.statusCode).toBe(400);
    return response.json<{ error: { message: string } }>().error.message;
  };

  it('a trim of more than one item', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const message = await refused({
      infoId: info.id,
      optionIds: [option(info, 'video', 'Original').id, option(info, 'audio').id],
      trim: { start: '0:01' },
    });
    expect(message).toMatch(/one item at a time/);
  });

  it('a trim of an image', async () => {
    const info = await resolveUrl(origin.url('/photo.jpg'));
    expect(
      await refused({
        infoId: info.id,
        optionIds: [option(info, 'image').id],
        trim: { end: '0:01' },
      }),
    ).toMatch(/Only video and audio/);
  });

  it('times past the end of the media, measured from the signed option', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    const video = option(info, 'video', 'Original');
    // Only when the resolution knew the length; a link without one is checked at the cut.
    if (info.items[0]?.duration !== undefined) {
      expect(
        await refused({ infoId: info.id, optionIds: [video.id], trim: { start: '5:00' } }),
      ).toMatch(/past the end/);
    }
    expect(
      await refused({
        infoId: info.id,
        optionIds: [video.id],
        trim: { start: '0:02', end: '0:01' },
      }),
    ).toMatch(/before the end/);
  });
});

describe('the pieces', () => {
  it('copies only when the cut is within a quarter second of a keyframe', () => {
    expect(copyIsAccurate(0, undefined)).toBe(true);
    expect(copyIsAccurate(10, 9.9)).toBe(true);
    expect(copyIsAccurate(10, 9.5)).toBe(false);
    expect(copyIsAccurate(10, undefined)).toBe(false);
  });

  it('finds the fixture keyframe at 0, and so knows a cut at 0:01 needs re-encoding', async () => {
    const keyframe = await keyframeAtOrBefore(fixtures.video, 1, {
      ffmpegPath,
      ffprobePath,
      timeoutMs: 30_000,
    });
    expect(keyframe).toBe(0);
    expect(copyIsAccurate(1, keyframe)).toBe(false);
  });

  it('asks yt-dlp for only the section, forcing keyframes when it must', () => {
    expect(sectionArgs({ start: 10, end: 30, forceKeyframes: true })).toEqual([
      '--download-sections',
      '*10-30',
      '--force-keyframes-at-cuts',
    ]);
    expect(sectionArgs({ start: 0, end: 30, forceKeyframes: false })).toEqual([
      '--download-sections',
      '*0-30',
    ]);
    expect(sectionArgs({ start: 65, forceKeyframes: false })).toEqual([
      '--download-sections',
      '*65-inf',
    ]);
  });

  it("trusts yt-dlp's section only when it is readable and the right length", () => {
    const video = { video: {} };
    // A 7 s cut that came back 7 s, or close: kept.
    expect(sectionIsUsable({ ...video, durationSeconds: 7.04 }, { start: 5, end: 12 })).toBe(true);
    // Debian's FFmpeg 5.1 with Vimeo's DASH streams: a second long, or no file at all.
    expect(sectionIsUsable({ ...video, durationSeconds: 0.995 }, { start: 5, end: 12 })).toBe(
      false,
    );
    expect(sectionIsUsable(undefined, { start: 5, end: 12 })).toBe(false);
    expect(sectionIsUsable({ durationSeconds: 7 }, { start: 5, end: 12 })).toBe(false);
    // To the end: measured against the item's length when it is known.
    expect(sectionIsUsable({ ...video, durationSeconds: 55 }, { start: 5 }, 60)).toBe(true);
    expect(sectionIsUsable({ ...video, durationSeconds: 20 }, { start: 5 }, 60)).toBe(false);
    expect(sectionIsUsable({ ...video, durationSeconds: 20 }, { start: 5 })).toBe(true);
    // A long cut may be a tenth off: keyframes and fragment edges.
    expect(sectionIsUsable({ ...video, durationSeconds: 595 }, { start: 0, end: 600 })).toBe(true);
  });

  it('lets a node take only a sane range onto its command line', () => {
    expect(taskTrim({})).toBeUndefined();
    expect(taskTrim({ trim: { start: 10, end: 30 } })).toEqual({ start: 10, end: 30 });
    expect(() => taskTrim({ trim: { start: -1 } })).toThrow();
    expect(() => taskTrim({ trim: { start: 30, end: 10 } })).toThrow();
    expect(() => taskTrim({ trim: { start: Number.NaN } })).toThrow();
  });
});
