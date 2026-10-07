import { describe, expect, it } from 'vitest';
import {
  embedUrlFor,
  imagesFrom,
  readViaEmbed,
  screenviewFrom,
  videoBaseFrom,
  videoBaseFromUrl,
} from './reddit-embed.js';

const POST = new URL('https://www.reddit.com/r/aww/comments/1w9mm3q/x/');

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
    const { fetchText } = serving(bothHosts(videoPage));
    const media = await readViaEmbed(POST, fetchText, 50);

    expect(media.url).toBe('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8');
    expect(media.items[0]?.kind).toBe('video');
    expect(media.items[0]?.plans.map((plan) => plan.kind)).toEqual(['video', 'audio']);
  });

  it('still resolves when oEmbed will not answer', async () => {
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
  it('reads a v.redd.it URL without needing the post', async () => {
    const { fetchText, seen } = serving({});
    const media = await readViaEmbed(new URL('https://v.redd.it/p4rkjzjtr2oh1'), fetchText, 50);

    expect(media.items[0]?.kind).toBe('video');
    expect(media.url).toBe('https://v.redd.it/p4rkjzjtr2oh1/HLSPlaylist.m3u8');
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
