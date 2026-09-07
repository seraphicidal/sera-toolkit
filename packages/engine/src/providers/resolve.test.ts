import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { SeraError } from '../errors.js';
import type { YtdlpInfo } from '../extract/ytdlp-types.js';
import { silentLogger } from '../logging.js';
import type { DownloadPlan, ProviderContext, ResolvedMedia } from './types.js';
import { InstagramProvider } from './instagram.js';
import { RedditProvider } from './reddit.js';
import { SoundCloudProvider } from './soundcloud.js';
import { TwitterProvider } from './twitter.js';
import { YouTubeProvider } from './youtube.js';

const config = loadConfig({
  NODE_ENV: 'test',
  SERA_SECRET: 'test-secret',
  SERA_DATA_DIR: '.data/test',
});

function contextFor(info: YtdlpInfo): ProviderContext {
  return {
    config,
    logger: silentLogger(),
    probe: () => Promise.resolve(info),
    fetchText: () => Promise.reject(new Error('not used')),
    head: () => Promise.reject(new Error('not used')),
  };
}

const labelsFor = (media: ResolvedMedia, kind: DownloadPlan['kind']): string[] =>
  (media.items[0]?.plans ?? []).filter((p) => p.kind === kind).map((p) => p.label);

/* -------------------------------------------------------------------------- */

const youtubeInfo: YtdlpInfo = {
  id: 'dQw4w9WgXcQ',
  _type: 'video',
  title: 'A Video Title',
  description: 'Some description',
  uploader: 'Some Channel',
  uploader_url: 'https://www.youtube.com/@some',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  duration: 212,
  timestamp: 1_700_000_000,
  thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
  thumbnails: [
    { url: 'https://i.ytimg.com/vi/x/small.jpg', width: 120, preference: 0 },
    { url: 'https://i.ytimg.com/vi/x/medium.jpg', width: 640, preference: 0 },
    { url: 'https://i.ytimg.com/vi/x/max.jpg', width: 1920, preference: 0 },
  ],
  view_count: 1234,
  formats: [
    { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', vcodec: 'none', acodec: 'none' },
    {
      format_id: '140',
      ext: 'm4a',
      protocol: 'https',
      acodec: 'mp4a.40.2',
      vcodec: 'none',
      abr: 129,
      filesize: 3_400_000,
    },
    {
      format_id: '140-drc',
      ext: 'm4a',
      protocol: 'https',
      acodec: 'mp4a.40.2',
      vcodec: 'none',
      abr: 129,
    },
    {
      format_id: '251',
      ext: 'webm',
      protocol: 'https',
      acodec: 'opus',
      vcodec: 'none',
      abr: 141,
      filesize: 3_700_000,
    },
    {
      format_id: '137',
      ext: 'mp4',
      protocol: 'https',
      vcodec: 'avc1.640028',
      acodec: 'none',
      width: 1920,
      height: 1080,
      fps: 30,
      tbr: 4000,
      filesize: 106_000_000,
    },
    {
      format_id: '136',
      ext: 'mp4',
      protocol: 'https',
      vcodec: 'avc1.4d401f',
      acodec: 'none',
      width: 1280,
      height: 720,
      fps: 30,
      tbr: 2000,
      filesize: 53_000_000,
    },
    {
      format_id: '135',
      ext: 'mp4',
      protocol: 'https',
      vcodec: 'avc1.4d401e',
      acodec: 'none',
      width: 854,
      height: 480,
      tbr: 1000,
      filesize: 26_000_000,
    },
  ],
};

describe('YouTube video', () => {
  it('produces one video option per available height, best first', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    // Three heights plus the MOV remux of the best one. Every label is distinct, so a
    // quality dropdown never shows the same text twice.
    const labels = labelsFor(media, 'video');
    expect(labels).toEqual(['1080p', '720p', '480p', '1080p (MOV)']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('merges a video stream with matching audio rather than re-encoding', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    const best = media.items[0]!.plans.find((p) => p.kind === 'video')!;
    expect(best.fetch).toMatchObject({ via: 'ytdlp', selector: '137+140', merge: 'mp4' });
    expect(best.requiresConversion).toBe(false);
    expect(best.container).toBe('mp4');
  });

  it('adds the two stream sizes together for the estimate', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    const best = media.items[0]!.plans.find((p) => p.kind === 'video')!;
    expect(best.filesizeBytes).toBe(106_000_000 + 3_400_000);
  });

  it('offers audio formats and defaults to MP3', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    expect(labelsFor(media, 'audio')).toEqual(['MP3', 'M4A', 'Opus', 'WAV']);
    const recommended = media.items[0]!.plans.find((p) => p.kind === 'audio' && p.recommended);
    expect(recommended?.container).toBe('mp3');
  });

  it('does not claim a bitrate the source cannot supply', async () => {
    // Source audio is ~129 kbps, so 320 would be an invented number.
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    const mp3 = media.items[0]!.plans.find((p) => p.container === 'mp3')!;
    expect(mp3.audioBitrateKbps).toBeLessThanOrEqual(144);
  });

  it('copies rather than transcodes when the source codec already matches', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    const m4a = media.items[0]!.plans.find((p) => p.container === 'm4a')!;
    expect(m4a.requiresConversion).toBe(false);
    expect(m4a.detail).toContain('Original quality');
  });

  it('offers MOV as a pure remux of the best rendition', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    const mov = media.items[0]!.plans.find((p) => p.container === 'mov');
    expect(mov?.requiresConversion).toBe(false);
    expect(mov?.fetch).toMatchObject({ remux: 'mov' });
  });

  it('marks exactly one default per kind', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    for (const kind of ['video', 'audio'] as const) {
      const defaults = media.items[0]!.plans.filter((p) => p.kind === kind && p.recommended);
      expect(defaults, kind).toHaveLength(1);
    }
  });

  it('carries the metadata the preview card needs', async () => {
    const media = await new YouTubeProvider().resolve(
      new URL(youtubeInfo.webpage_url!),
      contextFor(youtubeInfo),
    );
    expect(media.title).toBe('A Video Title');
    expect(media.author).toBe('Some Channel');
    expect(media.duration).toBe(212);
    expect(media.type).toBe('single');
    expect(media.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    // The 640px thumbnail, not the 120px or the 1920px one.
    expect(media.thumbnailUrl).toContain('medium.jpg');
  });
});

/* -------------------------------------------------------------------------- */

const carouselInfo: YtdlpInfo = {
  _type: 'playlist',
  id: 'ABC123',
  title: 'A carousel post',
  uploader: 'someone',
  webpage_url: 'https://www.instagram.com/p/ABC123',
  entries: [
    {
      id: 'i1',
      ext: 'jpg',
      url: 'https://cdn.example/1.jpg',
      width: 1080,
      height: 1080,
      filesize: 200_000,
    },
    {
      id: 'i2',
      ext: 'jpg',
      url: 'https://cdn.example/2.jpg',
      width: 1080,
      height: 1350,
      filesize: 250_000,
    },
    {
      id: 'v3',
      ext: 'mp4',
      duration: 15,
      formats: [
        {
          format_id: 'dash-v',
          ext: 'mp4',
          protocol: 'https',
          vcodec: 'avc1.4d401f',
          acodec: 'none',
          width: 720,
          height: 1280,
          tbr: 1500,
        },
        {
          format_id: 'dash-a',
          ext: 'm4a',
          protocol: 'https',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          abr: 128,
        },
      ],
    },
    { id: 'i4', ext: 'jpg', url: 'https://cdn.example/4.jpg', width: 1080, height: 1080 },
  ],
};

describe('Instagram carousel', () => {
  it('resolves every slide, not just the first', async () => {
    // The single most common failure in tools like this.
    const media = await new InstagramProvider().resolve(
      new URL('https://www.instagram.com/p/ABC123'),
      contextFor(carouselInfo),
    );
    expect(media.items).toHaveLength(4);
    expect(media.type).toBe('collection');
  });

  it('keeps the published order and kinds', async () => {
    const media = await new InstagramProvider().resolve(
      new URL('https://www.instagram.com/p/ABC123'),
      contextFor(carouselInfo),
    );
    expect(media.items.map((item) => item.kind)).toEqual(['image', 'image', 'video', 'image']);
    expect(media.items.map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });

  it('gives each slide its own options', async () => {
    const media = await new InstagramProvider().resolve(
      new URL('https://www.instagram.com/p/ABC123'),
      contextFor(carouselInfo),
    );
    const image = media.items[0]!;
    expect(image.plans.map((p) => p.label)).toEqual(['Original']);
    expect(image.plans[0]?.container).toBe('jpg');

    const video = media.items[2]!;
    expect(video.plans.some((p) => p.kind === 'video')).toBe(true);
    expect(video.plans.some((p) => p.kind === 'audio')).toBe(true);
  });

  it('records the provider id for each item so a shifted carousel is detected later', async () => {
    const media = await new InstagramProvider().resolve(
      new URL('https://www.instagram.com/p/ABC123'),
      contextFor(carouselInfo),
    );
    expect(media.items.map((item) => item.sourceId)).toEqual(['i1', 'i2', 'v3', 'i4']);
  });
});

/* -------------------------------------------------------------------------- */

describe('X GIF post', () => {
  const gifPost: YtdlpInfo = {
    id: '123',
    title: 'a gif post',
    uploader: 'someone',
    duration: 6,
    webpage_url: 'https://x.com/someone/status/123',
    formats: [
      // What the interface calls a GIF is a silent MP4.
      {
        format_id: 'http-950',
        ext: 'mp4',
        protocol: 'https',
        vcodec: 'avc1.4d401f',
        acodec: 'none',
        width: 480,
        height: 480,
        tbr: 950,
      },
    ],
  };

  it('offers the real video and a GIF conversion, labelled honestly', async () => {
    const media = await new TwitterProvider().resolve(
      new URL(gifPost.webpage_url!),
      contextFor(gifPost),
    );
    const gif = media.items[0]!.plans.find((p) => p.kind === 'gif');
    expect(gif).toBeDefined();
    expect(gif?.requiresConversion).toBe(true);
    expect(gif?.convert).toMatchObject({ kind: 'gif' });
    expect(media.items[0]!.plans.some((p) => p.kind === 'video')).toBe(true);
  });

  it('offers no audio options for a silent post', async () => {
    const media = await new TwitterProvider().resolve(
      new URL(gifPost.webpage_url!),
      contextFor(gifPost),
    );
    expect(media.items[0]!.plans.some((p) => p.kind === 'audio')).toBe(false);
  });

  it('does not offer a GIF of a long video', async () => {
    const long = { ...gifPost, duration: 600 };
    const media = await new TwitterProvider().resolve(
      new URL(gifPost.webpage_url!),
      contextFor(long),
    );
    expect(media.items[0]!.plans.some((p) => p.kind === 'gif')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('SoundCloud track', () => {
  const track: YtdlpInfo = {
    id: 't1',
    title: 'A Track',
    uploader: 'An Artist',
    duration: 180,
    webpage_url: 'https://soundcloud.com/artist/track',
    ext: 'mp3',
    formats: [
      {
        format_id: 'http_mp3',
        ext: 'mp3',
        protocol: 'https',
        vcodec: 'none',
        acodec: 'mp3',
        abr: 128,
      },
      {
        format_id: 'hls_opus',
        ext: 'webm',
        protocol: 'm3u8_native',
        vcodec: 'none',
        acodec: 'opus',
        abr: 64,
      },
    ],
  };

  it('offers audio only, with no empty video group', async () => {
    const media = await new SoundCloudProvider().resolve(
      new URL(track.webpage_url!),
      contextFor(track),
    );
    expect(media.items[0]!.kind).toBe('audio');
    expect(media.items[0]!.plans.every((p) => p.kind === 'audio')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('failure handling', () => {
  it('reports a link with nothing downloadable rather than returning an empty result', async () => {
    // Reddit used to stand in here and no longer can: it now refuses before probing,
    // because a server has no anonymous path to it at all. Any extractor-backed
    // provider makes the same point about an empty format list.
    const empty: YtdlpInfo = { id: 'x', title: 'nothing here', formats: [] };
    await expect(
      new YouTubeProvider().resolve(
        new URL('https://www.youtube.com/watch?v=x'),
        contextFor(empty),
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it('refuses Reddit before spending a probe on it', async () => {
    // Reddit answers 403 Blocked to anonymous requests from hosted ranges, so a probe
    // is a guaranteed waste of the one worker this instance has.
    const empty: YtdlpInfo = { id: 'x', title: 'nothing here', formats: [] };
    await expect(
      new RedditProvider().resolve(
        new URL('https://www.reddit.com/r/a/comments/b/c'),
        contextFor(empty),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED' });
  });

  it('surfaces a probe failure unchanged', async () => {
    const context: ProviderContext = {
      ...contextFor({}),
      probe: () => Promise.reject(new SeraError('PRIVATE_CONTENT', 'nope')),
    };
    await expect(
      new InstagramProvider().resolve(new URL('https://www.instagram.com/p/X'), context),
    ).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
  });

  it('refuses a Twitch channel URL before making a request', async () => {
    const { TwitchProvider } = await import('./twitch.js');
    let probed = false;
    const context: ProviderContext = {
      ...contextFor({}),
      probe: () => {
        probed = true;
        return Promise.resolve({});
      },
    };
    await expect(
      new TwitchProvider().resolve(new URL('https://www.twitch.tv/somestreamer'), context),
    ).rejects.toMatchObject({ code: 'LIVE_IN_PROGRESS' });
    expect(probed).toBe(false);
  });

  it('refuses a non-public Snapchat path before making a request', async () => {
    const { SnapchatProvider } = await import('./snapchat.js');
    await expect(
      new SnapchatProvider().resolve(new URL('https://www.snapchat.com/u/private'), contextFor({})),
    ).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
  });
});

/* -------------------------------------------------------------------------- */

describe('extractor tuning reaches the download', () => {
  it("puts a provider's extractor args on the plans it builds", async () => {
    // These were reaching the probe and stopping there: a provider could ask for the
    // player clients that expose 1080p, list them, and then fetch with whatever the
    // extractor defaults to. Both halves of a job have to agree.
    const media = await new YouTubeProvider().resolve(
      new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      contextFor(youtubeInfo),
    );

    const ytdlpPlans = media.items[0]!.plans.filter((plan) => plan.fetch.via === 'ytdlp');
    expect(ytdlpPlans.length).toBeGreaterThan(0);
    for (const plan of ytdlpPlans) {
      expect(plan.fetch.via === 'ytdlp' && plan.fetch.extractorArgs).toContain(
        'youtube:player_client=tv,default,web_safari',
      );
    }
  });

  it('leaves plans alone for a provider that declares none', async () => {
    // The aliasing this replaced emptied the item list entirely when a provider had no
    // args, which is most of them.
    const media = await new TwitterProvider().resolve(
      new URL('https://x.com/someone/status/1'),
      contextFor(youtubeInfo),
    );
    expect(media.items.length).toBeGreaterThan(0);
    for (const plan of media.items[0]!.plans) {
      if (plan.fetch.via === 'ytdlp') expect(plan.fetch.extractorArgs).toBeUndefined();
    }
  });
});
