import type { MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

export class SoundCloudProvider extends YtdlpProvider {
  readonly id = 'soundcloud';
  readonly label = 'SoundCloud';
  readonly hosts = ['soundcloud.com', 'snd.sc', 'm.soundcloud.com', 'on.soundcloud.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    video: false,
    audio: true,
    gallery: true,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    const host = out.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'm.soundcloud.com') out.hostname = 'soundcloud.com';
    return out;
  }

  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.includes('/sets/');
  }
}
