import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Threads posts.
 *
 * Threads posts carry the same multi-attachment model as Instagram, so expansion is on
 * and a post with four images resolves to four selectable items.
 */
export class ThreadsProvider extends YtdlpProvider {
  readonly id = 'threads';
  readonly label = 'Threads';
  readonly hosts = ['threads.net', 'threads.com'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    out.hostname = 'www.threads.net';
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
