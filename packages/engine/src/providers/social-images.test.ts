import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { SeraError, seraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import { BlueskyProvider } from './bluesky.js';
import { MastodonProvider } from './mastodon.js';
import type { ProviderContext } from './types.js';

/**
 * Photo posts.
 *
 * Both extractors answer "no video could be found" for a post carrying photographs,
 * which is the majority of posts on both platforms. Each provider falls back to its
 * platform's public, unauthenticated API — the same endpoint the site's own web client
 * uses — so that a post with four pictures offers four pictures instead of one preview
 * thumbnail, or nothing at all.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  SERA_SECRET: 'test-secret',
  SERA_DATA_DIR: '.data/test',
});

/** A context whose network is a fixed map of URL → response body. */
function contextServing(
  responses: Record<string, unknown>,
  probe: () => Promise<never> = () =>
    Promise.reject(seraError('UNSUPPORTED_SOURCE', { detail: 'no extractable video' })),
): ProviderContext {
  return {
    config,
    logger: silentLogger(),
    probe,
    head: () => Promise.reject(new Error('not used')),
    fetchText: (url) => {
      for (const [prefix, body] of Object.entries(responses)) {
        if (url.toString().startsWith(prefix)) {
          return Promise.resolve({
            body: typeof body === 'string' ? body : JSON.stringify(body),
            url: url.toString(),
          });
        }
      }
      return Promise.reject(new Error(`unexpected request: ${url.toString()}`));
    },
  };
}

/* -------------------------------------------------------------------------- */

const BSKY_POST = 'https://bsky.app/profile/example.bsky.social/post/3lifogne32c25';

const blueskyResponses = {
  'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle': { did: 'did:plc:abc123' },
  'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread': {
    thread: {
      post: {
        author: { handle: 'example.bsky.social', displayName: 'Example Account' },
        record: { text: 'Three shots from the walk' },
        embed: {
          images: [
            {
              fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc123/one@jpeg',
              thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc123/one@jpeg',
              alt: 'A heron on a post',
              aspectRatio: { width: 1208, height: 1136 },
            },
            {
              fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc123/two@jpeg',
              alt: '',
              aspectRatio: { width: 1212, height: 780 },
            },
            {
              fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc123/three@jpeg',
            },
          ],
        },
      },
    },
  },
};

describe('BlueskyProvider', () => {
  const provider = new BlueskyProvider();

  it('claims post URLs only', () => {
    expect(provider.canHandle(new URL(BSKY_POST), 'bsky.app')).toBe(true);
    expect(provider.canHandle(new URL('https://bsky.app/profile/someone'), 'bsky.app')).toBe(false);
  });

  it('offers every image in a photo post, at full size', async () => {
    const media = await provider.resolve(new URL(BSKY_POST), contextServing(blueskyResponses));

    expect(media.type).toBe('collection');
    expect(media.items).toHaveLength(3);
    expect(media.items.every((item) => item.kind === 'image')).toBe(true);
    // feed_fullsize, not the feed_thumbnail the page's og:image tags point at.
    expect(media.items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc123/one@jpeg',
    });
    expect(media.items[0]?.width).toBe(1208);
  });

  it('names each image by its alt text, and numbers the rest', async () => {
    // A carousel of "Image 1, Image 2, Image 3" tells the user nothing about which one
    // they are picking; alt text is the only real name a post carries.
    const media = await provider.resolve(new URL(BSKY_POST), contextServing(blueskyResponses));
    expect(media.items.map((item) => item.title)).toEqual([
      'A heron on a post',
      'Image 2',
      'Image 3',
    ]);
  });

  it('keeps the extractor answer when there are no images either', async () => {
    // A deleted or private post must not be reported as an unsupported source just
    // because the second attempt also came back empty.
    const empty = contextServing(
      {
        'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle': { did: 'did:plc:x' },
        'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread': { thread: { post: {} } },
      },
      () => Promise.reject(seraError('PRIVATE_CONTENT', { detail: 'account is private' })),
    );

    const error = await provider.resolve(new URL(BSKY_POST), empty).then(
      () => undefined,
      (caught: unknown) => SeraError.from(caught),
    );

    expect(error?.code).toBe('PRIVATE_CONTENT');
  });
});

/* -------------------------------------------------------------------------- */

const MASTO_POST = 'https://mastodon.world/@traveller/117229304292401389';

const mastodonStatus = {
  content: '<p>In the North Sea: 8th deck bridges at mid-ships</p>',
  account: { acct: 'traveller', display_name: 'A Traveller' },
  media_attachments: [
    {
      id: '1',
      type: 'image',
      url: 'https://files.mastodon.world/media_attachments/one.jpg',
      preview_url: 'https://files.mastodon.world/media_attachments/one_small.jpg',
      description: 'Looking aft along the boat deck',
      meta: { original: { width: 3325, height: 2494 } },
    },
    {
      id: '2',
      type: 'image',
      url: 'https://files.mastodon.world/media_attachments/two.jpg',
      meta: { original: { width: 3325, height: 2494 } },
    },
    { id: '3', type: 'gifv', url: 'https://files.mastodon.world/media_attachments/three.mp4' },
    { id: '4', type: 'audio', url: 'https://files.mastodon.world/media_attachments/four.mp3' },
  ],
};

describe('MastodonProvider', () => {
  const provider = new MastodonProvider();

  it('claims a status path on an instance it has never heard of', () => {
    // Anyone can run a server; the URL shape is the only reliable signal.
    expect(provider.canHandle(new URL(MASTO_POST), 'mastodon.world')).toBe(true);
    expect(
      provider.canHandle(new URL('https://some.tiny.instance/@a/12345'), 'some.tiny.instance'),
    ).toBe(true);
    expect(provider.canHandle(new URL('https://example.com/about'), 'example.com')).toBe(false);
  });

  it('offers every attachment, with the right kind for each', async () => {
    const media = await provider.resolve(
      new URL(MASTO_POST),
      contextServing({ 'https://mastodon.world/api/v1/statuses/': mastodonStatus }),
    );

    expect(media.items).toHaveLength(4);
    // `gifv` is Mastodon's looping video, not a GIF file — and audio is audio.
    expect(media.items.map((item) => item.kind)).toEqual(['image', 'image', 'gif', 'audio']);
    expect(media.title).toBe('In the North Sea: 8th deck bridges at mid-ships');
    expect(media.author).toBe('A Traveller');
  });

  it('offers a conversion only where one makes sense', async () => {
    const media = await provider.resolve(
      new URL(MASTO_POST),
      contextServing({ 'https://mastodon.world/api/v1/statuses/': mastodonStatus }),
    );

    // A photograph has nothing to convert to; the looping video has a GIF in it.
    expect(media.items[0]?.plans.map((p) => p.label)).toEqual(['Original']);
    expect(media.items[2]?.plans.map((p) => p.label)).toEqual(['Original', 'GIF']);
  });

  it('falls back to the extractor when the status carries no attachments', async () => {
    // A status whose media is a quoted video, say — the API shows nothing and yt-dlp
    // knows what to do.
    let probed = false;
    const context = contextServing(
      { 'https://mastodon.world/api/v1/statuses/': { content: '<p>no media</p>' } },
      () => {
        probed = true;
        return Promise.reject(seraError('UNSUPPORTED_SOURCE', { detail: 'no extractable video' }));
      },
    );

    await provider.resolve(new URL(MASTO_POST), context).catch(() => undefined);
    expect(probed).toBe(true);
  });
});
