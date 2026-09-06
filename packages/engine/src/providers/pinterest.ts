import { YtdlpProvider } from './ytdlp-base.js';

/** Pinterest pins, which may be a still image or a video. */
export class PinterestProvider extends YtdlpProvider {
  readonly id = 'pinterest';
  readonly label = 'Pinterest';
  readonly hosts = ['pinterest.com', 'pin.it', 'pinterest.co.uk', 'pinterest.ca', 'pinterest.de'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    return out;
  }
}
