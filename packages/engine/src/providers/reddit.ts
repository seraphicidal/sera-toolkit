import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Reddit posts: hosted video, images, GIFs and gallery posts.
 *
 * Gallery posts are the reason playlist expansion is on. Reddit's own video hosting
 * splits audio into a separate DASH stream, which the base class already handles by
 * merging — that is why a v.redd.it download comes back with sound rather than silent,
 * which is the single most common complaint about tools that skip the merge step.
 */
export class RedditProvider extends YtdlpProvider {
  readonly id = 'reddit';
  readonly label = 'Reddit';
  readonly hosts = ['reddit.com', 'redd.it', 'v.redd.it', 'i.redd.it', 'old.reddit.com'];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    const host = out.hostname.toLowerCase().replace(/^www\./, '');
    // Media subdomains are left alone; only the site itself is canonicalized, because
    // old.reddit.com and www.reddit.com serve the same post through one extractor.
    if (host === 'reddit.com' || host === 'old.reddit.com') out.hostname = 'www.reddit.com';
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }
}
