import type { MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { ensureRecommendations } from '../normalize/plans.js';
import { SeraError } from '../errors.js';
import { classifyFailure } from '../extract/failure.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import type { ProviderContext, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

export class YouTubeProvider extends YtdlpProvider {
  readonly id = 'youtube';
  readonly label = 'YouTube';
  readonly hosts = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'];
  override readonly priority = 10;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    gallery: true,
    cloudExtraction: false,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    const host = out.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = out.pathname.split('/').find(Boolean);
      if (id) return this.watchUrl(id, out);
    }

    const segments = out.pathname.split('/').filter(Boolean);
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

  protected override multiItemType(url: URL): MediaInfoType {
    return this.wantsPlaylist(url) ? 'playlist' : 'collection';
  }

  protected override wantsPlaylist(url: URL): boolean {
    return url.pathname.startsWith('/playlist') && url.searchParams.has('list');
  }

  protected override strategies(
    _url: URL,
    context: ProviderContext,
  ): readonly ExtractionStrategy[] {
    const configured = context.config.youtube.playerClients;
    const ladder: ExtractionStrategy[] = [
      {
        id: 'ytdlp',
        label: configured ? `the extractor (${configured})` : 'the extractor',
        run: (target, ctx) => this.runExtractor(target, ctx),
      },
    ];

    for (const client of ALTERNATE_CLIENTS) {
      if (configured === client) continue;
      ladder.push({
        id: `ytdlp:${client}`,
        label: `the extractor, asking as ${client}`,
        answers: ['FORMAT_UNAVAILABLE', 'PO_TOKEN_REQUIRED'],
        run: (target, ctx) =>
          this.runExtractor(target, { ...ctx, config: withPlayerClient(ctx.config, client) }),
      });
    }
    return ladder;
  }

  protected override extractorArgs(_url: URL, context: ProviderContext): readonly string[] {
    const args: string[] = [];

    const clients = context.config.youtube.playerClients;
    if (clients) args.push(`youtube:player_client=${clients}`);

    const provider = context.config.youtube.potProviderUrl;
    if (provider) {
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
          extractionPath: 'direct',
          poTokenStatus: potStatus,
        },
      };
    } catch (error) {
      const failure = SeraError.from(error);
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

const ALTERNATE_CLIENTS = ['web_safari', 'android'] as const;

function withPlayerClient(
  config: ProviderContext['config'],
  playerClients: string,
): ProviderContext['config'] {
  return { ...config, youtube: { ...config.youtube, playerClients } };
}

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
