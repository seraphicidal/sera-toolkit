import { describe, expect, it } from 'vitest';
import { SeraError } from '../errors.js';
import {
  hostMatches,
  hostMatchesAny,
  normalizeUrl,
  parseUserUrl,
  stripWww,
  urlExtension,
} from './url.js';

function codeFor(input: string): string {
  try {
    parseUserUrl(input);
    return 'OK';
  } catch (error) {
    return error instanceof SeraError ? error.code : 'THREW';
  }
}

describe('parseUserUrl', () => {
  it('accepts a bare host and assumes https, which is what people paste', () => {
    expect(parseUserUrl('youtube.com/watch?v=abc').url.toString()).toBe(
      'https://youtube.com/watch?v=abc',
    );
    expect(parseUserUrl('  https://vimeo.com/123  ').url.toString()).toBe('https://vimeo.com/123');
  });

  it('strips www for matching but keeps the original host', () => {
    const parsed = parseUserUrl('https://www.reddit.com/r/x/comments/1');
    expect(parsed.host).toBe('reddit.com');
    expect(parsed.rawHost).toBe('www.reddit.com');
  });

  it('refuses schemes that are not http or https', () => {
    for (const input of [
      'file:///etc/passwd',
      'ftp://example.com/x.mp4',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'gopher://example.com',
    ]) {
      expect(codeFor(input), input).toBe('INVALID_URL');
    }
  });

  it('refuses embedded credentials', () => {
    expect(codeFor('https://user:pass@example.com/v.mp4')).toBe('INVALID_URL');
  });

  it('refuses ports other than the web ones', () => {
    expect(codeFor('http://example.com:8080/x.mp4')).toBe('BLOCKED_ADDRESS');
    expect(codeFor('http://example.com:22/x.mp4')).toBe('BLOCKED_ADDRESS');
    expect(codeFor('https://example.com:443/x.mp4')).toBe('OK');
    expect(codeFor('http://example.com:80/x.mp4')).toBe('OK');
  });

  it('refuses literal addresses that point back at infrastructure', () => {
    for (const input of [
      'http://127.0.0.1/x.mp4',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x.mp4',
      'http://192.168.0.1/x.mp4',
      'http://10.1.2.3/x.mp4',
    ]) {
      expect(codeFor(input), input).toBe('BLOCKED_ADDRESS');
    }
  });

  it('refuses control characters instead of letting URL() strip them', () => {
    // Without this, `evil\n.example` parses as a host the caller never inspected.
    expect(codeFor('https://exa\nmple.com/x.mp4')).toBe('INVALID_URL');
    expect(codeFor('https://exa\tmple.com/x.mp4')).toBe('INVALID_URL');
    expect(codeFor('https://exam ple.com/x.mp4')).toBe('INVALID_URL');
    expect(codeFor('https://example.com​/x.mp4')).toBe('INVALID_URL');
    expect(codeFor('https://example.com‮/x.mp4')).toBe('INVALID_URL');
  });

  it('refuses empty input', () => {
    expect(codeFor('')).toBe('INVALID_URL');
    expect(codeFor('   ')).toBe('INVALID_URL');
  });

  it('drops the fragment', () => {
    expect(parseUserUrl('https://example.com/v.mp4#t=30').url.hash).toBe('');
  });
});

describe('normalizeUrl', () => {
  it('removes tracking parameters but keeps addressing ones', () => {
    const normalized = normalizeUrl(
      new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x&feature=share&list=PL1'),
    );
    expect(normalized.searchParams.get('v')).toBe('dQw4w9WgXcQ');
    expect(normalized.searchParams.get('list')).toBe('PL1');
    expect(normalized.searchParams.get('utm_source')).toBeNull();
    expect(normalized.searchParams.get('feature')).toBeNull();
  });

  it('removes the share ids the apps append', () => {
    const normalized = normalizeUrl(
      new URL('https://www.instagram.com/p/ABC/?igshid=1&igsh=2&fbclid=3'),
    );
    expect(normalized.search).toBe('');
  });

  it('produces the same output for the same post pasted from different apps', () => {
    const a = normalizeUrl(new URL('https://x.com/user/status/1?s=20&t=abc'));
    const b = normalizeUrl(new URL('https://x.com/user/status/1?t=xyz&s=46'));
    expect(a.toString()).toBe(b.toString());
  });

  it('sorts the remaining query so ordering is not significant', () => {
    const a = normalizeUrl(new URL('https://e.com/x?b=2&a=1'));
    const b = normalizeUrl(new URL('https://e.com/x?a=1&b=2'));
    expect(a.toString()).toBe(b.toString());
  });

  it('trims a trailing slash from a non-root path', () => {
    expect(normalizeUrl(new URL('https://e.com/a/b/')).pathname).toBe('/a/b');
    expect(normalizeUrl(new URL('https://e.com/')).pathname).toBe('/');
  });

  it('lowercases the host', () => {
    expect(normalizeUrl(new URL('https://YouTube.COM/watch?v=a')).hostname).toBe('youtube.com');
  });
});

describe('host matching', () => {
  it('matches a domain and its subdomains, and nothing else', () => {
    expect(hostMatches('youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatches('www.youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatches('music.youtube.com', 'youtube.com')).toBe(true);
    // The classic suffix-confusion bypass.
    expect(hostMatches('youtube.com.evil.test', 'youtube.com')).toBe(false);
    expect(hostMatches('notyoutube.com', 'youtube.com')).toBe(false);
    expect(hostMatches('evil-youtube.com', 'youtube.com')).toBe(false);
  });

  it('matches against a list', () => {
    expect(hostMatchesAny('vm.tiktok.com', ['tiktok.com', 'x.com'])).toBe(true);
    expect(hostMatchesAny('example.com', ['tiktok.com', 'x.com'])).toBe(false);
  });

  it('strips www', () => {
    expect(stripWww('www.example.com')).toBe('example.com');
    expect(stripWww('example.com')).toBe('example.com');
    expect(stripWww('wwwx.example.com')).toBe('wwwx.example.com');
  });
});

describe('urlExtension', () => {
  it('reads the extension from the path, not the query', () => {
    expect(urlExtension(new URL('https://e.com/a/b.mp4'))).toBe('mp4');
    expect(urlExtension(new URL('https://e.com/a/b.MP4'))).toBe('mp4');
    expect(urlExtension(new URL('https://e.com/a/b.mp4?x=y.png'))).toBe('mp4');
    expect(urlExtension(new URL('https://e.com/a/b'))).toBeUndefined();
    expect(urlExtension(new URL('https://e.com/'))).toBeUndefined();
  });

  it('decodes percent-encoded paths', () => {
    expect(urlExtension(new URL('https://e.com/my%20video.mp4'))).toBe('mp4');
  });
});
