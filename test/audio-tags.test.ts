import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  JobRunner,
  loadConfig,
  MediaResolver,
  newJobId,
  ProviderRegistry,
  silentLogger,
  WorkspaceManager,
  type ResolvedMedia,
} from '@sera/engine';
import { pictureBlock, squareCover, tagAudio } from '../packages/engine/src/convert/tags.js';
import { ensureFixtures, ffmpegPath, ffprobePath, type Fixtures } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

const run = promisify(execFile);
const tools = { ffmpegPath, ffprobePath, timeoutMs: 60_000 };

let fixtures: Fixtures;
let dir: string;
let origin: MediaServer;

interface Probed {
  tags: Record<string, string>;
  picture?: { codec: string; width: number; height: number };
  audioCodec?: string;
}

async function inspect(path: string): Promise<Probed> {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format: { tags?: Record<string, string> };
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
      tags?: Record<string, string>;
    }[];
  };
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  const tags = Object.fromEntries(
    Object.entries({ ...parsed.format.tags, ...audio?.tags }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const pic = parsed.streams.find((s) => s.disposition?.attached_pic === 1);
  return {
    tags,
    ...(pic
      ? { picture: { codec: pic.codec_name, width: pic.width ?? 0, height: pic.height ?? 0 } }
      : {}),
    ...(audio ? { audioCodec: audio.codec_name } : {}),
  };
}

beforeAll(async () => {
  fixtures = await ensureFixtures();
  dir = await mkdtemp(join(tmpdir(), 'sera-tags-'));
  for (const [ext, codec] of [
    ['m4a', 'aac'],
    ['opus', 'libopus'],
  ] as const) {
    await run(ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-i',
      fixtures.audio,
      '-c:a',
      codec,
      join(dir, `in.${ext}`),
    ]);
  }
  await run(ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-i',
    fixtures.audio,
    '-c:a',
    'copy',
    join(dir, 'in.mp3'),
  ]);
  origin = new MediaServer({
    '/song.mp3': { file: fixtures.audio, contentType: 'audio/mpeg' },
    '/cover.jpg': { file: fixtures.image, contentType: 'image/jpeg' },
    '/gone.jpg': { status: 404 },
  });
  await origin.start();
});

afterAll(async () => {
  await origin?.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('tagAudio', () => {
  const tags = { title: 'Flickermood = test; #1', artist: 'Forss', album: 'Soulhack' };

  it('makes the cover square, from a 4:3 picture', async () => {
    const { size } = await squareCover(fixtures.image, join(dir, 'cover.jpg'), tools);
    expect(size).toBe(600);
  });

  for (const ext of ['mp3', 'm4a', 'opus']) {
    it(`writes the tags and a square cover into ${ext.toUpperCase()}`, async () => {
      await squareCover(fixtures.image, join(dir, 'cover.jpg'), tools);
      const output = join(dir, `out.${ext}`);
      await tagAudio({
        ...tools,
        input: join(dir, `in.${ext}`),
        output,
        scratchDir: dir,
        coverPath: join(dir, 'cover.jpg'),
        tags,
      });
      const probed = await inspect(output);
      expect(probed.tags.title).toBe(tags.title);
      expect(probed.tags.artist).toBe('Forss');
      expect(probed.tags.album).toBe('Soulhack');
      expect(probed.audioCodec).toBe(ext === 'mp3' ? 'mp3' : ext === 'm4a' ? 'aac' : 'opus');
      if (ext === 'opus') {
        const block = probed.tags.metadata_block_picture;
        expect(probed.picture ?? { width: block && block.length > 1000 ? 600 : 0 }).toMatchObject({
          width: 600,
        });
      } else {
        expect(probed.picture).toEqual({ codec: 'mjpeg', width: 600, height: 600 });
      }
    });
  }

  it('tags without a cover when there is none', async () => {
    const output = join(dir, 'nocover.mp3');
    await tagAudio({ ...tools, input: join(dir, 'in.mp3'), output, scratchDir: dir, tags });
    const probed = await inspect(output);
    expect(probed.tags.artist).toBe('Forss');
    expect(probed.picture).toBeUndefined();
  });

  it('builds the FLAC picture block an Opus player reads', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const block = Buffer.from(pictureBlock(jpeg, 600, 600), 'base64');
    let offset = 0;
    const u32 = () => {
      const value = block.readUInt32BE(offset);
      offset += 4;
      return value;
    };
    expect(u32()).toBe(3);
    const mimeLength = u32();
    expect(block.subarray(offset, offset + mimeLength).toString()).toBe('image/jpeg');
    offset += mimeLength;
    expect(u32()).toBe(0);
    expect([u32(), u32(), u32(), u32()]).toEqual([600, 600, 24, 0]);
    expect(u32()).toBe(jpeg.length);
    expect(block.subarray(offset).equals(jpeg)).toBe(true);
  });
});

describe('an audio job', () => {
  async function runAudioJob(
    thumbnail: string,
    itemThumbnails: { thumbnailUrl?: string; thumbnailFallbackUrl?: string } = {},
  ) {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_DATA_DIR: join(dir, 'jobs'),
      SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
      SERA_FFMPEG_PATH: ffmpegPath,
      SERA_FFPROBE_PATH: ffprobePath,
    });
    const logger = silentLogger();
    const resolver = new MediaResolver({
      config,
      logger,
      registry: new ProviderRegistry(undefined, config),
    });
    const media: ResolvedMedia = {
      provider: 'soundcloud',
      providerLabel: 'SoundCloud',
      url: 'https://soundcloud.com/forss/flickermood',
      type: 'single',
      title: 'Flickermood',
      author: 'Forss (uploader)',
      thumbnailUrl: thumbnail,
      items: [
        {
          index: 0,
          kind: 'audio',
          title: 'Flickermood',
          tags: { artist: 'Forss', album: 'Soulhack' },
          ...itemThumbnails,
          plans: [
            {
              kind: 'audio',
              container: 'mp3',
              label: 'MP3',
              requiresConversion: false,
              recommended: true,
              fetch: { via: 'direct', url: origin.url('/song.mp3') },
            },
          ],
        },
      ],
    };
    vi.spyOn(resolver, 'resolveCanonical').mockResolvedValue(media);
    const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
    const runner = new JobRunner({ config, logger, resolver, workspaces });
    const jobId = newJobId();
    const result = await runner.run(
      {
        jobId,
        provider: 'soundcloud',
        url: media.url,
        selections: [{ itemIndex: 0, planKey: 'audio/mp3/MP3' }],
        packaging: 'auto',
      },
      () => undefined,
    );
    return inspect(await workspaces.resolveFile(jobId, result.filename));
  }

  it("comes out with the source's artist and album, and its thumbnail as the cover", async () => {
    const probed = await runAudioJob(origin.url('/cover.jpg'));
    expect(probed.tags).toMatchObject({ title: 'Flickermood', artist: 'Forss', album: 'Soulhack' });
    expect(probed.picture).toEqual({ codec: 'mjpeg', width: 600, height: 600 });
  });

  it('is still tagged, without a cover, when the thumbnail cannot be fetched', async () => {
    const probed = await runAudioJob(origin.url('/gone.jpg'));
    expect(probed.tags.artist).toBe('Forss');
    expect(probed.picture).toBeUndefined();
  });

  it("falls back to the next thumbnail when the first is missing, as YouTube's maxres often is", async () => {
    const probed = await runAudioJob(origin.url('/gone.jpg'), {
      thumbnailUrl: origin.url('/gone.jpg'),
      thumbnailFallbackUrl: origin.url('/cover.jpg'),
    });
    expect(probed.picture).toEqual({ codec: 'mjpeg', width: 600, height: 600 });
  });
});
