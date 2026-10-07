import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import { classify, DirectFileProvider } from './direct.js';
import type { ProviderContext } from './types.js';

const config = loadConfig({
  NODE_ENV: 'test',
  SERA_SECRET: 'test-secret',
  SERA_DATA_DIR: '.data/test',
});

function contextWithHead(contentType: string, contentLength?: number): ProviderContext {
  return {
    config,
    logger: silentLogger(),
    probe: () => Promise.reject(new Error('not used')),
    fetchText: () => Promise.reject(new Error('not used')),
    head: (url) =>
      Promise.resolve({
        url: url.toString(),
        status: 200,
        contentType,
        ...(contentLength === undefined ? {} : { contentLength }),
      }),
  };
}

describe('classify', () => {
  it('trusts the server over the extension', () => {
    expect(classify('text/html', 'gif')).toBe('unknown');
    expect(classify('text/html', 'mp4')).toBe('unknown');
    expect(classify('text/html', 'png')).toBe('unknown');
  });

  it('uses the extension when the server says nothing', () => {
    expect(classify('', 'gif')).toBe('gif');
    expect(classify('', 'mp4')).toBe('video');
    expect(classify('', 'mp3')).toBe('audio');
    expect(classify('', 'png')).toBe('image');
  });

  it('reads the content type when there is one', () => {
    expect(classify('image/gif', 'bin')).toBe('gif');
    expect(classify('video/mp4', '')).toBe('video');
    expect(classify('audio/mpeg', '')).toBe('audio');
    expect(classify('image/png', '')).toBe('image');
  });

  it('falls back to the extension for generic binary types', () => {
    expect(classify('application/octet-stream', 'mp4')).toBe('video');
    expect(classify('binary/octet-stream', 'flac')).toBe('audio');
    expect(classify('application/octet-stream', 'txt')).toBe('unknown');
  });

  it('recognises streaming manifests', () => {
    expect(classify('application/vnd.apple.mpegurl', 'm3u8')).toBe('video');
    expect(classify('application/dash+xml', 'mpd')).toBe('video');
  });
});

describe('DirectFileProvider', () => {
  const provider = new DirectFileProvider();

  it('claims only paths that end in a media extension', () => {
    expect(provider.canHandle(new URL('https://example.com/clip.mp4'))).toBe(true);
    expect(provider.canHandle(new URL('https://example.com/a/b/photo.PNG'))).toBe(true);
    expect(provider.canHandle(new URL('https://example.com/watch?v=abc'))).toBe(false);
    expect(provider.canHandle(new URL('https://example.com/notes.txt'))).toBe(false);
  });

  it('refuses a media-looking URL that serves a web page', async () => {
    const error = await provider
      .resolve(
        new URL('https://commons.wikimedia.org/wiki/File:Rotating_earth_(large).gif'),
        contextWithHead('text/html; charset=UTF-8'),
      )
      .then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );

    expect(error?.code).toBe('UNSUPPORTED_SOURCE');
    expect(error?.message).toBe("That link doesn't point to a media file.");
  });

  it('resolves a real file', async () => {
    const media = await provider.resolve(
      new URL('https://example.com/earth.gif'),
      contextWithHead('image/gif', 1_000_000),
    );

    expect(media.items[0]?.kind).toBe('gif');
    expect(media.items[0]?.container).toBe('gif');
    expect(media.items[0]?.plans.map((p) => p.label)).toEqual(['Original', 'MP4', 'WebM']);
  });

  it('refuses a file larger than the configured limit', async () => {
    const error = await provider
      .resolve(
        new URL('https://example.com/huge.mp4'),
        contextWithHead('video/mp4', config.maxFilesizeBytes + 1),
      )
      .then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );

    expect(error?.code).toBe('TOO_LARGE');
  });
});
