import type { ProviderCapabilities } from '@sera/contracts/types';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

export class PinterestProvider extends YtdlpProvider {
  readonly id = 'pinterest';
  readonly label = 'Pinterest';
  readonly hosts = ['pinterest.com', 'pin.it', 'pinterest.co.uk', 'pinterest.ca', 'pinterest.de'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    authRequiredFor: ['photo pins — Pinterest asks crawlers not to read its pages'],
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    return out;
  }
}
