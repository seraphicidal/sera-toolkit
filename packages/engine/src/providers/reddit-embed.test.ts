import { describe, expect, it } from 'vitest';
import {
  embedUrlFor,
  imagesFrom,
  readViaEmbed,
  screenviewFrom,
  videoBaseFrom,
  videoBaseFromUrl,
} from './reddit-embed.js';

/**
 * Reading a post from what Reddit publishes for embedding.
 *
 * Reddit refuses hosted address ranges on every anonymous route to the data — measured
 * from the live deployment, `.json`, `api.reddit.com` and `old.reddit.com` are all 403.
 * The embed is not, because it is what Reddit hands any site quoting a post. These fixtures
 * are the shapes that host actually serves.
 */

const POST = new URL('https://www.reddit.com/r/aww/comments/1w9mm3q/x/');

/** The element the embed page carries its post data in, escaped as it arrives. */
const screenview = (post: Record<string, unknown>, subreddit = 'aww') =>
  `<shreddit-screenview-data data="${JSON.stringify({ post, subreddit: { name: subreddit } })
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></shreddit-screenview-data>`;

const imagePage = `<html><body>
  ${screenview({ id: 't3_1w9mm3q', url: 'https://i.redd.it/ilf8uq7992oh1.jpeg', type: 'image' })}
  <img src="https://preview.redd.it/hate-we-need-signs-v0-ilf8uq7992oh1.jpeg?width=640">
  <a href="https://i.redd.it/ilf8uq7992oh1.jpeg">open</a>
</body></html>`;

const videoPage = `<html><body>
  ${screenview({ id: 't3_1w9of32', url: 'https://v.redd.it/p4rkjzjtr2oh1', type: 'link' })}
  <shreddit-player src="https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8"></shreddit-player>
</body></html>`;

const galleryPage = `<html><body>
  ${screenview({ id: 't3_gallery', url: 'https://www.reddit.com/gallery/abc', type: 'gallery' })}
  <img src="https://i.redd.it/first111.jpeg"><img src="https://i.redd.it/second22.jpeg">
  <img src="https://i.redd.it/third333.png">
</body></html>`;

const oembed = JSON.stringify({ title: 'A very good dog', author_name: 'yasinozmeen' });

/** Serves each URL from a table, the way the guarded client would. */
function serving(pages: Record<string, string>) {
  const seen: string[] = [];
  const fetchText = (target: URL) => {
    seen.push(target.toString());
    const key = Object.keys(pages).find((prefix) => target.toString().startsWith(prefix));
    if (!key) return Promise.reject(new Error(`nothing serving ${target.toString()}`));
    return Promise.resolve({ body: pages[key]! });
  };
  return { fetchText, seen };
}

const bothHosts = (page: string) => ({
  'https://embed.reddit.com/': page,
  'https://www.reddit.com/oembed': oembed,
});

describe('the embed URL', () => {
  it('is the same path on the host that answers', () => {
    expect(embedUrlFor(POST).toString()).toBe('https://embed.reddit.com/r/aww/comments/1w9mm3q/x/');
  });

  it('drops a query string, which the embed host does not want', () => {
    expect(embedUrlFor(new URL(`${POST.toString()}?utm_source=share&ref=x`)).toString()).toBe(
      'https://embed.reddit.com/r/aww/comments/1w9mm3q/x/',
    );
  });
});

describe('what the embed page carries', () => {
  it('reads the post data out of the escaped attribute', () => {
    const data = screenviewFrom(imagePage);
    expect(data?.post?.type).toBe('image');
    expect(data?.post?.url).toBe('https://i.redd.it/ilf8uq7992oh1.jpeg');
    expect(data?.subreddit?.name).toBe('aww');
  });

  it('survives a page that has no such element', () => {
    expect(screenviewFrom('<html></html>')).toBeUndefined();
    expect(screenviewFrom('<shreddit-screenview-data data="not json">')).toBeUndefined();
  });

  it('takes the image and leaves the resized copy of it', () => {
    // `preview.redd.it` is a variant of an image already listed — and it is the one
    // Reddit host that answers 403 from a datacentre, so offering it would be a button
    // that fails.
    expect(imagesFrom(imagePage)).toEqual(['https://i.redd.it/ilf8uq7992oh1.jpeg']);
  });

  it('keeps a gallery in the order the page names it', () => {
    expect(imagesFrom(galleryPage)).toEqual([
      'https://i.redd.it/first111.jpeg',
      'https://i.redd.it/second22.jpeg',
      'https://i.redd.it/third333.png',
    ]);
  });

  it('finds the hosted-video base', () => {
    expect(videoBaseFrom(videoPage)).toBe('https://v.redd.it/p4rkjzjtr2oh1');
    expect(videoBaseFrom(imagePage)).toBeUndefined();
  });
});

describe('reading a post', () => {
  it('offers each image of a gallery, in order, with the post title', async () => {
    const { fetchText } = serving(bothHosts(galleryPage));
    const media = await readViaEmbed(POST, fetchText, 50);

    expect(media.items).toHaveLength(3);
    expect(media.type).toBe('collection');
    expect(media.items.map((item) => item.plans[0]!.fetch)).toEqual([
      { via: 'direct', url: 'https://i.redd.it/first111.jpeg' },
      { via: 'direct', url: 'https://i.redd.it/second22.jpeg' },
      { via: 'direct', url: 'https://i.redd.it/third333.png' },
    ]);
    expect(media.title).toBe('A very good dog');
    expect(media.author).toBe('u/yasinozmeen');
  });

  it('sends hosted video to the manifest, not to the file', async () => {
    // The progressive MP4 is the one thing on v.redd.it a datacentre is refused, and the
    // manifest is also the only route carrying the audio Reddit stores separately.
    const { fetchText } = serving(bothHosts(videoPage));
    const media = await readViaEmbed(POST, fetchText, 50);

    expect(media.url).toBe('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8');
    expect(media.items[0]?.kind).toBe('video');
    expect(media.items[0]?.plans.map((plan) => plan.kind)).toEqual(['video', 'audio']);
  });

  it('still resolves when oEmbed will not answer', async () => {
    // A nicer title is worth one request and not worth the download.
    const { fetchText } = serving({ 'https://embed.reddit.com/': imagePage });
    const media = await readViaEmbed(POST, fetchText, 50);

    expect(media.items).toHaveLength(1);
    expect(media.title).toBe('Reddit post');
    expect(media.author).toBeUndefined();
  });

  it('says the post has no media rather than blaming the source', async () => {
    const { fetchText } = serving(bothHosts('<html><body>text post</body></html>'));
    await expect(readViaEmbed(POST, fetchText, 50)).rejects.toMatchObject({
      code: 'MEDIA_UNAVAILABLE',
    });
  });

  it('honours the item ceiling', async () => {
    const { fetchText } = serving(bothHosts(galleryPage));
    expect((await readViaEmbed(POST, fetchText, 2)).items).toHaveLength(2);
  });
});

describe('resolving the same media twice', () => {
  /**
   * The invariant the job pipeline depends on. A handle carries `resolved.url`, and for
   * hosted video that is the manifest — so at download time this provider is asked to
   * read a `v.redd.it` URL, which is not a post and has no embed. It used to answer "no
   * post id", and the job died at the last step reporting that the media was gone.
   */
  it('reads a v.redd.it URL without needing the post', async () => {
    const { fetchText, seen } = serving({});
    const media = await readViaEmbed(new URL('https://v.redd.it/p4rkjzjtr2oh1'), fetchText, 50);

    expect(media.items[0]?.kind).toBe('video');
    expect(media.url).toBe('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8');
    // And without a single request, since the URL already says everything.
    expect(seen).toEqual([]);
  });

  it('reads it back from the manifest form it produced', async () => {
    const { fetchText } = serving({});
    const media = await readViaEmbed(
      new URL('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8'),
      fetchText,
      50,
    );
    expect(media.url).toBe('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8');
  });

  it('does not mistake a post URL for a media host', () => {
    expect(videoBaseFromUrl(POST)).toBeUndefined();
    expect(videoBaseFromUrl(new URL('https://i.redd.it/abc.jpeg'))).toBeUndefined();
    expect(videoBaseFromUrl(new URL('https://v.redd.it/abc123'))).toBe('https://v.redd.it/abc123');
  });
});
