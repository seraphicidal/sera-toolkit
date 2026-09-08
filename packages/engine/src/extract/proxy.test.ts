import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { scrubCredentials } from './ytdlp.js';

/**
 * The other answer to a refused address.
 *
 * YouTube refuses a datacentre by reputation, not by anything about the request, so no
 * choice of player client or protocol changes it — measured on all nine clients yt-dlp
 * offers, from the live deployment. What changes it is asking from somewhere else. An
 * extraction node is one way and needs a machine left on; a proxy is the other and does
 * not.
 *
 * These services bill by the gigabyte and their URLs carry credentials, which is why the
 * setting is per-provider and why the value is treated as a secret.
 */

const configWith = (env: Record<string, string>) =>
  loadConfig({
    NODE_ENV: 'test',
    SERA_SECRET: 'proxy-secret',
    SERA_DATA_DIR: '.data/test',
    ...env,
  });

describe('which providers a proxy applies to', () => {
  it('is nobody when none is configured', () => {
    const config = configWith({});
    expect(config.proxyFor('youtube')).toBeUndefined();
    expect(config.proxyFor('bluesky')).toBeUndefined();
  });

  it('is everybody when no provider list is given', () => {
    const config = configWith({ SERA_EXTRACTION_PROXY_URL: 'http://proxy.example:8080' });
    expect(config.proxyFor('youtube')).toBe('http://proxy.example:8080');
    expect(config.proxyFor('bluesky')).toBe('http://proxy.example:8080');
  });

  it('is only the named ones when a list is given', () => {
    // The setting worth using. Only some providers refuse a datacentre, and a metered
    // connection should not be carrying a Bluesky image.
    const config = configWith({
      SERA_EXTRACTION_PROXY_URL: 'http://proxy.example:8080',
      SERA_EXTRACTION_PROXY_PROVIDERS: 'youtube, instagram',
    });
    expect(config.proxyFor('youtube')).toBe('http://proxy.example:8080');
    expect(config.proxyFor('instagram')).toBe('http://proxy.example:8080');
    expect(config.proxyFor('bluesky')).toBeUndefined();
  });

  it('ignores a list when there is no proxy to apply', () => {
    const config = configWith({ SERA_EXTRACTION_PROXY_PROVIDERS: 'youtube' });
    expect(config.proxyFor('youtube')).toBeUndefined();
  });
});

describe('keeping the password out of the log', () => {
  it('removes credentials from extractor output', () => {
    // yt-dlp names the proxy in a connection error, and that output becomes an error
    // detail, which reaches the structured log. This is the one place it could escape.
    expect(
      scrubCredentials('ERROR: Unable to connect to proxy http://bob:hunter2@proxy.example:8080'),
    ).toBe('ERROR: Unable to connect to proxy http://[redacted]@proxy.example:8080');
  });

  it('handles the schemes these services actually use', () => {
    for (const scheme of ['http', 'https', 'socks5', 'socks5h']) {
      expect(scrubCredentials(`${scheme}://user:pa55@host:1080`)).toBe(
        `${scheme}://[redacted]@host:1080`,
      );
    }
  });

  it('leaves ordinary text and credential-free URLs alone', () => {
    expect(scrubCredentials('ERROR: Sign in to confirm you are not a bot')).toBe(
      'ERROR: Sign in to confirm you are not a bot',
    );
    expect(scrubCredentials('https://www.youtube.com/watch?v=x')).toBe(
      'https://www.youtube.com/watch?v=x',
    );
    // A colon in a path is not a credential.
    expect(scrubCredentials('https://host/a:b/c')).toBe('https://host/a:b/c');
  });

  it('scrubs every occurrence, not just the first', () => {
    expect(scrubCredentials('http://a:b@one https://c:d@two')).toBe(
      'http://[redacted]@one https://[redacted]@two',
    );
  });
});
