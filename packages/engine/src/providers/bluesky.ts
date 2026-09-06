import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Bluesky posts.
 *
 * A post URL is `/profile/<handle>/post/<rkey>`. Posts may carry several images, so
 * expansion is on and each attachment becomes its own selectable item.
 */
export class BlueskyProvider extends YtdlpProvider {
  readonly id = 'bluesky';
  readonly label = 'Bluesky';
  readonly hosts = ['bsky.app', 'bsky.social'];
  override readonly priority = 30;

  override canHandle(url: URL, host: string): boolean {
    return super.canHandle(url, host) && url.pathname.includes('/post/');
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
