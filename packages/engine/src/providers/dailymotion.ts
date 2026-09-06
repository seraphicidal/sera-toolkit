import { YtdlpProvider } from './ytdlp-base.js';

/** Dailymotion videos, including the `dai.ly` shortener. */
export class DailymotionProvider extends YtdlpProvider {
  readonly id = 'dailymotion';
  readonly label = 'Dailymotion';
  readonly hosts = ['dailymotion.com', 'dai.ly'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (out.hostname.toLowerCase() === 'dai.ly') {
      const id = out.pathname.split('/').find(Boolean);
      if (id) return new URL(`https://www.dailymotion.com/video/${id}`);
    }
    return out;
  }
}
