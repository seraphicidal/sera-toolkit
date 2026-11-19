import { seraError } from '../errors.js';
import { stripWww } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';
import type { ProviderContext, ResolvedMedia } from './types.js';

export class TwitchProvider extends YtdlpProvider {
  readonly id = 'twitch';
  readonly label = 'Twitch';
  readonly hosts = ['twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (stripWww(out.hostname.toLowerCase()) === 'm.twitch.tv') {
      out.hostname = 'www.twitch.tv';
    }
    return out;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const segments = url.pathname.split('/').filter(Boolean);
    const clipIndex = segments.indexOf('clip');
    const isClip =
      (stripWww(url.hostname.toLowerCase()) === 'clips.twitch.tv' && segments.length >= 1) ||
      (clipIndex >= 0 && Boolean(segments[clipIndex + 1]));
    const isVod = segments[0] === 'videos' && Boolean(segments[1]);

    if (!isClip && !isVod) {
      throw seraError('LIVE_IN_PROGRESS', {
        message: 'Only Twitch clips and past broadcasts can be downloaded.',
        hint: 'Use a link to a clip or a VOD rather than a channel.',
        detail: `twitch: ${segments.length} path segments, neither clip nor vod`,
      });
    }
    return super.resolve(url, context);
  }
}
