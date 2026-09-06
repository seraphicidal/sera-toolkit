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

  override canHandle(_url: URL, host: string): boolean {
    return hostMatches(host, 'tumblr.com');
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
