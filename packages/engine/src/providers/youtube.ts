import type { MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { ensureRecommendations } from '../normalize/plans.js';
import { SeraError } from '../errors.js';
import { classifyFailure } from '../extract/failure.js';
import type { ProviderContext, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * YouTube, including Shorts, Music and the youtu.be shortener.
 *
 * Extraction runs through named backends rather than one implicit path, because on a
 * cloud host there is more than one thing that can be true at once.
 *
 * `direct` is this worker, configured the way yt-dlp currently recommends: the player
 * clients that still return full format lists, and — when one is configured — a PO Token
 * Provider, which is the architecture yt-dlp's own PO-Token-Guide describes.
 *
 * `residential` is an authorized extraction backend on a connection YouTube does not
 * challenge. It is used only when `direct` reports the datacentre block, it is never
 * silent, and with nothing configured there simply is no fallback and the block is
 * reported as what it is.
 *
 * What was measured on this deployment, so the next person does not repeat it: the PO
 * Token Provider loads and is offered to the extractor, and YouTube still answers
 * `LOGIN_REQUIRED` / "Sign in to confirm you're not a bot" on the *player* request,
 * before streaming, for every player client. PO tokens address 403s on the stream, not
 * address reputation. Keeping the supported architecture is still right; expecting it to
 * lift an IP block is not.
 */
export class YouTubeProvider extends YtdlpProvider {
  readonly id = 'youtube';
  readonly label = 'YouTube';
  readonly hosts = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'];
  override readonly priority = 10;

  /**
   * Thumbnails are the image half. A video's cover art is a real image people want, and
   * it is already resolved as part of every extraction — offering it costs one more
   * option rather than a second round trip.
   */
  override readonly capabilities: ProviderCapabilities = {
    video: true,
    image: true,
    carousel: false,
    audioExtraction: true,
    gif: false,
  };

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

  protected override extractorArgs(_url: URL, context: ProviderContext): readonly string[] {
    const args: string[] = [];

    // Nothing by default, because an audit of every client the extractor offers found
    // none that beats letting it choose — and one, `tv`, that errors outright. The
    // previous hardcoded `tv,default,web_safari` produced exactly the same 53 formats
    // as no override at all, so it was carrying a claim it could no longer support.
    // See SERA_YOUTUBE_PLAYER_CLIENTS for the measurements.
    const clients = context.config.youtube.playerClients;
    if (clients) args.push(`youtube:player_client=${clients}`);

    const provider = context.config.youtube.potProviderUrl;
    if (provider) {
      // The address of the provider, never a token. Tokens are fetched by the plugin
      // inside yt-dlp and never pass through this process or any log line.
      args.push(`youtubepot-bgutilhttp:base_url=${provider}`);
    }
    return args;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const started = Date.now();
    const potStatus = context.config.youtube.potProviderUrl ? 'configured' : 'not-configured';

    try {
      const media = withThumbnailOption(await super.resolve(url, context));
      context.logger.info(
        {
          provider: this.id,
          extractionBackend: 'direct',
          playerClient: context.config.youtube.playerClients || 'extractor default',
          poTokenStatus: potStatus,
          fallbackUsed: false,
          durationMs: Date.now() - started,
          items: media.items.length,
        },
        'youtube extraction succeeded',
      );
      return {
        ...media,
        metadata: {
          ...media.metadata,
          extractionBackend: 'direct',
          poTokenStatus: potStatus,
          fallbackUsed: 'false',
        },
      };
    } catch (error) {
      const failure = SeraError.from(error);
      // Whether anywhere else is worth trying is the router's decision, not this
      // provider's: the router is the only thing that knows which backends exist and
      // which failures a different network could actually fix.
      context.logger.info(
        {
          provider: this.id,
          extractionBackend: 'direct',
          poTokenStatus: potStatus,
          failureClass: classifyFailure(failure),
          errorCode: failure.code,
          detail: failure.detail,
          durationMs: Date.now() - started,
        },
        'youtube extraction failed',
      );
      throw failure;
    }
  }
}

/**
 * Offers each item's cover image alongside its video.
 *
 * The extraction already found it, so this is one more option on an item rather than a
 * second item — the picker groups by kind, so an Image tab appears next to Video and
 * Audio and nothing about ordering or counts changes. The container comes from the URL
 * here, and the download path corrects it from the bytes if YouTube served something
 * else, which it does: the same image is JPEG on one host and WebP on another.
 */
function withThumbnailOption(media: ResolvedMedia): ResolvedMedia {
  return {
    ...media,
    items: media.items.map((item) => {
      const thumbnail = item.thumbnailUrl;
      if (!thumbnail || item.kind !== 'video') return item;
      const extension = /.(jpg|jpeg|png|webp)(?:[?#]|$)/i.exec(thumbnail)?.[1]?.toLowerCase();
      const container = extension === 'jpeg' ? 'jpg' : ((extension ?? 'jpg') as 'jpg');

      return {
        ...item,
        plans: ensureRecommendations([
          ...item.plans,
          {
            kind: 'image' as const,
            container,
            label: 'Thumbnail',
            detail: `${container.toUpperCase()} · cover image`,
            requiresConversion: false,
            recommended: false,
            fetch: { via: 'direct' as const, url: thumbnail },
          },
        ]),
      };
    }),
  };
}
