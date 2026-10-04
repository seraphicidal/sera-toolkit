import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DownloadOption, Job, MediaInfo } from '@sera/contracts/types';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { subtitleArgs } from '../packages/engine/src/extract/ytdlp.js';
import { languageName, subtitleTracks } from '../packages/engine/src/providers/subtitles.js';
import { taskSubtitles } from '../apps/extractor/src/node.js';
import { ensureFixtures, ffmpegPath, ffprobePath } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

/**
 * Subtitles: which tracks are offered, what yt-dlp is asked for, and what the server refuses
 * before a job starts. Fetching a real track needs YouTube, so that is checked against the
 * live site, not here; the journey through a node is in `extraction-node-job.test.ts`.
 */

let origin: MediaServer;
let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;

beforeAll(async () => {
  const fixtures = await ensureFixtures();
  dataDir = await mkdtemp(join(tmpdir(), 'sera-subtitles-'));
  origin = new MediaServer({
    '/clip.mp4': { file: fixtures.video, contentType: 'video/mp4' },
  });
  await origin.start();

  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'subtitles-secret',
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
  engine.startWorker(1);
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

function option(info: MediaInfo, kind: string): DownloadOption {
  const found = info.items.flatMap((item) => item.options).find((o) => o.kind === kind);
  if (!found) throw new Error(`no ${kind} option`);
  return found;
}

describe('the tracks offered', () => {
  it('lists the manual tracks, named, and leaves out the live chat', () => {
    expect(
      subtitleTracks({
        subtitles: {
          en: [{ ext: 'vtt', name: 'English' }],
          'de-DE': [{ ext: 'vtt' }],
          live_chat: [{ ext: 'json' }],
        },
      }),
    ).toEqual([
      { lang: 'en', label: 'English', auto: false },
      { lang: 'de-DE', label: 'German (Germany)', auto: false },
    ]);
  });

  it('adds the original-language automatic track, labelled, and none of its translations', () => {
    const automatic = Object.fromEntries(
      ['en-orig', 'en', 'fr', 'de', 'ja'].map((lang) => [lang, [{ ext: 'vtt' }]]),
    );
    expect(subtitleTracks({ automatic_captions: automatic })).toEqual([
      { lang: 'en-orig', label: 'English (auto-generated)', auto: true },
    ]);
  });

  it('prefers a manual track to the automatic one in the same language', () => {
    expect(
      subtitleTracks({
        subtitles: { 'en-US': [{ ext: 'vtt' }] },
        automatic_captions: { 'en-orig': [{ ext: 'vtt' }], en: [{ ext: 'vtt' }] },
      }).map((track) => track.lang),
    ).toEqual(['en-US']);
  });

  it("takes the entry's own language when no track is marked original", () => {
    expect(
      subtitleTracks({
        language: 'de',
        automatic_captions: { de: [{ ext: 'vtt' }], en: [{ ext: 'vtt' }] },
      }),
    ).toEqual([{ lang: 'de', label: 'German (auto-generated)', auto: true }]);
  });

  it('offers nothing when there is nothing', () => {
    expect(subtitleTracks({})).toEqual([]);
    expect(languageName('zz-not-a-language')).toBeTypeOf('string');
  });
});

describe('the pieces', () => {
  it('asks yt-dlp for the manual or the automatic track', () => {
    expect(subtitleArgs({ lang: 'en', auto: false })).toEqual([
      '--write-subs',
      '--sub-langs',
      'en',
    ]);
    expect(subtitleArgs({ lang: 'en-orig', auto: true })).toEqual([
      '--write-auto-subs',
      '--sub-langs',
      'en-orig',
    ]);
  });

  it('lets a node take only well-formed subtitles onto its command line', () => {
    expect(taskSubtitles({})).toBeUndefined();
    expect(
      taskSubtitles({ subtitles: { lang: 'en', auto: false, format: 'srt', only: true } }),
    ).toEqual({ lang: 'en', auto: false, format: 'srt', only: true });
    const malformed = (subtitles: unknown) => () =>
      taskSubtitles({ subtitles } as Parameters<typeof taskSubtitles>[0]);
    expect(malformed({ lang: '--exec', auto: false, format: 'srt', only: false })).toThrow();
    expect(malformed({ lang: 'en,all', auto: false, format: 'srt', only: false })).toThrow();
    expect(malformed({ lang: 'en', auto: false, format: 'ass', only: false })).toThrow();
    expect(malformed({ lang: 'en', auto: false, format: 'embed', only: true })).toThrow();
  });
});

describe('refused before the job starts', () => {
  const refused = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/jobs', payload });
    expect(response.statusCode).toBe(400);
    return response.json<{ error: { message: string } }>().error.message;
  };

  it('subtitles for more than one item', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    expect(
      await refused({
        infoId: info.id,
        optionIds: [option(info, 'video').id, option(info, 'audio').id],
        subtitles: { lang: 'en', format: 'srt' },
      }),
    ).toMatch(/one item at a time/);
  });

  it('subtitles with a trim', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    expect(
      await refused({
        infoId: info.id,
        optionIds: [option(info, 'video').id],
        trim: { start: '0:01' },
        subtitles: { lang: 'en', format: 'srt' },
      }),
    ).toMatch(/trimmed/);
  });

  it('an embed into audio', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    expect(
      await refused({
        infoId: info.id,
        optionIds: [option(info, 'audio').id],
        subtitles: { lang: 'en', format: 'embed' },
      }),
    ).toMatch(/MP4, MKV or WebM video/);
  });
});

describe('a track the item does not offer', () => {
  it('fails the job with a plain reason', async () => {
    const info = await resolveUrl(origin.url('/clip.mp4'));
    expect(info.items[0]?.subtitles).toBeUndefined();
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        infoId: info.id,
        optionIds: [option(info, 'video').id],
        subtitles: { lang: 'en', format: 'srt' },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const { id } = created.json<Job>();
    const deadline = Date.now() + 30_000;
    let job: Job;
    for (;;) {
      job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<Job>();
      if (['ready', 'failed'].includes(job.state) || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(job.state).toBe('failed');
    expect(job.error?.message).toMatch(/not available any more/);
  });
});
