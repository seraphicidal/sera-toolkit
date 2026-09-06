import { describe, expect, it } from 'vitest';
import { discoverMedia } from './html.js';

const base = new URL('https://example.com/story/1');

function page(head: string, body = ''): ReturnType<typeof discoverMedia> {
  return discoverMedia(`<html><head>${head}</head><body>${body}</body></html>`, base);
}

describe('discoverMedia', () => {
  it('reads OpenGraph video and its dimensions', () => {
    const result = page(
      [
        '<meta property="og:title" content="A Story">',
        '<meta property="og:video" content="https://cdn.example.com/v.mp4">',
        '<meta property="og:video:width" content="1280">',
        '<meta property="og:video:height" content="720">',
        '<meta property="og:site_name" content="Example News">',
      ].join(''),
    );

    expect(result.title).toBe('A Story');
    expect(result.siteName).toBe('Example News');
    expect(result.media[0]).toMatchObject({
      url: 'https://cdn.example.com/v.mp4',
      kind: 'video',
      source: 'og:video',
      width: 1280,
      height: 720,
    });
  });

  it('resolves relative URLs against the page', () => {
    const result = page('<meta property="og:video" content="/media/clip.mp4">');
    expect(result.media[0]?.url).toBe('https://example.com/media/clip.mp4');
  });

  it('reads video and source elements', () => {
    const result = page(
      '',
      '<video src="/a.mp4"></video><video><source src="/b.webm" type="video/webm"></video>',
    );
    expect(result.media.map((m) => m.url)).toEqual([
      'https://example.com/a.mp4',
      'https://example.com/b.webm',
    ]);
    expect(result.media[1]?.mimeType).toBe('video/webm');
  });

  it('reads audio elements', () => {
    const result = page('', '<audio src="/track.mp3"></audio>');
    expect(result.media[0]).toMatchObject({ kind: 'audio', source: 'audio' });
  });

  it('reads a schema.org VideoObject', () => {
    const result = page(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'VideoObject',
        name: 'Structured',
        contentUrl: 'https://cdn.example.com/ld.mp4',
      })}</script>`,
    );
    expect(result.media[0]).toMatchObject({
      url: 'https://cdn.example.com/ld.mp4',
      source: 'json-ld',
    });
  });

  it('survives malformed JSON-LD rather than failing the whole resolve', () => {
    const result = page(
      '<script type="application/ld+json">{ not json </script><meta property="og:video" content="/v.mp4">',
    );
    expect(result.media).toHaveLength(1);
  });

  it('ranks a declared video above a preview image', () => {
    const result = page(
      '<meta property="og:image" content="/thumb.jpg"><meta property="og:video" content="/v.mp4">',
    );
    expect(result.media[0]?.source).toBe('og:video');
    expect(result.media.at(-1)?.source).toBe('og:image');
  });

  it('classifies by the extension when one is present', () => {
    const result = page('', '<video src="/a.mp3"></video>');
    // The element says video; the file says otherwise, and the file wins.
    expect(result.media[0]?.kind).toBe('audio');
  });

  it('recognises a GIF as its own kind', () => {
    const result = page('<meta property="og:image" content="/anim.gif">');
    expect(result.media[0]?.kind).toBe('gif');
  });

  it('refuses data and blob URLs', () => {
    const result = page(
      '',
      '<video src="data:video/mp4;base64,AAAA"></video><video src="blob:https://example.com/x"></video>',
    );
    expect(result.media).toHaveLength(0);
  });

  it('refuses non-http schemes', () => {
    const result = page(
      '',
      '<video src="javascript:alert(1)"></video><audio src="file:///etc/passwd"></audio>',
    );
    expect(result.media).toHaveLength(0);
  });

  it('deduplicates the same URL found twice', () => {
    const result = page(
      '<meta property="og:video" content="/v.mp4"><meta property="og:video:url" content="/v.mp4">',
      '<video src="/v.mp4"></video>',
    );
    expect(result.media).toHaveLength(1);
  });

  it('finds nothing on a page that declares nothing', () => {
    const result = page('<title>Just a page</title>', '<p>Some text.</p>');
    expect(result.media).toHaveLength(0);
    expect(result.title).toBe('Just a page');
  });

  it('falls back to the hostname when the page names no author', () => {
    expect(page('<title>x</title>').author).toBe('example.com');
  });
});
