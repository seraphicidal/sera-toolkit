import type { MediaInfoType } from '@sera/contracts/types';
import { hostMatches } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Bandcamp tracks and albums.
 *
 * Every artist gets their own `*.bandcamp.com` subdomain, so host matching is by suffix
 * rather than by an enumerated list, and `/album/` URLs expand into their tracks.
 */
export class BandcampProvider extends YtdlpProvider {
  readonly id = 'bandcamp';
  readonly label = 'Bandcamp';
  readonly hosts = ['bandcamp.com'];
  override readonly priority = 30;

  override canHandle(_url: URL, host: string): boolean {
    return hostMatches(host, 'bandcamp.com');
  }

  /** A list of separate works, unlike the carousels other providers expand. */
  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.startsWith('/album/');
  }
}
