import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { silentLogger } from '../logging.js';
import {
  DropboxProvider,
  extractGoogleDriveId,
  extractMediaFireDirectUrl,
  GoogleDriveProvider,
  MediaFireProvider,
  MegaProvider,
} from './cloud.js';
import type { ProviderContext } from './types.js';

const config = loadConfig({
  NODE_ENV: 'test',
  SERA_SECRET: 'test-secret',
  SERA_DATA_DIR: '.data/test',
});

describe('cloud storage providers', () => {
  it('extracts Google Drive file IDs from multiple URL shapes', () => {
    expect(
      extractGoogleDriveId(
        new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'),
      ),
    ).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(
      extractGoogleDriveId(new URL('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz')),
    ).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(
      extractGoogleDriveId(
        new URL('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&export=download'),
      ),
    ).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
  });

  it('resolves Google Drive files with confirmation bypass', async () => {
    const provider = new GoogleDriveProvider();
    const url = new URL('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view');
    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('not used')),
      fetchText: () => Promise.reject(new Error('not used')),
      head: (target) =>
        Promise.resolve({
          status: 200,
          contentType: 'application/pdf',
          contentLength: 524_288,
          url: target.toString(),
        }),
    };

    const media = await provider.resolve(url, context);
    expect(media.provider).toBe('gdrive');
    expect(media.items[0]?.container).toBe('pdf');
    expect(media.items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&export=download&confirm=t',
    });
  });

  it('normalizes Dropbox links with dl=1 and resolves direct downloads', async () => {
    const provider = new DropboxProvider();
    const url = new URL('https://www.dropbox.com/s/abc123xyz/archive.zip?dl=0');
    const normalized = provider.normalize(url);
    expect(normalized.searchParams.get('dl')).toBe('1');

    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('not used')),
      fetchText: () => Promise.reject(new Error('not used')),
      head: (target) =>
        Promise.resolve({
          status: 200,
          contentType: 'application/zip',
          contentLength: 2_048_000,
          url: target.toString(),
        }),
    };

    const media = await provider.resolve(url, context);
    expect(media.provider).toBe('dropbox');
    expect(media.title).toBe('archive');
    expect(media.items[0]?.container).toBe('zip');
    expect(media.items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://www.dropbox.com/s/abc123xyz/archive.zip?dl=1',
    });
  });

  it('extracts MediaFire direct download links and resolves metadata', async () => {
    const provider = new MediaFireProvider();
    const html = `<html><body><a id="downloadButton" href="https://download1500.mediafire.com/xyz/key123/installer.dmg">Download</a></body></html>`;
    expect(extractMediaFireDirectUrl(html)).toBe(
      'https://download1500.mediafire.com/xyz/key123/installer.dmg',
    );

    const context: ProviderContext = {
      config,
      logger: silentLogger(),
      probe: () => Promise.reject(new Error('not used')),
      fetchText: (target) => Promise.resolve({ body: html, url: target.toString() }),
      head: (target) =>
        Promise.resolve({
          status: 200,
          contentType: 'application/x-apple-diskimage',
          contentLength: 10_485_760,
          url: target.toString(),
        }),
    };

    const media = await provider.resolve(
      new URL('https://www.mediafire.com/file/key123/installer.dmg/file'),
      context,
    );
    expect(media.provider).toBe('mediafire');
    expect(media.items[0]?.container).toBe('dmg');
    expect(media.items[0]?.plans[0]?.fetch).toEqual({
      via: 'direct',
      url: 'https://download1500.mediafire.com/xyz/key123/installer.dmg',
    });
  });

  it('claims MEGA public file links', () => {
    const provider = new MegaProvider();
    expect(provider.canHandle(new URL('https://mega.nz/file/AbCdEfGh'), 'mega.nz')).toBe(true);
    expect(provider.canHandle(new URL('https://mega.nz/'), 'mega.nz')).toBe(false);
  });
});
