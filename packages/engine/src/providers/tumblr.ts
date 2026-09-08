import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { hostMatches } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Tumblr posts.
 *
 * Blogs live on both `tumblr.com/<blog>/<id>` and `<blog>.tumblr.com/post/<id>`, and a
 * photoset is a multi-image post, so playlist expansion is on.
 */
export class TumblrProvider extends YtdlpProvider {
  readonly id = 'tumblr';
  readonly label = 'Tumblr';
  readonly hosts = ['tumblr.com'];
  override readonly priority = 30;

  // Video only, measured rather than assumed. The extractor answers "No video could be
  // found in this post" for a photoset; the page it would otherwise be read from is a
  // script shell with no `og:image`; the old `/api/read/json` endpoint is gone (404);
  // and `www.tumblr.com/<blog>/<id>` is disallowed by Tumblr's robots.txt, which SERA
  // honours. Photosets would need an API key from a registered application, which this
  // installation does not have and does not ask visitors for.
  override readonly capabilities: ProviderCapabilities = declare({
    authRequiredFor: ['photo posts'],
  });

  override canHandle(_url: URL, host: string): boolean {
    return hostMatches(host, 'tumblr.com');
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
