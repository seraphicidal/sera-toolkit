import type { ProviderSummary } from '@sera/contracts/types';
import { BandcampProvider } from './bandcamp.js';
import { BlueskyProvider } from './bluesky.js';
import { DailymotionProvider } from './dailymotion.js';
import { DirectFileProvider } from './direct.js';
import { FacebookProvider } from './facebook.js';
import { GenericProvider } from './generic.js';
import { InstagramProvider } from './instagram.js';
import { MastodonProvider } from './mastodon.js';
import { PinterestProvider } from './pinterest.js';
import { RedditProvider } from './reddit.js';
import { SnapchatProvider } from './snapchat.js';
import { SoundCloudProvider } from './soundcloud.js';
import { ThreadsProvider } from './threads.js';
import { TikTokProvider } from './tiktok.js';
import { TumblrProvider } from './tumblr.js';
import { TwitchProvider } from './twitch.js';
import { TwitterProvider } from './twitter.js';
import { VimeoProvider } from './vimeo.js';
import { YouTubeProvider } from './youtube.js';
import { stripWww } from '../security/url.js';
import type { MediaProvider } from './types.js';

export * from './types.js';
export { YtdlpProvider } from './ytdlp-base.js';

/**
 * The provider registry.
 *
 * Order is by `priority`, so a dedicated provider always wins over the direct-file and
 * generic fallbacks. Adding a platform is one import and one entry here — nothing in the
 * API, the worker or the UI changes, because they all speak `MediaInfo`.
 */
export function createProviders(): MediaProvider[] {
  return [
    new YouTubeProvider(),
    new TwitterProvider(),
    new TikTokProvider(),
    new InstagramProvider(),
    new RedditProvider(),
    new TwitchProvider(),
    new VimeoProvider(),
    new SoundCloudProvider(),
    new FacebookProvider(),
    new PinterestProvider(),
    new BandcampProvider(),
    new DailymotionProvider(),
    new TumblrProvider(),
    new ThreadsProvider(),
    new BlueskyProvider(),
    new MastodonProvider(),
    new SnapchatProvider(),
    new DirectFileProvider(),
    new GenericProvider(),
  ].sort((a, b) => a.priority - b.priority);
}

export class ProviderRegistry {
  private readonly providers: readonly MediaProvider[];
  private readonly byId: ReadonlyMap<string, MediaProvider>;
  /** Providers reported as broken at runtime, so one bad extractor degrades alone. */
  private readonly degraded = new Map<string, { until: number; reason: string }>();

  constructor(providers: readonly MediaProvider[] = createProviders()) {
    this.providers = [...providers].sort((a, b) => a.priority - b.priority);
    this.byId = new Map(this.providers.map((p) => [p.id, p]));
  }

  /** Finds the provider that claims `url`, or undefined when none does. */
  detect(url: URL): MediaProvider | undefined {
    const host = stripWww(url.hostname.toLowerCase());
    return this.providers.find((provider) => provider.canHandle(url, host));
  }

  get(id: string): MediaProvider | undefined {
    return this.byId.get(id);
  }

  list(): readonly MediaProvider[] {
    return this.providers;
  }

  /**
   * Records that a provider is failing.
   *
   * The registry does not stop routing to it — a transient outage should not make a
   * platform look permanently unsupported — but `/api/info` reports the degradation so
   * the About page can say "Instagram support is temporarily unavailable" instead of
   * the service simply returning errors.
   */
  markDegraded(id: string, reason: string, forMs = 10 * 60_000): void {
    this.degraded.set(id, { until: Date.now() + forMs, reason });
  }

  markHealthy(id: string): void {
    this.degraded.delete(id);
  }

  statusOf(id: string): ProviderSummary['status'] {
    const entry = this.degraded.get(id);
    if (!entry) return 'ok';
    if (entry.until < Date.now()) {
      this.degraded.delete(id);
      return 'ok';
    }
    return 'degraded';
  }

  /** The public description of what this deployment supports. */
  summarize(): ProviderSummary[] {
    return this.providers
      .filter((provider) => provider.hosts.length > 0)
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        hosts: provider.hosts,
        status: this.statusOf(provider.id),
        capabilities: provider.capabilities,
      }));
  }
}

/** Applies a provider's normalization, falling back to the URL unchanged. */
export function normalizeForProvider(provider: MediaProvider, url: URL): URL {
  if (!provider.normalize) return url;
  try {
    return provider.normalize(url);
  } catch {
    // A normalizer must never be able to break resolution.
    return url;
  }
}
