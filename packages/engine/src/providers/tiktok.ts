import { YtdlpProvider } from './ytdlp-base.js';

/**
 * TikTok: videos, photo posts and slideshows.
 *
 * Photo posts arrive as a playlist of image entries, which the base class already turns
 * into a multi-item collection — the same code path Instagram carousels use. Playlist
 * expansion is therefore on, otherwise a slideshow would resolve to its first image.
 */
export class TikTokProvider extends YtdlpProvider {
  readonly id = 'tiktok';
  readonly label = 'TikTok';
  readonly hosts = ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    // Short-link hosts redirect to the canonical post; the extractor follows them.
    if (!['vm.tiktok.com', 'vt.tiktok.com'].includes(out.hostname.toLowerCase())) {
      out.hostname = 'www.tiktok.com';
    }
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }
}
