import { describe, expect, it } from 'vitest';
import { classifyYtdlpFailure } from './ytdlp.js';
import { num, str } from './ytdlp-types.js';

/**
 * Error classification is matched on the extractor's own wording, which changes. The
 * tests below pin the messages that were current when each mapping was written, and the
 * last case pins the thing that matters most: an unrecognised failure degrades to
 * "this source needs updating" rather than a 500.
 */
describe('classifyYtdlpFailure', () => {
  const cases: [string, string][] = [
    [
      'ERROR: [youtube] abc: Private video. Sign in if you have been granted access.',
      'PRIVATE_CONTENT',
    ],
    ['ERROR: [instagram] This post is private', 'PRIVATE_CONTENT'],
    [
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
      'AGE_RESTRICTED',
    ],
    ['ERROR: This video is DRM protected', 'DRM_PROTECTED'],
    [
      'ERROR: [generic] Sign in to confirm you are not a bot. Use --cookies-from-browser',
      'SOURCE_BLOCKED',
    ],
    // YouTube's own wording, with the typographic apostrophe it actually emits.
    [
      'ERROR: [youtube] Xz3UMZvhgeY: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
      'SOURCE_BLOCKED',
    ],
    // A genuine login wall still reads as one.
    [
      'ERROR: [vimeo] 123: The web client only works when logged-in. Use --cookies',
      'LOGIN_REQUIRED',
    ],
    [
      'ERROR: [youtube] abc: The uploader has not made this video available in your country',
      'GEO_RESTRICTED',
    ],
    ['ERROR: [youtube] abc: This live event will begin in 3 hours.', 'LIVE_IN_PROGRESS'],
    ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
    ['ERROR: Unsupported URL: https://example.com/page', 'UNSUPPORTED_SOURCE'],
    [
      'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
      'MEDIA_UNAVAILABLE',
    ],
    ['ERROR: unable to download video data: HTTP Error 404: Not Found', 'MEDIA_UNAVAILABLE'],
    ['ERROR: [twitter] 123: Requested format is not available', 'MEDIA_UNAVAILABLE'],
    ['ERROR: File is larger than max-filesize (900MB)', 'TOO_LARGE'],
    [
      'ERROR: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>',
      'NETWORK_ERROR',
    ],
    [
      'ERROR: [tiktok] Unable to extract webpage video data; please report this issue',
      'PROVIDER_UNAVAILABLE',
    ],
  ];

  it.each(cases)('maps %s', (stderr, expected) => {
    expect(classifyYtdlpFailure(stderr, 1).code).toBe(expected);
  });

  it('tells a blocked server apart from a login wall', () => {
    // Verified against the live deployment: this exact link resolves with twelve formats
    // from a residential connection and returns the bot challenge from a datacentre one.
    // Saying "this media requires an account" sends the visitor after the wrong problem.
    const blocked = classifyYtdlpFailure(
      'ERROR: [youtube] abc: Sign in to confirm you’re not a bot.',
      1,
    );
    expect(blocked.code).toBe('SOURCE_BLOCKED');
    expect(blocked.message).toBe('This source is blocking this server, not the link.');
    expect(blocked.hint).toMatch(/datacentre/i);
    // Retrying from the same address does the same thing.
    expect(blocked.retryable).toBe(false);
  });

  it('degrades an unrecognised failure to a provider problem, not a crash', () => {
    // The wording will change; the behaviour must not.
    const error = classifyYtdlpFailure('ERROR: something nobody has seen before', 1);
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.httpStatus).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it('keeps the technical detail off the user-facing message', () => {
    const error = classifyYtdlpFailure('ERROR: [youtube] abc: Private video, sign in', 1);
    expect(error.message).not.toContain('youtube');
    expect(error.message).not.toContain('ERROR');
    expect(error.detail).toContain('Private video');
    expect(error.toJobError()).not.toHaveProperty('detail');
  });

  it('is case-insensitive about the extractor’s capitalisation', () => {
    expect(classifyYtdlpFailure('ERROR: PRIVATE VIDEO', 1).code).toBe('PRIVATE_CONTENT');
  });
});

describe('field coercion', () => {
  it('treats the NA placeholder as absent', () => {
    // yt-dlp renders a missing template field as the literal string "NA".
    expect(num('NA')).toBeUndefined();
    expect(str('NA')).toBeUndefined();
  });

  it('treats none and null as absent', () => {
    expect(str('none')).toBeUndefined();
    expect(str('null')).toBeUndefined();
    expect(str('')).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
  });

  it('reads real values, including numeric strings', () => {
    expect(num(42)).toBe(42);
    expect(num('42')).toBe(42);
    expect(num('42.5')).toBe(42.5);
    expect(str('  hello  ')).toBe('hello');
  });

  it('rejects values that are not finite numbers', () => {
    expect(num(Number.NaN)).toBeUndefined();
    expect(num(Infinity)).toBeUndefined();
    expect(num('abc')).toBeUndefined();
    expect(num(null)).toBeUndefined();
  });
});
