import type { MediaInfoType } from '@sera/contracts/types';
import { SeraError, seraError } from '../errors.js';
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
    const args = [
      // The web client alone stopped returning full format lists reliably; asking for
      // the additional clients is what keeps 1080p and the audio-only renditions
      // visible. `tv` needs no PO token, which is why it leads.
      'youtube:player_client=tv,default,web_safari',
    ];

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
      const media = await super.resolve(url, context);
      context.logger.info(
        {
          provider: this.id,
          extractionBackend: 'direct',
          playerClient: 'tv,default,web_safari',
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
      const backend = context.config.youtube;

      // Only the address block is worth a second backend. A private video is private
      // from every connection, and retrying it elsewhere just wastes someone's time.
      if (failure.code !== 'SOURCE_BLOCKED' || !backend.fallbackUrl) {
        context.logger.info(
          {
            provider: this.id,
            extractionBackend: 'direct',
            poTokenStatus: potStatus,
            fallbackUsed: false,
            failureClass: failure.code,
            detail: failure.detail,
            durationMs: Date.now() - started,
          },
          'youtube extraction failed',
        );
        throw failure;
      }

      return this.viaResidential(url, context, failure, potStatus, started);
    }
  }

  /**
   * Hands the URL to an authorized extraction backend on a residential connection.
   *
   * The backend answers with the same resolved shape this provider would have produced,
   * so nothing downstream knows or cares which one ran. The shared secret goes in a
   * header and is never logged.
   */
  private async viaResidential(
    url: URL,
    context: ProviderContext,
    blocked: SeraError,
    potStatus: string,
    started: number,
  ): Promise<ResolvedMedia> {
    const { fallbackUrl, fallbackToken } = context.config.youtube;
    const healthy = await backendIsHealthy(fallbackUrl, fallbackToken);
    if (!healthy) {
      context.logger.warn(
        {
          provider: this.id,
          extractionBackend: 'residential',
          fallbackUsed: false,
          failureClass: 'BACKEND_UNHEALTHY',
          durationMs: Date.now() - started,
        },
        'youtube fallback backend is not answering',
      );
      throw blocked;
    }

    let media: ResolvedMedia;
    try {
      const response = await fetch(`${fallbackUrl}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(fallbackToken ? { authorization: `Bearer ${fallbackToken}` } : {}),
        },
        body: JSON.stringify({ url: url.toString() }),
        signal: AbortSignal.timeout(context.config.resolveTimeoutMsFor(this.id)),
      });
      if (!response.ok) {
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: `youtube: fallback backend returned ${response.status}`,
        });
      }
      media = (await response.json()) as ResolvedMedia;
      if (!Array.isArray(media.items) || !media.items.length) {
        throw seraError('MEDIA_UNAVAILABLE', { detail: 'youtube: fallback returned no items' });
      }
    } catch (error) {
      context.logger.warn(
        {
          provider: this.id,
          extractionBackend: 'residential',
          fallbackUsed: true,
          failureClass: SeraError.from(error).code,
          durationMs: Date.now() - started,
        },
        'youtube fallback backend failed',
      );
      // The original block is the more useful answer: the fallback is an implementation
      // detail of this server, not something the visitor asked for.
      throw blocked;
    }

    context.logger.info(
      {
        provider: this.id,
        extractionBackend: 'residential',
        poTokenStatus: potStatus,
        fallbackUsed: true,
        durationMs: Date.now() - started,
        items: media.items.length,
      },
      'youtube extraction succeeded through the fallback backend',
    );

    return {
      ...media,
      provider: this.id,
      providerLabel: this.label,
      metadata: {
        ...media.metadata,
        extractionBackend: 'residential',
        poTokenStatus: potStatus,
        fallbackUsed: 'true',
      },
    };
  }
}

/** A backend that does not answer its health endpoint is not chosen. */
async function backendIsHealthy(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
