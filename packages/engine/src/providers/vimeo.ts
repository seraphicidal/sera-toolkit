import { YtdlpProvider } from './ytdlp-base.js';

/** Vimeo videos, including the `player.vimeo.com` embed form. */
export class VimeoProvider extends YtdlpProvider {
  readonly id = 'vimeo';
  readonly label = 'Vimeo';
  readonly hosts = ['vimeo.com', 'player.vimeo.com'];
  override readonly priority = 30;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    // An embed URL carries the same video id as the canonical page.
    const embed = /^\/video\/(\d+)/.exec(out.pathname);
    if (out.hostname.toLowerCase() === 'player.vimeo.com' && embed?.[1]) {
      return new URL(`https://vimeo.com/${embed[1]}`);
    }
    return out;
  }
}
