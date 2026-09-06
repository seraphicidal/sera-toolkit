import { describe, expect, it } from 'vitest';
import { normalizeForProvider, ProviderRegistry } from './index.js';
import { parseUserUrl } from '../security/url.js';

const registry = new ProviderRegistry();

function detect(input: string): string | undefined {
  const { url } = parseUserUrl(input);
  return registry.detect(url)?.id;
}

function canonical(input: string): string {
  const { url } = parseUserUrl(input);
  const provider = registry.detect(url);
  return provider ? normalizeForProvider(provider, url).toString() : url.toString();
}

describe('provider detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/shorts/abc123', 'youtube'],
    ['https://music.youtube.com/watch?v=abc', 'youtube'],
    ['https://www.youtube-nocookie.com/embed/abc', 'youtube'],
    ['https://x.com/user/status/1234567890', 'twitter'],
    ['https://twitter.com/user/status/1234567890', 'twitter'],
    ['https://mobile.twitter.com/user/status/1', 'twitter'],
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://vm.tiktok.com/ZMabcdef/', 'tiktok'],
    ['https://www.tiktok.com/@user/photo/123', 'tiktok'],
    ['https://www.instagram.com/p/ABC123/', 'instagram'],
    ['https://www.instagram.com/reel/ABC123/', 'instagram'],
    ['https://www.reddit.com/r/videos/comments/abc/title/', 'reddit'],
    ['https://v.redd.it/abcdef', 'reddit'],
    ['https://old.reddit.com/r/pics/comments/x/y/', 'reddit'],
    ['https://www.twitch.tv/videos/123456', 'twitch'],
    ['https://clips.twitch.tv/SomeClipName', 'twitch'],
    ['https://vimeo.com/123456789', 'vimeo'],
    ['https://player.vimeo.com/video/123456789', 'vimeo'],
    ['https://soundcloud.com/artist/track', 'soundcloud'],
    ['https://soundcloud.com/artist/sets/album', 'soundcloud'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://fb.watch/abc123/', 'facebook'],
    ['https://www.pinterest.com/pin/123456/', 'pinterest'],
    ['https://artist.bandcamp.com/track/song', 'bandcamp'],
    ['https://artist.bandcamp.com/album/record', 'bandcamp'],
    ['https://www.dailymotion.com/video/x8abc', 'dailymotion'],
    ['https://dai.ly/x8abc', 'dailymotion'],
    ['https://blog.tumblr.com/post/123', 'tumblr'],
    ['https://www.threads.net/@user/post/ABC', 'threads'],
    ['https://bsky.app/profile/user.bsky.social/post/abc', 'bluesky'],
    ['https://mastodon.social/@user/109876543210', 'mastodon'],
    ['https://www.snapchat.com/spotlight/abc', 'snapchat'],
  ])('routes %s to the %s provider', (input, expected) => {
    expect(detect(input)).toBe(expected);
  });

  it('claims a direct media link with the direct provider', () => {
    expect(detect('https://cdn.example.com/clip.mp4')).toBe('direct');
    expect(detect('https://cdn.example.com/song.mp3')).toBe('direct');
    expect(detect('https://cdn.example.com/photo.JPG')).toBe('direct');
    expect(detect('https://cdn.example.com/anim.gif')).toBe('direct');
    expect(detect('https://cdn.example.com/stream.m3u8')).toBe('direct');
  });

  it('falls back to the generic provider for an unknown page', () => {
    // Deliberate: without the extension gate the direct provider would claim these and
    // turn the service into an open proxy.
    expect(detect('https://example.com/some/article')).toBe('generic');
    expect(detect('https://news.example.org/2026/story')).toBe('generic');
    expect(detect('https://example.com/download.php?id=5')).toBe('generic');
  });

  it('does not let a lookalike host impersonate a platform', () => {
    expect(detect('https://youtube.com.evil.test/watch?v=x')).toBe('generic');
    expect(detect('https://notinstagram.com/p/ABC/')).toBe('generic');
    expect(detect('https://tiktok.com.attacker.example/@a/video/1')).toBe('generic');
  });

  it('recognises an unlisted fediverse server by its status path', () => {
    expect(detect('https://some-instance.example/@alice/109876543210')).toBe('mastodon');
    expect(detect('https://some-instance.example/users/alice/statuses/1234')).toBe('mastodon');
    // A path that is not a status must not be claimed.
    expect(detect('https://some-instance.example/@alice')).toBe('generic');
  });

  it('only claims Bluesky post URLs', () => {
    expect(detect('https://bsky.app/profile/a.bsky.social/post/x')).toBe('bluesky');
    expect(detect('https://bsky.app/profile/a.bsky.social')).toBe('generic');
  });
});

describe('normalization', () => {
  it('folds every YouTube surface onto the watch URL', () => {
    expect(canonical('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(canonical('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(canonical('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(canonical('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('keeps a playlist id when folding a short link', () => {
    expect(canonical('https://youtu.be/abc?list=PL123')).toBe(
      'https://www.youtube.com/watch?v=abc&list=PL123',
    );
  });

  it('rewrites the X mirror front-ends to the real host', () => {
    expect(canonical('https://vxtwitter.com/user/status/1')).toBe('https://x.com/user/status/1');
    expect(canonical('https://fxtwitter.com/user/status/1')).toBe('https://x.com/user/status/1');
    expect(canonical('https://twitter.com/user/status/1')).toBe('https://x.com/user/status/1');
  });

  it('drops the photo index from an X status URL', () => {
    expect(canonical('https://x.com/user/status/1/photo/2')).toBe('https://x.com/user/status/1');
  });

  it('turns a Vimeo embed into the canonical page', () => {
    expect(canonical('https://player.vimeo.com/video/76979871')).toBe('https://vimeo.com/76979871');
  });

  it('expands the Dailymotion shortener', () => {
    expect(canonical('https://dai.ly/x8abc')).toBe('https://www.dailymotion.com/video/x8abc');
  });

  it('leaves TikTok short links alone so the extractor can follow them', () => {
    expect(canonical('https://vm.tiktok.com/ZMabc/')).toBe('https://vm.tiktok.com/ZMabc/');
  });
});

describe('registry', () => {
  it('reports every provider that claims hosts, for the About page', () => {
    const summary = registry.summarize();
    expect(summary.length).toBeGreaterThanOrEqual(17);
    expect(summary.every((entry) => entry.hosts.length > 0)).toBe(true);
    expect(summary.every((entry) => entry.status === 'ok')).toBe(true);
    expect(summary.map((entry) => entry.id)).toContain('youtube');
  });

  it('tracks and clears degradation so one broken extractor degrades alone', () => {
    const local = new ProviderRegistry();
    expect(local.statusOf('instagram')).toBe('ok');
    local.markDegraded('instagram', 'extractor changed');
    expect(local.statusOf('instagram')).toBe('degraded');
    // Everything else is unaffected.
    expect(local.statusOf('youtube')).toBe('ok');
    local.markHealthy('instagram');
    expect(local.statusOf('instagram')).toBe('ok');
  });

  it('lets a degradation lapse on its own', () => {
    const local = new ProviderRegistry();
    local.markDegraded('tiktok', 'transient', -1);
    expect(local.statusOf('tiktok')).toBe('ok');
  });

  it('orders providers so dedicated ones win over the fallbacks', () => {
    const ids = registry.list().map((provider) => provider.id);
    expect(ids.indexOf('youtube')).toBeLessThan(ids.indexOf('direct'));
    expect(ids.indexOf('direct')).toBeLessThan(ids.indexOf('generic'));
    expect(ids.at(-1)).toBe('generic');
  });
});
