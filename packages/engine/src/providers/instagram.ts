import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import type { EngineConfig } from '../config.js';
import { SeraError, seraError } from '../errors.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import {
  coverItemFrom,
  itemsFrom,
  mediaIdFor,
  oembedFor,
  sessionHeaders,
  shortcodeFrom,
  titleFor,
  type InstagramNode,
} from './instagram-media.js';
import { nonEmpty } from '../util/format.js';
import type { ProviderContext, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Instagram posts, reels and carousels.
 *
 * Playlist expansion is on so a carousel resolves to every slide rather than the first.
 * Nothing here attempts to reach private accounts or stories that require a session —
 * those simply fail with `PRIVATE_CONTENT`, which is the correct outcome.
 *
 * Reels and video posts resolve anonymously and work from this deployment. Photographs
 * do not, and the reason is not the extractor: measured against a real public post, the
 * post page returns a shell, `?__a=1` is a 404, `/api/v1/media/…/info/` redirects to a
 * login, and the GraphQL endpoint answers `require_login: true`. Instagram's own embed
 * endpoint no longer carries the media either. There is no supported third-party API
 * that returns an arbitrary public post's media — Basic Display and the Graph API only
 * reach accounts you own, and oEmbed returns a thumbnail and a blockquote.
 *
 * So a photo post gets a straight answer about what would be required, instead of an
 * extractor message about video that describes nothing the visitor did.
 */
export class InstagramProvider extends YtdlpProvider {
  readonly id = 'instagram';
  readonly label = 'Instagram';
  readonly hosts = ['instagram.com', 'instagr.am', 'ddinstagram.com'];
  override readonly priority = 20;

  /**
   * Reels and video posts resolve anonymously and work everywhere.
   *
   * Photographs do not, and no extraction node fixes it: every anonymous endpoint
   * Instagram still serves redirects to a login or answers `require_login`, from a
   * residential address as much as from a datacentre. They work only when the operator
   * has configured a session for their own server, so the capability says which half is
   * available on this installation rather than promising both.
   */
  override readonly capabilities: ProviderCapabilities;

  constructor(config?: EngineConfig) {
    super();
    const withSession = config?.instagram.configured === true;
    this.capabilities = declare({
      image: withSession,
      carousel: withSession,
      // The operator may configure a session of their own. Whether one is set is the
      // line above; this says the mechanism exists.
      authenticatedMode: true,
      // And the route that needs no session on this side at all: the visitor's own browser,
      // signed in already, reads the post and sends it. Available whether or not one is set.
      browserImport: true,
      ...(withSession ? {} : { authRequiredFor: ['photo posts', 'carousels'] }),
    });
  }

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

  /**
   * Reads a post through Instagram's own web API.
   *
   * Only reached when a session is configured. The session goes into a request header
   * and nowhere else: not into a log line, not into an error detail, and not into
   * anything a client can see.
   */
  private async viaSession(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const shortcode = shortcodeFrom(url);
    if (!shortcode) throw seraError('UNSUPPORTED_SOURCE', { detail: 'instagram: no shortcode' });

    const mediaId = await mediaIdFor(shortcode, (endpoint, maxBytes) =>
      context.fetchText(endpoint, maxBytes),
    );

    const endpoint = new URL(`https://www.instagram.com/api/v1/media/${mediaId}/info/`);
    const { body } = await context.fetchText(endpoint, 4 * 1024 * 1024, {
      headers: sessionHeaders(context.config.instagram.sessionId),
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

  /**
   * The cover image Instagram publishes for anyone embedding the post.
   *
   * Last, and marked degraded, because it is not the post: a carousel's cover is its
   * first slide and a Reel's is a frame. It runs only once every backend — including an
   * extraction node, if one is connected — has already refused, so it can never take the
   * place of the real thing.
   */
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
        // The extractor reports a photo post as an unsupported source, because it only
        // understands video. That — and a login wall — are what a session answers.
        answers: ['UNSUPPORTED_MEDIA', 'LOGIN_REQUIRED', 'AUTH_CONFIGURATION_ERROR'],
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
      // "No video in this post" means the extractor read the post and found photographs,
      // and every anonymous endpoint that could return those now needs a session. Said
      // plainly, because an extractor message about video describes nothing the visitor
      // did — and because the alternative here is a real requirement, not a bug.
      if (failure.code !== 'UNSUPPORTED_SOURCE') throw failure;
      throw seraError('PROVIDER_AUTH_REQUIRED', {
        message: 'Instagram photo posts need an account, and this server does not have one.',
        hint: 'Reels and video posts work. A photo post can still be sent to SERA from your own browser, where you are already signed in to Instagram.',
        detail: failure.detail ?? 'instagram: no video in post',
      });
    }
  }
}
