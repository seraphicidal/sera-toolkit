import { seraError } from '../errors.js';
import { YtdlpProvider } from './ytdlp-base.js';
import type { ProviderContext, ResolvedMedia } from './types.js';

/**
 * Twitch clips and past broadcasts.
 *
 * A channel URL points at whatever is streaming right now, which has no end and so no
 * downloadable file. Refusing it up front with a clear message is better than starting a
 * job that would run until it hit the timeout.
 */
export class TwitchProvider extends YtdlpProvider {
  readonly id = 'twitch';
  readonly label = 'Twitch';
  readonly hosts = ['twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (out.hostname.toLowerCase().replace(/^www\./, '') === 'm.twitch.tv') {
      out.hostname = 'www.twitch.tv';
    }
    return out;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const segments = url.pathname.split('/').filter(Boolean);
    const isClip = url.hostname.startsWith('clips.') || segments.includes('clip');
    const isVod = segments[0] === 'videos';

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
