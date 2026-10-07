import type { MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { hostMatches } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class BandcampProvider extends YtdlpProvider {
  readonly id = 'bandcamp';
  readonly label = 'Bandcamp';
  readonly hosts = ['bandcamp.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    video: false,
    audio: true,
    gallery: true,
  });

  override canHandle(_url: URL, host: string): boolean {
    return hostMatches(host, 'bandcamp.com');
  }

  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.startsWith('/album/');
  }
}
