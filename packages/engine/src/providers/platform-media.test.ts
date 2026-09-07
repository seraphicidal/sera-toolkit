import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { SeraError, seraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import { InstagramProvider } from './instagram.js';
import { createProviders, ProviderRegistry } from './index.js';
import { itemsFrom, postIdFrom, RedditProvider } from './reddit.js';
import { RedditTokenSource, type RedditPost } from './reddit-api.js';
import { TwitterProvider } from './twitter.js';
import type { ProviderContext } from './types.js';

/**
 * The four platforms that were failing in production, and the shape each of them
 * actually needs. Every fixture below is trimmed from a real response.
 */

const baseConfig = loadConfig({
  NODE_ENV: 'test',
  SERA_SECRET: 'test-secret',
  SERA_DATA_DIR: '.data/test',
});

function contextWith(
  overrides: {
    json?: unknown;
    probe?: () => Promise<never>;
    config?: Partial<typeof baseConfig>;
  } = {},
): ProviderContext {
  return {
    config: { ...baseConfig, ...overrides.config },
    logger: silentLogger(),
    probe:
      overrides.probe ??
      (() => Promise.reject(seraError('UNSUPPORTED_SOURCE', { detail: 'no extractable video' }))),
    head: () => Promise.reject(new Error('not used')),
    fetchText: () =>
      overrides.json === undefined
        ? Promise.reject(new Error('no fixture'))
        : Promise.resolve({ body: JSON.stringify(overrides.json), url: 'https://fixture' }),
  };
}

/* ------------------------------------------------------------------ X / Twitter */

const photoTweet = {
  id_str: '2095585125627003244',
  text: 'An uncrewed Progress cargo spacecraft',
  user: { name: 'NASA', screen_name: 'NASA' },
  mediaDetails: [
    {
      type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/HRUDkRsXsAATlgc.jpg',
      ext_alt_text: 'The Progress 92 cargo spacecraft',
      original_info: { width: 1920, height: 1078 },
    },
    {
      type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/SECOND.jpg',
      original_info: { width: 1200, height: 800 },
    },
  ],
};

const videoTweet = {
  id_str: '2095890073031966734',
  text: 'AvGeeks, assemble!',
  user: { name: 'NASA', screen_name: 'NASA' },
  mediaDetails: [
    {
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/209/img/thumb.jpg',
      original_info: { width: 1920, height: 1080 },
      video_info: {
        duration_millis: 15548,
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a/pl/x.m3u8' },
          {
            bitrate: 256000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/a/vid/avc1/480x270/a.mp4',
          },
          {
            bitrate: 2176000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/a/vid/avc1/1280x720/c.mp4',
          },
        ],
      },
    },
  ],
};

const gifTweet = {
  id_str: '1',
  text: 'a reaction',
  user: { name: 'Someone' },
  mediaDetails: [
    {
      type: 'animated_gif',
      media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg',
      original_info: { width: 498, height: 280 },
      video_info: {
        variants: [
          {
            bitrate: 0,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/tweet_video/498x280/g.mp4',
          },
        ],
      },
    },
  ],
};

describe('TwitterProvider', () => {
  const provider = new TwitterProvider();
  const url = new URL('https://x.com/NASA/status/2095585125627003244');

  it('offers every photograph in post order, at the size that was uploaded', async () => {
    // The extractor answers "No video could be found in this tweet" for all of these,
    // which is why most X posts failed before.
    const media = await provider.resolve(url, contextWith({ json: photoTweet }));

    expect(media.type).toBe('collection');
    expect(media.items.map((item) => item.kind)).toEqual(['image', 'image']);
    // `name=orig` is the original upload; the bare URL is a resized rendition.
    expect(media.items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://pbs.twimg.com/media/HRUDkRsXsAATlgc.jpg?name=orig',
    });
    expect(media.items[0]?.title).toBe('The Progress 92 cargo spacecraft');
    expect(media.items[0]?.width).toBe(1920);
    expect(media.author).toBe('NASA');
  });

  it('turns video renditions into quality options, best first', async () => {
    const media = await provider.resolve(url, contextWith({ json: videoTweet }));

    expect(media.items).toHaveLength(1);
    expect(media.items[0]?.kind).toBe('video');
    // The HLS manifest is not a download; only the progressive renditions are offered.
    const labels = media.items[0]!.plans.map((plan) => plan.label);
    // 480x270 lands on the nearest standard rung the rest of the app speaks in.
    expect(labels).toEqual(['720p', '240p', 'MP3', 'M4A']);
    expect(media.items[0]?.duration).toBeCloseTo(15.548);
  });

  it('treats an animated GIF as one, and offers a real GIF', async () => {
    // X stores these as silent MP4s. Offering only the MP4 is what every other tool does
    // and is not what the person clicking "GIF" asked for.
    const media = await provider.resolve(url, contextWith({ json: gifTweet }));
    expect(media.items[0]?.kind).toBe('gif');
    expect(media.items[0]?.plans.map((p) => `${p.label}/${p.container}`)).toEqual([
      'Original/mp4',
      'GIF/gif',
    ]);
    // No audio options: there is no sound in one.
    expect(media.items[0]?.plans.some((p) => p.kind === 'audio')).toBe(false);
  });

  it('says a post has no media rather than blaming the source', async () => {
    const context = contextWith({ json: { id_str: '20', text: 'just setting up my twttr' } });
    const error = await provider.resolve(url, context).then(
      () => undefined,
      (caught: unknown) => SeraError.from(caught),
    );
    expect(error?.code).toBe('MEDIA_UNAVAILABLE');
    expect(error?.message).toBe('That post has no media to download.');
  });

  it('takes the media from the post a quote is quoting', async () => {
    // Someone pasting a quote post wants the picture in it, which belongs to the post
    // underneath rather than to the share.
    const quote = {
      id_str: '9',
      text: 'look at this',
      user: { name: 'Someone' },
      mediaDetails: [],
      quoted_tweet: photoTweet,
    };
    const media = await provider.resolve(url, contextWith({ json: quote }));
    expect(media.items).toHaveLength(2);
    expect(media.items[0]?.kind).toBe('image');
  });

  it('canonicalizes the mirror front-ends and the photo permalink', () => {
    expect(provider.normalize(new URL('https://fxtwitter.com/a/status/5/photo/1')).toString()).toBe(
      'https://x.com/a/status/5',
    );
  });
});

/* ----------------------------------------------------------------------- Reddit */

const gallery: RedditPost = {
  id: 'abc',
  title: 'Three of them',
  author: 'someone',
  subreddit_name_prefixed: 'r/pics',
  is_gallery: true,
  gallery_data: { items: [{ media_id: 'm1' }, { media_id: 'm2' }, { media_id: 'm3' }] },
  media_metadata: {
    m1: {
      status: 'valid',
      e: 'Image',
      m: 'image/jpg',
      s: { u: 'https://i.redd.it/1.jpg', x: 4, y: 3 },
    },
    m2: { status: 'failed' },
    m3: {
      status: 'valid',
      e: 'AnimatedImage',
      m: 'image/gif',
      s: { gif: 'https://i.redd.it/3.gif', mp4: 'https://i.redd.it/3.mp4', x: 2, y: 2 },
    },
  },
};

const videoPost: RedditPost = {
  id: 'v1',
  title: 'Living the best life',
  secure_media: {
    reddit_video: {
      fallback_url: 'https://v.redd.it/p4rkjzjtr2oh1/DASH_720.mp4?source=fallback',
      width: 1280,
      height: 720,
      duration: 30,
      has_audio: true,
    },
  },
};

describe('RedditProvider', () => {
  const provider = new RedditProvider();

  it('reads a post id from every form Reddit hands out', () => {
    expect(postIdFrom(new URL('https://www.reddit.com/r/aww/comments/1w9of32/living/'))).toBe(
      '1w9of32',
    );
    expect(postIdFrom(new URL('https://redd.it/1w9of32'))).toBe('1w9of32');
    expect(postIdFrom(new URL('https://www.reddit.com/r/aww/'))).toBeUndefined();
  });

  it('keeps gallery order and skips entries Reddit marked failed', () => {
    const items = itemsFrom(gallery, 50);
    expect(items.map((item) => item.kind)).toEqual(['image', 'gif']);
    expect(items[0]?.plans[0]?.fetch).toEqual({ via: 'direct', url: 'https://i.redd.it/1.jpg' });
    // The MP4 leads because it is smaller; the real GIF is still offered.
    expect(items[1]?.plans.map((p) => p.container)).toEqual(['mp4', 'gif']);
  });

  it('takes the container from the type Reddit recorded, not the URL', () => {
    // The extension/MIME mismatch that already bit this application once.
    const items = itemsFrom(
      {
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'x' }] },
        media_metadata: {
          x: {
            status: 'valid',
            e: 'Image',
            m: 'image/png',
            s: { u: 'https://i.redd.it/x', x: 1, y: 1 },
          },
        },
      },
      50,
    );
    expect(items[0]?.container).toBe('png');
  });

  it('unescapes the URLs Reddit embeds in its JSON', () => {
    // A literal `&amp;` in a query string is a 403 from the CDN.
    const items = itemsFrom(
      {
        url_overridden_by_dest: 'https://i.redd.it/a.jpg?width=1&amp;format=pjpg',
        preview: { images: [{ source: { url: 'https://i.redd.it/a.jpg', width: 9, height: 9 } }] },
      },
      50,
    );
    expect(items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://i.redd.it/a.jpg?width=1&format=pjpg',
    });
  });

  it('says when hosted video has no sound instead of letting it be discovered later', () => {
    const silent = itemsFrom(
      {
        secure_media: {
          reddit_video: { fallback_url: 'https://v.redd.it/a/DASH_720.mp4', has_audio: false },
        },
      },
      50,
    );
    expect(silent[0]?.plans[0]?.detail).toContain('silent');
    expect(itemsFrom(videoPost, 50)[0]?.plans[0]?.detail).not.toContain('silent');
  });

  it('follows a crosspost to the post that actually holds the media', () => {
    const share: RedditPost = { id: 's', title: 'shared', crosspost_parent_list: [videoPost] };
    expect(itemsFrom(share.crosspost_parent_list![0]!, 50)).toHaveLength(1);
  });

  it('asks for credentials plainly when none are configured', async () => {
    const error = await provider
      .resolve(new URL('https://www.reddit.com/r/aww/comments/1w9of32/x/'), contextWith())
      .then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );

    expect(error?.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(error?.hint).toContain('SERA_REDDIT_CLIENT_ID');
    // The visitor is told nothing is wrong with their link, because nothing is.
    expect(error?.message).toContain('this server does not have one');
  });
});

describe('RedditTokenSource', () => {
  const credentials = { clientId: 'id', clientSecret: 'secret', userAgent: 'sera/test' };

  it('reuses a token until it is nearly expired, and asks once under a burst', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const tokens = new RedditTokenSource(credentials, silentLogger(), () => now, fetchImpl);

    // Ten jobs starting at once must not become ten token requests.
    const first = await Promise.all(Array.from({ length: 10 }, () => tokens.token()));
    expect(new Set(first)).toEqual(new Set(['t1']));
    expect(calls).toBe(1);

    now += 3500 * 1000;
    expect(await tokens.token()).toBe('t1');

    // Inside the renewal margin, a fresh one is fetched before it can expire in flight.
    now += 100 * 1000;
    expect(await tokens.token()).toBe('t2');
  });

  it("reports bad credentials as configuration, not as the visitor's problem", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
    const tokens = new RedditTokenSource(credentials, silentLogger(), Date.now, fetchImpl);
    const error = await tokens.token().then(
      () => undefined,
      (caught: unknown) => SeraError.from(caught),
    );
    expect(error?.code).toBe('PROVIDER_CONFIGURATION_ERROR');
    // Nothing from the response body, which can echo back what was sent.
    expect(error?.detail).toBe('reddit: token endpoint returned 401');
  });
});

/* -------------------------------------------------------------------- Instagram */

describe('InstagramProvider', () => {
  it('explains what a photo post needs, rather than talking about video', async () => {
    const provider = new InstagramProvider();
    const error = await provider
      .resolve(new URL('https://www.instagram.com/p/DcOX3hWFiey/'), contextWith())
      .then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );

    expect(error?.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(error?.message).toContain('photo posts');
    expect(error?.hint).toContain('Reels and video posts work');
  });

  it('leaves a private post reported as private', async () => {
    const provider = new InstagramProvider();
    const context = contextWith({
      probe: () => Promise.reject(seraError('PRIVATE_CONTENT', { detail: 'private account' })),
    });
    const error = await provider.resolve(new URL('https://www.instagram.com/p/x/'), context).then(
      () => undefined,
      (caught: unknown) => SeraError.from(caught),
    );
    expect(error?.code).toBe('PRIVATE_CONTENT');
  });
});

/* ----------------------------------------------------------------- capabilities */

describe('provider capabilities', () => {
  const registry = new ProviderRegistry(createProviders());
  const byId = new Map(registry.summarize().map((entry) => [entry.id, entry]));

  it('every listed provider declares what it can do', () => {
    for (const summary of registry.summarize()) {
      expect(summary.capabilities, summary.id).toBeDefined();
      expect(typeof summary.capabilities.video, summary.id).toBe('boolean');
    }
  });

  it('does not promise audio extraction from a photo library', () => {
    // A format picker built from a promise like that shows an MP3 button on a JPEG.
    expect(byId.get('soundcloud')?.capabilities.video).toBe(false);
    expect(byId.get('soundcloud')?.capabilities.image).toBe(false);
  });

  it('names the part of a provider that needs credentials', () => {
    expect(byId.get('instagram')?.capabilities.authRequiredFor).toEqual([
      'photo posts',
      'carousels',
    ]);
    expect(byId.get('reddit')?.capabilities.authRequiredFor?.length).toBeGreaterThan(0);
    // X needs none of it any more.
    expect(byId.get('twitter')?.capabilities.authRequiredFor).toBeUndefined();
    expect(byId.get('twitter')?.capabilities.image).toBe(true);
  });
});
