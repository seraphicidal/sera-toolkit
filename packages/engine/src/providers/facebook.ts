import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Facebook videos, reels and watch pages.
 *
 * Only publicly visible posts resolve. Anything behind a login fails as
 * `PRIVATE_CONTENT`, which is the intended behaviour rather than a gap to work around.
 */
export class FacebookProvider extends YtdlpProvider {
  readonly id = 'facebook';
  readonly label = 'Facebook';
  readonly hosts = ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com', 'web.facebook.com'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    const host = out.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'm.facebook.com' || host === 'web.facebook.com' || host === 'facebook.com') {
      out.hostname = 'www.facebook.com';
    }
    return out;
  }
}
