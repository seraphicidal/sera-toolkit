import { describe, expect, it } from 'vitest';
import { firstHttpUrl, homeWithUrl, sharedUrl, urlFromFragment } from './share';

/**
 * What a phone's share sheet hands to `/share`.
 *
 * The samples are the shapes real apps send: a browser fills `url`, YouTube and TikTok put
 * the link at the end of a sentence in `text`, and some apps put it in `title`.
 */

describe('sharedUrl', () => {
  it('takes the url field when the sharing app filled it', () => {
    expect(sharedUrl({ url: 'https://example.com/a', text: 'https://example.com/b' })).toBe(
      'https://example.com/a',
    );
  });

  it("finds YouTube's link in the text", () => {
    expect(
      sharedUrl({
        title: 'Big Buck Bunny',
        text: 'Watch "Big Buck Bunny" on YouTube: https://youtu.be/aqz-KE-bpKQ?si=abc123',
      }),
    ).toBe('https://youtu.be/aqz-KE-bpKQ?si=abc123');
  });

  it("finds TikTok's link after its sentence", () => {
    expect(
      sharedUrl({
        text: 'Check out this video! #fyp https://vm.tiktok.com/ZMabc123/ Download TikTok now.',
      }),
    ).toBe('https://vm.tiktok.com/ZMabc123/');
  });

  it('falls back to the title, and to nothing', () => {
    expect(sharedUrl({ title: 'see https://x.com/a/status/1' })).toBe('https://x.com/a/status/1');
    expect(sharedUrl({ text: 'no link here', title: 'none here either' })).toBeUndefined();
    expect(sharedUrl({})).toBeUndefined();
  });

  it('skips a url field that is not a web link, and keeps looking', () => {
    expect(sharedUrl({ url: 'content://media/123', text: 'https://example.com/v' })).toBe(
      'https://example.com/v',
    );
  });
});

describe('firstHttpUrl', () => {
  it('drops the punctuation of the sentence around a link', () => {
    expect(firstHttpUrl('Look: https://example.com/watch?v=1.')).toBe(
      'https://example.com/watch?v=1',
    );
    expect(firstHttpUrl('(https://example.com/a), and more')).toBe('https://example.com/a');
    expect(firstHttpUrl('"https://example.com/a"')).toBe('https://example.com/a');
  });

  it('keeps a bracket that belongs to the link', () => {
    expect(firstHttpUrl('https://en.wikipedia.org/wiki/Up_(2009_film)')).toBe(
      'https://en.wikipedia.org/wiki/Up_(2009_film)',
    );
  });

  it('accepts only http and https', () => {
    expect(firstHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(firstHttpUrl('ftp://example.com/file')).toBeUndefined();
    expect(firstHttpUrl('data:text/html,hello')).toBeUndefined();
    expect(firstHttpUrl('HTTPS://EXAMPLE.COM/A')).toBe('https://example.com/A');
  });

  it('refuses something that only looks like a link', () => {
    expect(firstHttpUrl('https://')).toBeUndefined();
    expect(firstHttpUrl('')).toBeUndefined();
    expect(firstHttpUrl(null)).toBeUndefined();
  });
});

describe('the fragment hand-off', () => {
  it('round-trips a link with its own query and fragment', () => {
    const link = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=10#comments';
    const target = homeWithUrl(link);
    expect(target.startsWith('/#url=')).toBe(true);
    expect(target).not.toContain('?');
    expect(urlFromFragment(target.slice(1))).toBe(link);
  });

  it('ignores any other fragment', () => {
    expect(urlFromFragment('')).toBeUndefined();
    expect(urlFromFragment('#main')).toBeUndefined();
    expect(urlFromFragment('#url=javascript%3Aalert(1)')).toBeUndefined();
  });
});
