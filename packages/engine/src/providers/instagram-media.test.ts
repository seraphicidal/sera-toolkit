import { describe, expect, it } from 'vitest';
import {
  cdnExpiry,
  INSTAGRAM_MEDIA_HOSTS,
  isAllowedMediaUrl,
  itemsFrom,
  mediaFromImport,
  sessionHeaders,
  shortcodeFrom,
  slidesFrom,
  titleFor,
  type InstagramNode,
} from './instagram-media.js';
import { planKey } from './types.js';

/**
 * The shapes Instagram's web API returns, trimmed from real responses.
 *
 * `media_type` is 1 for an image, 2 for a video and 8 for a carousel, and a carousel may
 * mix the first two — which is the case that breaks every implementation that assumes a
 * post has one kind.
 */

const image = (id: string, width: number, url: string): InstagramNode => ({
  id,
  media_type: 1,
  image_versions2: {
    candidates: [
      { url, width, height: width },
      { url: `${url}?small`, width: 320, height: 320 },
    ],
  },
});

const video = (id: string): InstagramNode => ({
  id,
  media_type: 2,
  video_duration: 12.5,
  video_versions: [
    { url: 'https://cdn/v-720.mp4', width: 720, height: 1280 },
    { url: 'https://cdn/v-480.mp4', width: 480, height: 854 },
  ],
  image_versions2: { candidates: [{ url: 'https://cdn/v-cover.jpg', width: 720, height: 1280 }] },
});

describe('Instagram media normalization', () => {
  it('turns a single photo post into one image item at the size it was uploaded', () => {
    const items = itemsFrom(image('a', 1440, 'https://cdn/a.jpg'), 50);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('image');
    // Candidates are widest-first; the narrow one is a thumbnail, not the media.
    expect(items[0]?.plans[0]?.fetch).toEqual({ via: 'direct', url: 'https://cdn/a.jpg' });
    expect(items[0]?.width).toBe(1440);
    // Nothing to extract audio from.
    expect(items[0]?.plans.map((p) => p.kind)).toEqual(['image']);
  });

  it('keeps every slide of a carousel, in order', () => {
    const carousel: InstagramNode = {
      media_type: 8,
      carousel_media: [
        image('1', 1080, 'https://cdn/1.jpg'),
        image('2', 1080, 'https://cdn/2.jpg'),
        image('3', 1080, 'https://cdn/3.jpg'),
        image('4', 1080, 'https://cdn/4.jpg'),
      ],
    };
    const items = itemsFrom(carousel, 50);
    expect(items).toHaveLength(4);
    // The order is the post's order; a slideshow that shuffles is a broken slideshow.
    expect(items.map((item) => item.plans[0]?.fetch)).toEqual([
      { via: 'direct', url: 'https://cdn/1.jpg' },
      { via: 'direct', url: 'https://cdn/2.jpg' },
      { via: 'direct', url: 'https://cdn/3.jpg' },
      { via: 'direct', url: 'https://cdn/4.jpg' },
    ]);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });

  it('handles a carousel that mixes photographs and video', () => {
    // The case that breaks anything assuming a post has one kind throughout.
    const mixed: InstagramNode = {
      media_type: 8,
      carousel_media: [
        image('1', 1080, 'https://cdn/1.jpg'),
        video('2'),
        image('3', 1080, 'https://cdn/3.jpg'),
        video('4'),
      ],
    };
    const items = itemsFrom(mixed, 50);
    expect(items.map((item) => item.kind)).toEqual(['image', 'video', 'image', 'video']);
    // Each slide is offered what its own kind supports, and nothing else.
    expect(items[0]?.plans.map((p) => p.kind)).toEqual(['image']);
    expect(items[1]?.plans.map((p) => p.kind)).toEqual(['video', 'audio']);
    expect(items[1]?.duration).toBe(12.5);
  });

  it('takes the largest rendition of a video, not the first listed', () => {
    const items = itemsFrom(video('v'), 50);
    expect(items[0]?.plans[0]?.fetch).toEqual({ via: 'direct', url: 'https://cdn/v-720.mp4' });
    expect(items[0]?.thumbnailUrl).toBe('https://cdn/v-cover.jpg');
  });

  it('respects the per-job item ceiling', () => {
    const many: InstagramNode = {
      media_type: 8,
      carousel_media: Array.from({ length: 20 }, (_, i) =>
        image(String(i), 1080, `https://cdn/${i}.jpg`),
      ),
    };
    expect(itemsFrom(many, 5)).toHaveLength(5);
  });

  it('drops a slide with nothing downloadable rather than emitting an empty item', () => {
    const partial: InstagramNode = {
      media_type: 8,
      carousel_media: [image('1', 1080, 'https://cdn/1.jpg'), { id: '2', media_type: 1 }],
    };
    const items = itemsFrom(partial, 50);
    expect(items).toHaveLength(1);
    // And the surviving item is still numbered from zero.
    expect(items[0]?.index).toBe(0);
  });

  it('names a post by its caption, and its author by their name', () => {
    const named = titleFor({
      caption: { text: 'A caption that is the title' },
      user: { username: 'someone', full_name: 'Some One' },
    });
    expect(named).toEqual({ title: 'A caption that is the title', author: 'Some One' });

    const unnamed = titleFor({ user: { username: 'someone' } });
    expect(unnamed.title).toBe('Post by someone');
  });
});

describe('sessionHeaders', () => {
  it('sends the session where Instagram looks for it, and nothing extra', () => {
    const headers = sessionHeaders('a-session-value');
    expect(headers.cookie).toBe('sessionid=a-session-value');
    expect(headers['x-ig-app-id']).toBe('936619743392459');
    // No Authorization header, no bearer, nothing that would end up in a proxy log line
    // under a name something else might decide to record.
    expect(Object.keys(headers).sort()).toEqual(['cookie', 'x-ig-app-id', 'x-requested-with']);
  });
});

/* ------------------------------------------------------------ visitor import */

describe('the hosts an imported post may name', () => {
  it('admits Instagram’s CDN over HTTPS', () => {
    for (const url of [
      'https://scontent-vie1-1.cdninstagram.com/v/t51.2885-15/a.jpg?oh=00_x&oe=6A0B0C0D',
      'https://scontent.cdninstagram.com/v/a.jpg',
      'https://instagram.fvie1-1.fna.fbcdn.net/o1/v/t16/f2/m86/a.mp4?oe=6A0B0C0D',
    ]) {
      expect(isAllowedMediaUrl(url, INSTAGRAM_MEDIA_HOSTS), url).toBe(true);
    }
  });

  it('refuses everything else, including what looks close', () => {
    for (const url of [
      'http://scontent.cdninstagram.com/a.jpg',
      'https://scontent.cdninstagram.com:444/a.jpg',
      'https://u:p@scontent.cdninstagram.com/a.jpg',
      'https://cdninstagram.com.example.org/a.jpg',
      'https://notcdninstagram.com/a.jpg',
      'https://www.instagram.com/p/DcOX3hWFiey/',
      'javascript:alert(1)',
      'data:image/jpeg;base64,AAAA',
      '/relative/a.jpg',
    ]) {
      expect(isAllowedMediaUrl(url, INSTAGRAM_MEDIA_HOSTS), url).toBe(false);
    }
  });
});

describe('cdnExpiry', () => {
  it('reads the expiry Instagram signs into a URL', () => {
    expect(cdnExpiry('https://scontent.cdninstagram.com/a.jpg?oh=00_x&oe=68C7A2B1')).toBe(
      0x68c7a2b1,
    );
  });

  it('has nothing to say about a URL without one, or with a garbled one', () => {
    expect(cdnExpiry('https://scontent.cdninstagram.com/a.jpg')).toBeUndefined();
    expect(cdnExpiry('https://scontent.cdninstagram.com/a.jpg?oe=soon')).toBeUndefined();
    expect(cdnExpiry('not a url')).toBeUndefined();
  });
});

describe('shortcodeFrom', () => {
  it('finds the post in every path Instagram serves one at', () => {
    for (const path of [
      '/p/DcOX3hWFiey/',
      '/reel/DcOX3hWFiey',
      '/reels/DcOX3hWFiey/',
      '/tv/DcOX3hWFiey/',
      '/nasa/p/DcOX3hWFiey/',
    ]) {
      expect(shortcodeFrom(new URL(`https://www.instagram.com${path}`)), path).toBe('DcOX3hWFiey');
    }
    expect(shortcodeFrom(new URL('https://www.instagram.com/nasa/'))).toBeUndefined();
  });
});

describe('mediaFromImport', () => {
  const mixed: InstagramNode = {
    media_type: 8,
    carousel_media: [
      image('1', 1080, 'https://cdn/1.jpg'),
      video('2'),
      image('3', 1080, 'https://cdn/3.jpg'),
    ],
  };
  const post = {
    url: 'https://www.instagram.com/p/DcOX3hWFiey',
    title: 'A post',
    entries: slidesFrom(mixed, 50).map((slide) => slide.entry),
  };

  it('rebuilds the same plans from the same entries, after a trip through a token', () => {
    // The job sees entries that went through JSON, a queue and JSON again. Nothing about
    // the result may depend on which side of that trip built it.
    const atImport = mediaFromImport(post);
    const atJob = mediaFromImport(JSON.parse(JSON.stringify(post)) as typeof post);
    expect(atJob).toEqual(atImport);
    expect(atJob.items.flatMap((item) => item.plans.map(planKey))).toEqual([
      'image/jpg/Original',
      'video/mp4/Original',
      'audio/mp3/MP3',
      'image/jpg/Original',
    ]);
  });

  it('offers exactly what the session route offers for the same post', () => {
    expect(mediaFromImport(post).items.map((item) => item.plans)).toEqual(
      itemsFrom(mixed, 50).map((item) => item.plans),
    );
  });
});
