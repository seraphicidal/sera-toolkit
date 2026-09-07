import type { ContainerFormat, ProviderCapabilities } from '@sera/contracts/types';
import { SeraError, seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { formatBytes, nonEmpty, qualityLabel, truncate } from '../util/format.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * X, formerly Twitter, plus the legacy and mobile hostnames.
 *
 * The extractor handles video and refuses everything else — "No video could be found in
 * this tweet" — which for a platform where most posts are photographs meant most posts
 * failed. Worse, for a photo post carrying a link card it followed the *link* and
 * reported the article as an unsupported source.
 *
 * So media enumeration comes from X's own public embed endpoint instead. It is what
 * every embedded tweet on the web is rendered from, needs no account and no key, answers
 * from a datacentre, and returns each attachment in post order with its dimensions, its
 * alt text and — for video — every bitrate X publishes. That makes mixed posts and
 * multi-photo posts work in the right order, which is the part the extractor could never
 * do. yt-dlp remains the fallback for anything the embed endpoint will not serve.
 */
export class TwitterProvider extends YtdlpProvider {
  readonly id = 'twitter';
  readonly label = 'X';
  readonly hosts = [
    'x.com',
    'twitter.com',
    'mobile.twitter.com',
    't.co',
    'vxtwitter.com',
    'fxtwitter.com',
  ];
  override readonly priority = 20;

  /**
   * Video through the extractor or the embed endpoint, photographs and mixed posts
   * through the embed endpoint. What the interface calls a GIF is a silent MP4, and is
   * offered as both.
   */
  override readonly capabilities: ProviderCapabilities = {
    video: true,
    image: true,
    carousel: true,
    audioExtraction: true,
    gif: true,
  };

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    // The mirror front-ends exist to fix embeds; the extractor wants the real host.
    out.hostname = 'x.com';
    out.protocol = 'https:';
    // /i/status/<id> and /<user>/status/<id> are the same post.
    out.pathname = out.pathname.replace(/\/(photo|video)\/\d+$/, '');
    return out;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const tweet = await this.readTweet(url, context).catch(() => undefined);
    // A quote post carries its own media if it has any, and otherwise the media belongs
    // to the post being quoted — which is what someone pasting the link is after.
    const source = usableMedia(tweet).length ? tweet : (tweet?.quoted_tweet ?? tweet);
    const media = usableMedia(source);

    if (media.length) return this.fromEmbed(url, source!, media, context);

    // No media the embed endpoint would show — either the post has none, or it would not
    // answer. The extractor gets the last word, including on why.
    try {
      return await super.resolve(url, context);
    } catch (error) {
      const seraErr = SeraError.from(error);
      if (tweet && seraErr.code === 'UNSUPPORTED_SOURCE') {
        throw seraError('MEDIA_UNAVAILABLE', {
          message: 'That post has no media to download.',
          detail: 'twitter: embed endpoint reported no attachments',
        });
      }
      throw seraErr;
    }
  }

  private fromEmbed(
    url: URL,
    tweet: SyndicatedTweet,
    media: readonly TweetMedia[],
    context: ProviderContext,
  ): ResolvedMedia {
    const author = nonEmpty(tweet.user?.name) ?? nonEmpty(tweet.user?.screen_name);
    const text = nonEmpty(tweet.text);

    const items = media
      .slice(0, context.config.maxItemsPerJob)
      .map((entry, index) => toItem(entry, index))
      .filter((item): item is ResolvedItem => item !== undefined);

    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'twitter: no usable attachment' });
    }

    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: items.length > 1 ? 'collection' : 'single',
      title: text ? truncate(text, 200) : `Post by ${author ?? 'an X account'}`,
      ...(text ? { description: truncate(text, 500) } : {}),
      ...(author ? { author } : {}),
      ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
      items,
      metadata: { attachments: String(media.length), source: 'syndication' },
    };
  }

  /**
   * X's embed endpoint wants a token derived from the post id — the same arithmetic the
   * embed widget on any website performs in the browser before making this request.
   */
  private async readTweet(
    url: URL,
    context: ProviderContext,
  ): Promise<SyndicatedTweet | undefined> {
    const id = /\/status(?:es)?\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) return undefined;

    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const endpoint = new URL('https://cdn.syndication.twimg.com/tweet-result');
    endpoint.searchParams.set('id', id);
    endpoint.searchParams.set('token', token);
    endpoint.searchParams.set('lang', 'en');

    const { body } = await context.fetchText(endpoint, 2 * 1024 * 1024);
    const tweet = JSON.parse(body) as SyndicatedTweet;
    return typeof tweet?.id_str === 'string' ? tweet : undefined;
  }
}

/* -------------------------------------------------------------------------- */

interface TweetVariant {
  readonly bitrate?: number;
  readonly content_type?: string;
  readonly url?: string;
}

interface TweetMedia {
  readonly type?: string;
  readonly media_url_https?: string;
  readonly ext_alt_text?: string;
  readonly original_info?: { readonly width?: number; readonly height?: number };
  readonly video_info?: {
    readonly duration_millis?: number;
    readonly variants?: readonly TweetVariant[];
  };
}

interface SyndicatedTweet {
  readonly id_str?: string;
  readonly text?: string;
  readonly user?: { readonly name?: string; readonly screen_name?: string };
  readonly mediaDetails?: readonly TweetMedia[];
  readonly quoted_tweet?: SyndicatedTweet;
}

/** Attachments the embed payload lists with a URL worth trying. */
function usableMedia(tweet: SyndicatedTweet | undefined): readonly TweetMedia[] {
  return tweet?.mediaDetails?.filter((entry) => nonEmpty(entry?.media_url_https)) ?? [];
}

/** `/vid/avc1/1280x720/abc.mp4` — X puts the rendition's size in the path. */
function sizeFromVariantUrl(url: string): { width?: number; height?: number } {
  const match = /\/(\d{2,4})x(\d{2,4})\//.exec(url);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** X serves a photo at several sizes; `name=orig` is the one that was uploaded. */
function originalPhotoUrl(url: string): string {
  const out = new URL(url);
  out.searchParams.set('name', 'orig');
  return out.toString();
}

function containerFor(url: string): ContainerFormat {
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpeg' || extension === 'jpg') return 'jpg';
  if (extension === 'png' || extension === 'webp' || extension === 'gif') {
    return extension;
  }
  return 'mp4';
}

function toItem(media: TweetMedia, index: number): ResolvedItem | undefined {
  const source = media.media_url_https;
  if (!source) return undefined;

  const width = media.original_info?.width;
  const height = media.original_info?.height;
  const alt = nonEmpty(media.ext_alt_text);
  const sourceId = /\/([^/?#]+)\.[a-z0-9]+(?:[?#]|$)/i.exec(source)?.[1] ?? String(index);

  if (media.type === 'photo') {
    const url = originalPhotoUrl(source);
    const container = containerFor(source);
    return {
      sourceId,
      index,
      kind: 'image',
      title: alt ? truncate(alt, 120) : `Image ${index + 1}`,
      thumbnailUrl: source,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      container,
      plans: ensureRecommendations([
        {
          kind: 'image',
          container,
          label: 'Original',
          detail: [container.toUpperCase(), width && height ? `${width} × ${height}` : undefined]
            .filter(Boolean)
            .join(' · '),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          requiresConversion: false,
          recommended: true,
          fetch: { via: 'direct', url },
        },
      ]),
    };
  }

  // Only progressive MP4 renditions; the HLS manifest alongside them needs a player.
  const variants = (media.video_info?.variants ?? [])
    .filter((variant) => variant.content_type === 'video/mp4' && variant.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (!variants.length) return undefined;

  const isGif = media.type === 'animated_gif';
  const durationSeconds = media.video_info?.duration_millis
    ? media.video_info.duration_millis / 1000
    : undefined;

  const plans: DownloadPlan[] = variants.map((variant, position) => {
    const size = sizeFromVariantUrl(variant.url!);
    const approximateBytes =
      variant.bitrate && durationSeconds ? (variant.bitrate / 8) * durationSeconds : undefined;
    return {
      kind: isGif ? 'gif' : 'video',
      container: 'mp4',
      label: isGif ? 'Original' : qualityLabel(size.height, size.width),
      detail: ['MP4 · H.264', approximateBytes ? `~${formatBytes(approximateBytes)}` : undefined]
        .filter(Boolean)
        .join(' · '),
      ...(size.width ? { width: size.width } : {}),
      ...(size.height ? { height: size.height } : {}),
      ...(approximateBytes
        ? { filesizeBytes: Math.round(approximateBytes), filesizeIsApproximate: true }
        : {}),
      requiresConversion: false,
      recommended: position === 0,
      fetch: { via: 'direct' as const, url: variant.url! },
    };
  });

  const best = variants[0]!.url!;
  if (isGif) {
    // The post is a GIF as far as anyone reading it is concerned; X just stores it as a
    // silent MP4. Offering the real thing is the point of recognising the difference.
    plans.push({
      kind: 'gif',
      container: 'gif',
      label: 'GIF',
      detail: 'Converted from the silent video X stores',
      requiresConversion: true,
      recommended: false,
      fetch: { via: 'direct', url: best },
      convert: { kind: 'gif' },
    });
  } else {
    plans.push(
      {
        kind: 'audio',
        container: 'mp3',
        label: 'MP3',
        detail: '320 kbps · extracted',
        audioBitrateKbps: 320,
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: best },
        convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
      },
      {
        kind: 'audio',
        container: 'm4a',
        label: 'M4A',
        detail: 'Original quality · AAC',
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: best },
        convert: { kind: 'audio', container: 'm4a' },
      },
    );
  }

  const size = sizeFromVariantUrl(best);
  return {
    sourceId,
    index,
    kind: isGif ? 'gif' : 'video',
    title: alt ? truncate(alt, 120) : isGif ? `GIF ${index + 1}` : `Video ${index + 1}`,
    thumbnailUrl: source,
    ...((size.width ?? width) ? { width: size.width ?? width } : {}),
    ...((size.height ?? height) ? { height: size.height ?? height } : {}),
    ...(durationSeconds ? { duration: durationSeconds } : {}),
    container: 'mp4',
    plans: ensureRecommendations(plans),
  };
}
