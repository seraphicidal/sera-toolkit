import type { ProviderCapabilities } from '@sera/contracts/types';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

/** Pinterest pins, which may be a still image or a video. */
export class PinterestProvider extends YtdlpProvider {
  readonly id = 'pinterest';
  readonly label = 'Pinterest';
  readonly hosts = ['pinterest.com', 'pin.it', 'pinterest.co.uk', 'pinterest.ca', 'pinterest.de'];
  override readonly priority = 30;

  /**
   * Pins are usually photographs, occasionally video.
   */
  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    gif: true,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    return out;
  }
}
