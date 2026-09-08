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
  // Pins that are photographs are not available here, and the reason is Pinterest's:
  // its robots.txt is `User-agent: * / Disallow: /`, so the page reader that would
  // otherwise find the image declines, and the extractor is video-only ("No video
  // formats found!"). Declining to read a site that asks not to be read is the
  // behaviour, not a gap in it.
  override readonly capabilities: ProviderCapabilities = declare({
    authRequiredFor: ['photo pins — Pinterest asks crawlers not to read its pages'],
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    return out;
  }
}
