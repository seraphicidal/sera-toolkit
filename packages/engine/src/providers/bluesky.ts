import type { ContainerFormat, ProviderCapabilities } from '@sera/contracts/types';
import { SeraError, seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { normalizeContainer } from './direct.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

/**
 * Bluesky posts.
 *
 * A post URL is `/profile/<handle-or-did>/post/<rkey>`.
 *
 * Video posts go through yt-dlp, which gives several renditions. Photo posts do not:
 * yt-dlp's Bluesky extractor answers "No video could be found in this post", and a post
 * carrying four photographs is a perfectly ordinary thing to want. The page's own
 * `og:image` tags list them, but only at thumbnail size, so those are read from the
 * AppView API instead — the same public, unauthenticated endpoint the Bluesky web client
 * uses for public posts. Each image becomes its own selectable item.
 */
export class BlueskyProvider extends YtdlpProvider {
  readonly id = 'bluesky';
  readonly label = 'Bluesky';
  readonly hosts = ['bsky.app', 'bsky.social'];
  override readonly priority = 30;

  /**
   * Photographs through the AppView API, video through the extractor.
   */
  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
  });

  override canHandle(url: URL, host: string): boolean {
    return super.canHandle(url, host) && url.pathname.includes('/post/');
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    try {
      return await super.resolve(url, context);
    } catch (error) {
      // Only the "nothing here I can extract" answer is worth a second look. A private
      // account or a deleted post is a real answer and stays one.
      if (SeraError.from(error).code !== 'UNSUPPORTED_SOURCE') throw error;
      return this.resolveImages(url, context, error);
    }
  }

  private async resolveImages(
    url: URL,
    context: ProviderContext,
    original: unknown,
  ): Promise<ResolvedMedia> {
    const parts = url.pathname.split('/').filter(Boolean);
    const actor = parts[1];
    const rkey = parts[3];
    if (!actor || !rkey || parts[0] !== 'profile' || parts[2] !== 'post') throw original;

    let post: BlueskyPost;
    try {
      const did = actor.startsWith('did:') ? actor : await this.resolveHandle(actor, context);
      post = await this.readPost(did, rkey, context);
    } catch {
      // The API is a convenience, not a contract. If it will not answer, the extractor's
      // own verdict is what the user hears.
      throw original;
    }

    const images = imagesIn(post);
    if (!images.length) throw original;

    const author = nonEmpty(post.author?.displayName) ?? post.author?.handle;
    const text = typeof post.record?.text === 'string' ? post.record.text.trim() : '';
    const title = text ? truncate(text, 200) : `Post by ${author ?? 'Bluesky user'}`;

    // The CDN's URLs end in `@jpeg` and it serves WebP, so the extension is no guide.
    // One HEAD settles it for the whole post: every image in a post comes from the same
    // CDN through the same pipeline, and asking once is cheaper than asking twenty times
    // for a carousel. If it will not answer, the download still corrects the file itself.
    const container = await this.containerOf(images[0]!.fullsize, context);

    const items: ResolvedItem[] = images
      .slice(0, context.config.maxItemsPerJob)
      .map((image, index) => {
        const plans: DownloadPlan[] = [
          {
            kind: 'image',
            container,
            label: 'Original',
            detail: [
              container.toUpperCase(),
              image.aspectRatio
                ? `${image.aspectRatio.width} × ${image.aspectRatio.height}`
                : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
            ...(image.aspectRatio?.width ? { width: image.aspectRatio.width } : {}),
            ...(image.aspectRatio?.height ? { height: image.aspectRatio.height } : {}),
            requiresConversion: false,
            recommended: true,
            fetch: { via: 'direct', url: image.fullsize },
          },
        ];

        return {
          // The CDN path ends in the blob's content hash, which is stable — so a
          // selection survives the post gaining or losing an image before download.
          sourceId: image.fullsize.split('/').pop() ?? String(index),
          index,
          kind: 'image' as const,
          // Alt text is the only real per-image name a post carries.
          title: image.alt?.trim() ? truncate(image.alt.trim(), 120) : `Image ${index + 1}`,
          thumbnailUrl: image.thumb ?? image.fullsize,
          ...(image.aspectRatio?.width ? { width: image.aspectRatio.width } : {}),
          ...(image.aspectRatio?.height ? { height: image.aspectRatio.height } : {}),
          container,
          plans: ensureRecommendations(plans),
        };
      });

    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: items.length > 1 ? 'collection' : 'single',
      title,
      ...(text ? { description: truncate(text, 500) } : {}),
      ...(author ? { author } : {}),
      ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
      items,
      metadata: { images: String(images.length) },
    };
  }

  private async containerOf(url: string, context: ProviderContext): Promise<ContainerFormat> {
    try {
      const head = await context.head(new URL(url));
      const contentType = (head.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const container = normalizeContainer(contentType, '');
      return container === 'bin' ? 'jpg' : container;
    } catch {
      return 'jpg';
    }
  }

  private async resolveHandle(handle: string, context: ProviderContext): Promise<string> {
    const endpoint = new URL('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle');
    endpoint.searchParams.set('handle', handle);
    const { body } = await context.fetchText(endpoint, 64 * 1024);
    const did = (JSON.parse(body) as { did?: unknown }).did;
    if (typeof did !== 'string' || !did.startsWith('did:')) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'bluesky: handle did not resolve' });
    }
    return did;
  }

  private async readPost(
    did: string,
    rkey: string,
    context: ProviderContext,
  ): Promise<BlueskyPost> {
    const endpoint = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread');
    endpoint.searchParams.set('uri', `at://${did}/app.bsky.feed.post/${rkey}`);
    endpoint.searchParams.set('depth', '0');
    endpoint.searchParams.set('parentHeight', '0');
    const { body } = await context.fetchText(endpoint, 512 * 1024);
    const post = (JSON.parse(body) as { thread?: { post?: BlueskyPost } }).thread?.post;
    if (!post) throw seraError('MEDIA_UNAVAILABLE', { detail: 'bluesky: no post in thread' });
    return post;
  }
}

interface BlueskyImage {
  readonly fullsize: string;
  readonly thumb?: string;
  readonly alt?: string;
  readonly aspectRatio?: { readonly width?: number; readonly height?: number };
}

interface BlueskyEmbed {
  readonly images?: readonly BlueskyImage[];
  readonly media?: { readonly images?: readonly BlueskyImage[] };
}

interface BlueskyPost {
  readonly author?: { readonly handle?: string; readonly displayName?: string };
  readonly record?: { readonly text?: unknown };
  readonly embed?: BlueskyEmbed;
}

/**
 * Images live in one of two places: directly on the embed, or under `media` when the post
 * also quotes another post.
 */
function imagesIn(post: BlueskyPost): readonly BlueskyImage[] {
  const candidates = post.embed?.images ?? post.embed?.media?.images ?? [];
  return candidates.filter(
    (image): image is BlueskyImage =>
      typeof image?.fullsize === 'string' && image.fullsize.startsWith('https://'),
  );
}
