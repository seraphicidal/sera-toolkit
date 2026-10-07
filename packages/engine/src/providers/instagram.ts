import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import type { EngineConfig } from '../config.js';
import { SeraError, seraError } from '../errors.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import {
  coverItemFrom,
  itemsFrom,
  mediaIdFromShortcode,
  oembedFor,
  sessionHeaders,
  shortcodeFrom,
  titleFor,
  type InstagramNode,
} from './instagram-media.js';
import { nonEmpty } from '../util/format.js';
import type { ProviderContext, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class InstagramProvider extends YtdlpProvider {
  readonly id = 'instagram';
  readonly label = 'Instagram';
  readonly hosts = ['instagram.com', 'instagr.am', 'ddinstagram.com'];
  override readonly priority = 20;

  override readonly capabilities: ProviderCapabilities;

  readonly nodeSession = 'instagram-session' as const;
  readonly withNodeSession: Partial<ProviderCapabilities> = { image: true, carousel: true };

  constructor(config?: EngineConfig) {
    super();
    const withSession = config?.instagram.configured === true;
    this.capabilities = declare({
      image: withSession,
      carousel: withSession,
      authenticatedMode: true,
      browserImport: true,
      ...(withSession ? {} : { authRequiredFor: ['photo posts', 'carousels'] }),
    });
  }

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.hostname = 'www.instagram.com';
    out.protocol = 'https:';
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  private async viaSession(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const shortcode = shortcodeFrom(url);
    if (!shortcode) throw seraError('UNSUPPORTED_SOURCE', { detail: 'instagram: no shortcode' });

    const mediaId = mediaIdFromShortcode(shortcode);

    const endpoint = new URL(`https://www.instagram.com/api/v1/media/${mediaId}/info/`);
    const { body } = await context.fetchText(endpoint, 4 * 1024 * 1024, {
      headers: sessionHeaders(context.config.instagram.sessionId),
      keepCookies: true,
    });

    const node = (JSON.parse(body) as { items?: readonly InstagramNode[] }).items?.[0];
    if (!node) throw seraError('MEDIA_UNAVAILABLE', { detail: 'instagram: no media in response' });

    const items = itemsFrom(node, context.config.maxItemsPerJob);
    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'instagram: post had no usable media' });
    }

    const { title, author } = titleFor(node);
    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: items.length > 1 ? 'collection' : 'single',
      title,
      ...(author ? { author } : {}),
      ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
      items,
      metadata: { items: String(items.length), source: 'web-api' },
    };
  }

  private async viaOembed(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const oembed = await oembedFor(url, (endpoint, maxBytes) =>
      context.fetchText(endpoint, maxBytes),
    );
    const item = coverItemFrom(oembed);
    if (!item) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'instagram: oembed carried no thumbnail' });
    }

    const author = oembed.author_name;
    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: 'single',
      title: nonEmpty(oembed.title) ?? `Post by ${author ?? 'an Instagram account'}`,
      ...(author ? { author } : {}),
      ...(oembed.author_url ? { authorUrl: oembed.author_url } : {}),
      thumbnailUrl: item.thumbnailUrl!,
      items: [item],
      metadata: { source: 'oembed', degraded: 'cover-image' },
    };
  }

  protected override strategies(
    _url: URL,
    _context: ProviderContext,
  ): readonly ExtractionStrategy[] {
    return [
      {
        id: 'ytdlp',
        label: 'the extractor',
        run: (target, ctx) => this.runExtractor(target, ctx),
      },
      {
        id: 'web-api',
        label: "Instagram's web API, with the operator's session",
        available: (ctx) => ctx.config.instagram.configured,
        answers: [
          'UNSUPPORTED_MEDIA',
          'FORMAT_UNAVAILABLE',
          'LOGIN_REQUIRED',
          'AUTH_CONFIGURATION_ERROR',
        ],
        run: (target, ctx) => this.viaSession(target, ctx),
      },
      {
        id: 'oembed',
        label: 'the cover image Instagram publishes for embeds',
        degraded: true,
        run: (target, ctx) => this.viaOembed(target, ctx),
      },
    ];
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    try {
      return await super.resolve(url, context);
    } catch (error) {
      const failure = SeraError.from(error);
      if (failure.code !== 'UNSUPPORTED_SOURCE') throw failure;
      throw seraError('PROVIDER_AUTH_REQUIRED', {
        message: 'Instagram photo posts need an account, and this server does not have one.',
        hint: 'Reels and video posts work. A photo post can still be sent to SERA from your own browser, where you are already signed in to Instagram.',
        detail: failure.detail ?? 'instagram: no video in post',
      });
    }
  }
}
