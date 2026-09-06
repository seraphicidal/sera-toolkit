import { hostMatchesAny } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Mastodon and other fediverse servers.
 *
 * The fediverse has no canonical host list — anyone can run an instance — so detection
 * is by URL shape plus the largest well-known servers. `/@user/<numeric id>` and
 * `/users/<name>/statuses/<id>` are the two status forms every Mastodon-compatible
 * server serves, and matching on them keeps the provider from claiming unrelated sites.
 */
export class MastodonProvider extends YtdlpProvider {
  readonly id = 'mastodon';
  readonly label = 'Mastodon';
  readonly hosts = [
    'mastodon.social',
    'mastodon.online',
    'mstdn.social',
    'fosstodon.org',
    'hachyderm.io',
    'infosec.exchange',
    'techhub.social',
    'mas.to',
  ];
  override readonly priority = 40;

  /** `/@name/123456` or `/users/name/statuses/123456`. */
  private static readonly STATUS_PATH = /^\/(@[^/]+\/\d+|users\/[^/]+\/statuses\/\d+)\/?$/;

  override canHandle(url: URL, host: string): boolean {
    if (hostMatchesAny(host, this.hosts)) return true;
    // An unknown host is claimed only when the path is unmistakably a fediverse status.
    return MastodonProvider.STATUS_PATH.test(url.pathname);
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
