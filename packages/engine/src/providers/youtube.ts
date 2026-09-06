import type { MediaInfoType } from '@sera/contracts/types';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * YouTube, including Shorts, Music and the youtu.be shortener.
 *
 * Every surface is normalized onto `/watch?v=`, which is the form the extractor is most
 * reliable with and which makes the three URLs people paste for the same video resolve
 * to one canonical entry.
 */
export class YouTubeProvider extends YtdlpProvider {
  readonly id = 'youtube';
  readonly label = 'YouTube';
  readonly hosts = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'];
  override readonly priority = 10;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    const host = out.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = out.pathname.split('/').find(Boolean);
      if (id) return this.watchUrl(id, out);
    }

    const segments = out.pathname.split('/').filter(Boolean);
    // /shorts/<id>, /live/<id> and /embed/<id> are the same video as /watch?v=<id>.
    if (segments.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(segments[0]!)) {
      return this.watchUrl(segments[1]!, out);
    }

    out.hostname = 'www.youtube.com';
    out.protocol = 'https:';
    return out;
  }

  private watchUrl(videoId: string, source: URL): URL {
    const out = new URL('https://www.youtube.com/watch');
    out.searchParams.set('v', videoId);
    const list = source.searchParams.get('list');
    if (list) out.searchParams.set('list', list);
    return out;
  }

  /** A list of separate works, unlike the carousels other providers expand. */
  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  /** A bare playlist URL is a list; a video that merely sits in one is still one video. */
  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.startsWith('/playlist') && url.searchParams.has('list');
  }

  protected override extractorArgs(): readonly string[] {
    // The web client alone stopped returning full format lists reliably; asking for the
    // additional clients is what keeps 1080p and the audio-only renditions visible.
    return ['youtube:player_client=default,web_safari'];
  }
}
