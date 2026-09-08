import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
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

  // Deliberately the plain default. Threads carries Instagram's attachment model, and
  // Instagram photographs need a session from any network; no public Threads post could
  // be reached in testing to show otherwise. Claiming images here on the strength of the
  // resemblance would be a promise nobody measured.
  override readonly capabilities: ProviderCapabilities = declare();

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
