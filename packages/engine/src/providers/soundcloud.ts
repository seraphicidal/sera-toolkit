import type { MediaInfoType } from '@sera/contracts/types';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * SoundCloud tracks and sets.
 *
 * A `/sets/` URL is an album or playlist and is expanded into its tracks; a plain track
 * URL is one item. SoundCloud publishes audio only, so the base class produces just the
 * audio option list — no empty "video" group appears in the UI.
 */
export class SoundCloudProvider extends YtdlpProvider {
  readonly id = 'soundcloud';
  readonly label = 'SoundCloud';
  readonly hosts = ['soundcloud.com', 'snd.sc', 'm.soundcloud.com', 'on.soundcloud.com'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    const host = out.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'm.soundcloud.com') out.hostname = 'soundcloud.com';
    return out;
  }

  /** A list of separate works, unlike the carousels other providers expand. */
  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.includes('/sets/');
  }
}
