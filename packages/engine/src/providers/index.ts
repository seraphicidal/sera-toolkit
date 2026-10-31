import type { ProviderSummary } from '@sera/contracts/types';
import type { EngineConfig } from '../config.js';
import { BandcampProvider } from './bandcamp.js';
import { BlueskyProvider } from './bluesky.js';
import { DropboxProvider, GoogleDriveProvider, MediaFireProvider, MegaProvider } from './cloud.js';
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
export {
  DropboxProvider,
  GoogleDriveProvider,
  MediaFireProvider,
  MegaProvider,
  extractGoogleDriveId,
  extractGoogleDriveConfirmUrl,
  extractMediaFireDirectUrl,
} from './cloud.js';

function filterProviders(
  providers: readonly MediaProvider[],
  config?: EngineConfig,
): MediaProvider[] {
  if (!config) return [...providers];
  const enabled = config.enabledProviders;
  const disabled = config.disabledProviders;
  return providers.filter((provider) => {
    const id = provider.id.toLowerCase();
    if (enabled.length > 0 && !enabled.includes(id)) {
      return false;
    }
    if (disabled.length > 0 && disabled.includes(id)) {
      return false;
    }
    return true;
  });
}

export function createProviders(config?: EngineConfig): MediaProvider[] {
  const all: MediaProvider[] = [
    new YouTubeProvider(),
    new TwitterProvider(),
    new TikTokProvider(),
    new InstagramProvider(config),
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
    new GoogleDriveProvider(),
    new DropboxProvider(),
    new MediaFireProvider(),
    new MegaProvider(),
    new DirectFileProvider(),
    new GenericProvider(),
  ];
  return filterProviders(all, config).sort((a, b) => a.priority - b.priority);
}

export class ProviderRegistry {
  private readonly providers: readonly MediaProvider[];
  private readonly byId: ReadonlyMap<string, MediaProvider>;
  private readonly degraded = new Map<string, { until: number; reason: string }>();

  constructor(providers?: readonly MediaProvider[], config?: EngineConfig) {
    const raw = providers ?? createProviders(config);
    this.providers = filterProviders(raw, config).sort((a, b) => a.priority - b.priority);
    this.byId = new Map(this.providers.map((p) => [p.id, p]));
  }

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

export function normalizeForProvider(provider: MediaProvider, url: URL): URL {
  if (!provider.normalize) return url;
  try {
    return provider.normalize(url);
  } catch {
    return url;
  }
}
