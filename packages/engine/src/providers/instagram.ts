import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Instagram posts, reels and carousels.
 *
 * Playlist expansion is on so a carousel resolves to every slide rather than the first.
 * Nothing here attempts to reach private accounts or stories that require a session —
 * those simply fail with `PRIVATE_CONTENT`, which is the correct outcome.
 */
export class InstagramProvider extends YtdlpProvider {
  readonly id = 'instagram';
  readonly label = 'Instagram';
  readonly hosts = ['instagram.com', 'instagr.am', 'ddinstagram.com'];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.hostname = 'www.instagram.com';
    out.protocol = 'https:';
    // Instagram serves the same post at /p/, /reel/ and /tv/; the extractor accepts all
    // three, and keeping the original avoids guessing wrong about which one exists.
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
