import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class TikTokProvider extends YtdlpProvider {
  readonly id = 'tiktok';
  readonly label = 'TikTok';
  readonly hosts = ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'];
  override readonly priority = 20;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
    gif: true,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (!['vm.tiktok.com', 'vt.tiktok.com'].includes(out.hostname.toLowerCase())) {
      out.hostname = 'www.tiktok.com';
    }
    out.pathname = out.pathname.replace(/^\/(@[^/]+)\/photo\/(\d+)/, '/$1/video/$2');
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }
}
