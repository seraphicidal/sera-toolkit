import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { silentLogger } from '../logging.js';
import {
  embedUrlFor,
  postRefFrom,
  readEmbed,
  readViaEmbed,
  THREADS_EMBED_AGENT,
} from './threads-embed.js';
import { ThreadsProvider } from './threads.js';
import type { ProviderContext } from './types.js';

const CDN = 'https://scontent-prg1-1.cdninstagram.com';
const AVATAR = `${CDN}/v/t51.82787-19/669747085_n.jpg?stp=dst-jpg_s150x150&amp;oh=00_a`;
const FAVICON = 'https://scontent-prg1-1.xx.fbcdn.net/v/t1.6435-9/756612352_n.png';
const PHOTO = (n: number) =>
  `${CDN}/v/t51.82787-15/84799887${n}_n.jpg?stp=dst-jpg_e35_tt6&amp;oh=00_${n}`;
const VIDEO = `${CDN}/o1/v/t16/f2/m84/AQMRTvs8owzNx.mp4?_nc_cat=108&amp;oh=00_v`;

const header = `<div class="AvatarContainer"><img class="img" src="${AVATAR}" alt="nasa" /></div>
  <div class="HeaderContainer"><a class="HeaderLink" href="https://www.threads.com/&#064;nasa?xmt=AQG">nasa</a>
  <img class="CommunityTagFavicon img" src="${FAVICON}" /></div>`;

const post = (full: boolean, text: string, media: string) => `
  <div class="OuterContainer${full ? ' OuterContainerFull' : ''} OuterContainerFollowButton">
    ${header}
    <div class="BodyContainer"><span class="TextContentContainer"><span class="BodyTextContainer">${text}</span></span>
      ${media}
    </div>
    <div class="PostDateContainer"><span class="Timestamp">2d</span></div>
  </div>`;

const page = (...posts: string[]) =>
  `<html><body class="x1"><div class="Embed"><div class="EmbedContainer">${posts.join('')}</div></div></body></html>`;

const carousel = `<div class="MediaScrollContainer"><div class="MediaContainer">
  <div class="MediaScrollImageContainer"><img class="img" src="${PHOTO(0)}" height="300" /></div>
  <div class="MediaScrollImageContainer"><img class="img" src="${PHOTO(1)}" height="300" /></div>
  <div class="MediaScrollImageContainer"><img class="img" src="${PHOTO(2)}" height="300" /></div>
  <div class="MediaScrollImageContainer"><img class="img" src="${PHOTO(0)}" height="300" /></div>
</div></div>`;

const videoPage = page(
  post(
    true,
    'the coordination is actually unreal &#x1f62d;',
    `<div class="SingleInnerMediaContainer"><video controls="1" loop="1" class=""><source src="${VIDEO}" /></video></div>`,
  ),
);
const carouselPage = page(
  post(true, 'Spotted: a &quot;space jellyfish&quot; by &#064;nasa', carousel),
);
const replyPage = page(
  post(false, 'Spotted: a space jellyfish', carousel),
  post(true, 'A space jellyfish happens near sunrise or sunset', ''),
);
const missingPage =
  '<html><body><div class="Embed"><span>Thread not available</span></div></body></html>';

const decoded = (url: string) => url.replace(/&amp;/g, '&');

function serving(body: string) {
  const seen: { url: string; agent?: string }[] = [];
  const fetchText = (
    target: URL,
    _maxBytes?: number,
    options?: { headers?: Record<string, string> },
  ) => {
    seen.push({ url: target.toString(), agent: options?.headers?.['user-agent'] });
    return Promise.resolve({ body });
  };
  return { fetchText, seen };
}

describe('the post a Threads link names', () => {
  it('reads the author and code from every form Threads hands out', () => {
    expect(postRefFrom(new URL('https://www.threads.com/@nasa/post/Decc755lYhC'))).toEqual({
      user: 'nasa',
      code: 'Decc755lYhC',
    });
    expect(postRefFrom(new URL('https://www.threads.com/@nasa/post/Decc755lYhC/media'))).toEqual({
      user: 'nasa',
      code: 'Decc755lYhC',
    });
    expect(postRefFrom(new URL('https://www.threads.com/t/DeexnW4nw3V'))).toEqual({
      code: 'DeexnW4nw3V',
    });
  });

  it('finds no post on a profile page', () => {
    expect(postRefFrom(new URL('https://www.threads.com/@nasa'))).toBeUndefined();
  });

  it('asks for the embed of that post', () => {
    expect(embedUrlFor({ user: 'nasa', code: 'Decc755lYhC' }).toString()).toBe(
      'https://www.threads.com/@nasa/post/Decc755lYhC/embed',
    );
    expect(embedUrlFor({ code: 'DeexnW4nw3V' }).toString()).toBe(
      'https://www.threads.com/t/DeexnW4nw3V/embed',
    );
  });
});

describe('what the embed page carries', () => {
  it('takes the photos in order, once each, without avatars or badges', () => {
    expect(readEmbed(carouselPage)?.media).toEqual(
      [0, 1, 2].map((n) => ({ kind: 'image', url: decoded(PHOTO(n)) })),
    );
  });

  it('reads only the post itself when the embed also shows the post it answers', () => {
    expect(readEmbed(replyPage)).toEqual({
      media: [],
      text: 'A space jellyfish happens near sunrise or sunset',
    });
  });

  it('decodes the text of the post', () => {
    expect(readEmbed(carouselPage)?.text).toBe('Spotted: a "space jellyfish" by @nasa');
    expect(readEmbed(videoPage)?.text).toBe('the coordination is actually unreal 😭');
  });

  it('ignores media on hosts Threads does not serve from', () => {
    const elsewhere = page(
      post(
        true,
        'x',
        '<img src="https://evil.example/v/t51.1-15/a.jpg" /><img src="http://scontent.cdninstagram.com/v/t51.1-15/b.jpg" />',
      ),
    );
    expect(readEmbed(elsewhere)?.media).toEqual([]);
  });

  it('finds no post on the page Threads shows for a missing thread', () => {
    expect(readEmbed(missingPage)).toBeUndefined();
  });
});

describe('resolving through the embed', () => {
  const POST = new URL('https://www.threads.com/@instagram/post/DeexnW4nw3V');

  it('fetches the embed as itself and downloads the video directly', async () => {
    const { fetchText, seen } = serving(videoPage);
    const media = await readViaEmbed(POST, fetchText, 50);

    expect(seen).toEqual([
      {
        url: 'https://www.threads.com/@instagram/post/DeexnW4nw3V/embed',
        agent: THREADS_EMBED_AGENT,
      },
    ]);
    expect(media.type).toBe('single');
    expect(media.author).toBe('@instagram');
    expect(media.items[0]?.kind).toBe('video');
    expect(media.items[0]?.plans.map((plan) => [plan.kind, plan.container])).toEqual([
      ['video', 'mp4'],
      ['audio', 'mp3'],
    ]);
    expect(media.items[0]?.plans[0]?.fetch).toEqual({ via: 'direct', url: decoded(VIDEO) });
  });

  it('offers every photo of a carousel', async () => {
    const { fetchText } = serving(carouselPage);
    const media = await readViaEmbed(
      new URL('https://www.threads.com/@nasa/post/Decc755lYhC'),
      fetchText,
      50,
    );

    expect(media.type).toBe('collection');
    expect(media.items.map((item) => item.plans[0]?.fetch)).toEqual(
      [0, 1, 2].map((n) => ({ via: 'direct', url: decoded(PHOTO(n)) })),
    );
    expect(media.items[0]?.container).toBe('jpg');
    expect(media.title).toBe('Spotted: a "space jellyfish" by @nasa');
  });

  it('honours the item ceiling', async () => {
    const { fetchText } = serving(carouselPage);
    const media = await readViaEmbed(
      new URL('https://www.threads.com/@nasa/post/Decc755lYhC'),
      fetchText,
      2,
    );
    expect(media.items).toHaveLength(2);
  });

  it('says a text-only post has no media', async () => {
    const { fetchText } = serving(replyPage);
    await expect(
      readViaEmbed(new URL('https://www.threads.com/@nasa/post/Decc8jiFYaY'), fetchText, 50),
    ).rejects.toMatchObject({
      code: 'MEDIA_UNAVAILABLE',
      message: 'That post has no media to download.',
    });
  });

  it('says a missing thread is unavailable', async () => {
    const { fetchText } = serving(missingPage);
    await expect(readViaEmbed(POST, fetchText, 50)).rejects.toMatchObject({
      code: 'MEDIA_UNAVAILABLE',
      message: 'That post is not available.',
    });
  });

  it('refuses a link that names no post before fetching anything', async () => {
    const { fetchText, seen } = serving(videoPage);
    await expect(
      readViaEmbed(new URL('https://www.threads.com/@nasa'), fetchText, 50),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE',
    });
    expect(seen).toEqual([]);
  });
});

describe('ThreadsProvider', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERA_SECRET: 'test-secret',
    SERA_DATA_DIR: '.data/test',
  });

  it('moves threads.net links to threads.com', () => {
    expect(
      new ThreadsProvider()
        .normalize(new URL('http://threads.net/@nasa/post/Decc755lYhC'))
        .toString(),
    ).toBe('https://www.threads.com/@nasa/post/Decc755lYhC');
  });

  it('reads posts from the embed and never asks yt-dlp, which has no Threads extractor', async () => {
    let probed = false;
    const { fetchText } = serving(carouselPage);
    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => {
        probed = true;
        return Promise.reject(new Error('not used'));
      },
      fetchText: (url, maxBytes, options) =>
        fetchText(url, maxBytes, options).then(({ body }) => ({ body, url: url.toString() })),
      head: () => Promise.reject(new Error('not used')),
    };
    const media = await new ThreadsProvider().resolve(
      new URL('https://www.threads.com/@nasa/post/Decc755lYhC'),
      context,
    );
    expect(media.items).toHaveLength(3);
    expect(probed).toBe(false);
  });
});
