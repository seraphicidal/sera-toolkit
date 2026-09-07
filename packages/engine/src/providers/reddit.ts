import type { ContainerFormat, ProviderCapabilities } from '@sera/contracts/types';
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
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Reddit posts: images, galleries, hosted video, GIFs and direct media links.
 *
 * Reddit is the one provider here that cannot work anonymously from a server. Both the
 * page and its `.json` endpoint answer `403 Blocked` to hosted address ranges, and the
 * extractor's own answer from this deployment is "Account authentication is required".
 * That is Reddit's documented position, not a bug to route around, so this provider
 * talks to the Data API with an application-only OAuth token instead.
 *
 * With no credentials configured it says so plainly rather than failing per link.
 */
export class RedditProvider extends YtdlpProvider {
  readonly id = 'reddit';
  readonly label = 'Reddit';
  readonly hosts = ['reddit.com', 'redd.it', 'v.redd.it', 'i.redd.it', 'old.reddit.com'];
  override readonly priority = 20;

  private tokens: RedditTokenSource | undefined;

  /**
   * Images and galleries reach the datacentre; `v.redd.it` does not.
   *
   * Measured from this deployment: `i.redd.it` answers 200, `preview.redd.it` answers
   * 403, and `v.redd.it` answers 403 for the progressive `DASH_720.mp4?source=fallback`
   * file while serving its `DASHPlaylist.mpd` and `HLSPlaylist.m3u8` manifests with a
   * 206. So hosted video goes through the manifest, which is the only route to it that
   * this host can actually take — and the one that carries the audio track Reddit stores
   * separately.
   */
  override readonly capabilities: ProviderCapabilities = {
    video: true,
    image: true,
    carousel: true,
    audioExtraction: true,
    gif: true,
    authRequiredFor: ['everything — Reddit refuses anonymous requests from servers'],
  };

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

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    // A bare i.redd.it link is a file, not a post; the direct provider already claimed
    // those, so anything arriving here with a media host is a link Reddit redirected.
    const postId = postIdFrom(url);
    if (!postId) {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: 'That does not look like a Reddit post.',
        detail: `reddit: no post id in ${url.pathname}`,
      });
    }

    const credentials = this.credentialsFrom(context);
    if (!credentials) {
      throw seraError('PROVIDER_AUTH_REQUIRED', {
        message: 'Reddit needs an account, and this server does not have one.',
        hint: 'Reddit refuses anonymous requests from servers. The operator can enable it by registering a Reddit app and setting SERA_REDDIT_CLIENT_ID and SERA_REDDIT_CLIENT_SECRET.',
        detail: 'reddit: no client credentials configured',
      });
    }

    this.tokens ??= new RedditTokenSource(credentials, context.logger);
    const post = await fetchPost(postId, this.tokens, credentials);

    // A crosspost carries its media on the original, not on the share.
    const source = post.crosspost_parent_list?.[0] ?? post;
    const items = itemsFrom(source, context.config.maxItemsPerJob);
    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'That post has no media to download.',
        detail: 'reddit: no recognised media on the post',
      });
    }

    const author = nonEmpty(post.author);
    // The runner hands `url` to the extractor for a ytdlp plan. For a video post that
    // has to be the manifest: the post page is refused to this host, and the manifest is
    // what carries both streams.
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
      // Reddit's API rules ask for a unique agent that names the application and its
      // version. Nothing identifying about the visitor goes in it.
      userAgent: `server:sera.toolkit:v${context.config.version} (by /u/sera-toolkit)`,
    };
  }
}

/* -------------------------------------------------------------------------- */

/** `/r/<sub>/comments/<id>/<slug>`, or a `redd.it/<id>` short link. */
export function postIdFrom(url: URL): string | undefined {
  const comments = /\/comments\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  if (comments) return comments;
  if (url.hostname.toLowerCase().replace(/^www\./, '') === 'redd.it') {
    return /^\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  }
  return undefined;
}

/**
 * Reddit escapes `&` in the URLs it embeds in JSON, and a URL with a literal `&amp;`
 * in its query is a 403 from the CDN.
 */
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

/** Reddit records a MIME type per gallery entry; it is better than the URL's extension. */
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

    // An animated entry carries both a GIF and an MP4; the MP4 is smaller and plays
    // everywhere, so it leads, with the real GIF alongside it.
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

/**
 * The URL a Reddit video is actually reachable at, and how to fetch it.
 *
 * The progressive file the API points at first is refused to this host; the manifests
 * beside it are not. A manifest also carries the separate audio track, which is the
 * single most common complaint about tools that take the fallback and hand back a silent
 * video.
 */
function videoSource(video: RedditVideo): { url: string; viaManifest: boolean } | undefined {
  const manifest = nonEmpty(video.hls_url) ?? nonEmpty(video.dash_url);
  if (manifest) return { url: unescapeUrl(manifest), viaManifest: true };
  const fallback = nonEmpty(video.fallback_url);
  if (fallback) return { url: unescapeUrl(fallback), viaManifest: false };
  return undefined;
}

/** The manifest a video post is assembled from, when it is one. */
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

  // A manifest is a playlist, not bytes: the extractor assembles it and merges the audio.
  // A progressive file is just a file.
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
        // Reddit stores sound as a separate stream. Saying so is better than letting
        // someone discover it after the download.
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

/** Everything a post can carry, in the order Reddit lists it. */
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

  // A link post whose destination is an image Reddit itself hosts.
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

  // An animated preview Reddit generated for an external GIF.
  const preview = post.preview?.reddit_video_preview;
  if (preview) {
    const item = videoItem({ ...preview, is_gif: true }, post);
    if (item) return [item];
  }

  return [];
}
