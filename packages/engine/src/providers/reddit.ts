import type { ContainerFormat, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { nonEmpty, truncate } from '../util/format.js';
import {
  fetchPost,
  RedditTokenSource,
  type RedditCredentials,
  type RedditMediaMetadata,
  type RedditPost,
  type RedditVideo,
} from './reddit-api.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import { readViaEmbed, videoBaseFromUrl } from './reddit-embed.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class RedditProvider extends YtdlpProvider {
  readonly id = 'reddit';
  readonly label = 'Reddit';
  readonly hosts = ['reddit.com', 'redd.it', 'v.redd.it', 'i.redd.it', 'old.reddit.com'];
  override readonly priority = 20;

  private tokens: RedditTokenSource | undefined;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
    gif: true,
    authenticatedMode: true,
    requiresOauth: false,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    const host = out.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'reddit.com' || host === 'old.reddit.com') out.hostname = 'www.reddit.com';
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }

  protected override strategies(
    _url: URL,
    _context: ProviderContext,
  ): readonly ExtractionStrategy[] {
    return [
      {
        id: 'oauth-api',
        label: "Reddit's Data API, with the operator's app registration",
        available: (ctx) => this.credentialsFrom(ctx) !== undefined,
        run: (target, ctx) => {
          if (videoBaseFromUrl(target)) {
            throw seraError('UNSUPPORTED_SOURCE', { detail: 'reddit: a media host, not a post' });
          }
          return this.viaApi(target, ctx);
        },
      },
      {
        id: 'embed',
        label: 'what Reddit publishes for embedding',
        run: (target, ctx) =>
          readViaEmbed(
            target,
            (endpoint, maxBytes, options) => ctx.fetchText(endpoint, maxBytes, options),
            ctx.config.maxItemsPerJob,
          ),
      },
    ];
  }

  private async viaApi(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const postId = postIdFrom(url);
    if (!postId) {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: 'That does not look like a Reddit post.',
        detail: `reddit: no post id in ${url.pathname}`,
      });
    }

    const credentials = this.credentialsFrom(context);
    if (!credentials) {
      throw seraError('PROVIDER_CONFIGURATION_ERROR', {
        detail: 'reddit: no client credentials configured',
      });
    }

    this.tokens ??= new RedditTokenSource(credentials, context.logger);
    const post = await fetchPost(postId, this.tokens, credentials);

    const source = post.crosspost_parent_list?.[0] ?? post;
    const items = itemsFrom(source, context.config.maxItemsPerJob);
    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'That post has no media to download.',
        detail: 'reddit: no recognised media on the post',
      });
    }

    const author = nonEmpty(post.author);
    const extractFrom = manifestUrlFor(source) ?? url.toString();

    return {
      provider: this.id,
      providerLabel: this.label,
      url: extractFrom,
      type: items.length > 1 ? 'collection' : 'single',
      title: nonEmpty(post.title) ? truncate(post.title!, 200) : 'Reddit post',
      ...(author ? { author: `u/${author}` } : {}),
      ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
      items,
      metadata: {
        subreddit: nonEmpty(post.subreddit_name_prefixed) ?? 'unknown',
        items: String(items.length),
      },
    };
  }

  private credentialsFrom(context: ProviderContext): RedditCredentials | undefined {
    const { clientId, clientSecret } = context.config.reddit;
    if (!clientId || !clientSecret) return undefined;
    return {
      clientId,
      clientSecret,
      userAgent: `server:sera.toolkit:v${context.config.version} (by /u/sera-toolkit)`,
    };
  }
}

export function postIdFrom(url: URL): string | undefined {
  const comments = /\/comments\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  if (comments) return comments;
  if (url.hostname.toLowerCase().replace(/^www\./, '') === 'redd.it') {
    return /^\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  }
  return undefined;
}

function unescapeUrl(value: string): string {
  return value.replace(/&amp;/g, '&');
}

function imagePlan(url: string, container: ContainerFormat, width?: number, height?: number) {
  return {
    kind: 'image' as const,
    container,
    label: 'Original',
    detail: [container.toUpperCase(), width && height ? `${width} × ${height}` : undefined]
      .filter(Boolean)
      .join(' · '),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    requiresConversion: false,
    recommended: true,
    fetch: { via: 'direct' as const, url },
  };
}

function containerFromMime(mime: string | undefined, url: string): ContainerFormat {
  const subtype = /^image\/([a-z0-9+.-]+)$/i.exec(mime ?? '')?.[1]?.toLowerCase();
  if (subtype === 'jpg' || subtype === 'jpeg') return 'jpg';
  if (subtype === 'png' || subtype === 'gif' || subtype === 'webp') {
    return subtype;
  }
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpeg' || extension === 'jpg') return 'jpg';
  if (extension === 'png' || extension === 'gif' || extension === 'webp') {
    return extension;
  }
  return 'jpg';
}

function galleryItems(post: RedditPost, limit: number): ResolvedItem[] {
  const order = post.gallery_data?.items ?? [];
  const metadata = post.media_metadata ?? {};
  const items: ResolvedItem[] = [];

  for (const entry of order.slice(0, limit)) {
    const id = entry.media_id;
    const media: RedditMediaMetadata | undefined = id ? metadata[id] : undefined;
    if (media?.status !== 'valid') continue;

    const still = nonEmpty(media.s?.u);
    const gif = nonEmpty(media.s?.gif);
    const mp4 = nonEmpty(media.s?.mp4);
    const width = media.s?.x;
    const height = media.s?.y;

    if (media.e === 'AnimatedImage' && (mp4 ?? gif)) {
      const plans: DownloadPlan[] = [];
      if (mp4) {
        plans.push({
          kind: 'gif',
          container: 'mp4',
          label: 'MP4',
          detail: 'Silent video · smaller than the GIF',
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          requiresConversion: false,
          recommended: true,
          fetch: { via: 'direct', url: unescapeUrl(mp4) },
        });
      }
      if (gif) {
        plans.push({
          kind: 'gif',
          container: 'gif',
          label: 'GIF',
          detail: 'Original',
          requiresConversion: false,
          recommended: !mp4,
          fetch: { via: 'direct', url: unescapeUrl(gif) },
        });
      }
      items.push({
        sourceId: id!,
        index: items.length,
        kind: 'gif',
        title: `GIF ${items.length + 1}`,
        ...(still ? { thumbnailUrl: unescapeUrl(still) } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        container: mp4 ? 'mp4' : 'gif',
        plans: ensureRecommendations(plans),
      });
      continue;
    }

    if (!still) continue;
    const url = unescapeUrl(still);
    const container = containerFromMime(media.m, url);
    items.push({
      sourceId: id!,
      index: items.length,
      kind: 'image',
      title: `Image ${items.length + 1}`,
      thumbnailUrl: url,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      container,
      plans: ensureRecommendations([imagePlan(url, container, width, height)]),
    });
  }

  return items;
}

function videoSource(video: RedditVideo): { url: string; viaManifest: boolean } | undefined {
  const manifest = nonEmpty(video.hls_url) ?? nonEmpty(video.dash_url);
  if (manifest) return { url: unescapeUrl(manifest), viaManifest: true };
  const fallback = nonEmpty(video.fallback_url);
  if (fallback) return { url: unescapeUrl(fallback), viaManifest: false };
  return undefined;
}

export function manifestUrlFor(post: RedditPost): string | undefined {
  const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
  const preview = post.preview?.reddit_video_preview;
  const source = videoSource(video ?? preview ?? {});
  return source?.viaManifest ? source.url : undefined;
}

function videoItem(video: RedditVideo, post: RedditPost): ResolvedItem | undefined {
  const source = videoSource(video);
  if (!source) return undefined;
  const { url, viaManifest } = source;
  const isGif = video.is_gif === true;

  const fetchPlan: DownloadPlan['fetch'] = viaManifest
    ? { via: 'ytdlp', selector: 'best', merge: 'mp4' }
    : { via: 'direct', url };

  const plans: DownloadPlan[] = [
    {
      kind: isGif ? 'gif' : 'video',
      container: 'mp4',
      label: 'Original',
      detail: [
        'MP4',
        video.width && video.height ? `${video.width} × ${video.height}` : undefined,
        video.has_audio === false || isGif ? 'silent' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      ...(video.width ? { width: video.width } : {}),
      ...(video.height ? { height: video.height } : {}),
      requiresConversion: false,
      recommended: true,
      fetch: fetchPlan,
    },
  ];

  if (isGif) {
    plans.push({
      kind: 'gif',
      container: 'gif',
      label: 'GIF',
      detail: 'Converted from the silent video Reddit stores',
      requiresConversion: true,
      recommended: false,
      fetch: fetchPlan,
      convert: { kind: 'gif' },
    });
  }

  const thumbnail = nonEmpty(post.preview?.images?.[0]?.source?.url);
  return {
    sourceId: 'video',
    index: 0,
    kind: isGif ? 'gif' : 'video',
    title: nonEmpty(post.title) ? truncate(post.title!, 120) : 'Video',
    ...(thumbnail ? { thumbnailUrl: unescapeUrl(thumbnail) } : {}),
    ...(video.width ? { width: video.width } : {}),
    ...(video.height ? { height: video.height } : {}),
    ...(video.duration ? { duration: video.duration } : {}),
    container: 'mp4',
    plans: ensureRecommendations(plans),
  };
}

export function itemsFrom(post: RedditPost, limit: number): ResolvedItem[] {
  if (post.is_gallery) {
    const gallery = galleryItems(post, limit);
    if (gallery.length) return gallery;
  }

  const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
  if (video) {
    const item = videoItem(video, post);
    if (item) return [item];
  }

  const direct = nonEmpty(post.url_overridden_by_dest) ?? nonEmpty(post.url);
  if (direct && /^https:\/\/i\.redd\.it\//i.test(direct)) {
    const url = unescapeUrl(direct);
    const source = post.preview?.images?.[0]?.source;
    const container = containerFromMime(undefined, url);
    const kind = container === 'gif' ? 'gif' : 'image';
    return [
      {
        sourceId: 'image',
        index: 0,
        kind,
        title: nonEmpty(post.title) ? truncate(post.title!, 120) : 'Image',
        thumbnailUrl: url,
        ...(source?.width ? { width: source.width } : {}),
        ...(source?.height ? { height: source.height } : {}),
        container,
        plans: ensureRecommendations([imagePlan(url, container, source?.width, source?.height)]),
      },
    ];
  }

  const preview = post.preview?.reddit_video_preview;
  if (preview) {
    const item = videoItem({ ...preview, is_gif: true }, post);
    if (item) return [item];
  }

  return [];
}
