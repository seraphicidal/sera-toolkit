import type { ContainerFormat, ProviderCapabilities } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { formatBytes, nonEmpty, qualityLabel, truncate } from '../util/format.js';
import { discard, header } from '../security/http.js';
import { hostMatchesAny } from '../security/url.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import { extractWithGalleryDl } from '../extract/gallerydl.js';

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
    'fixupx.com',
    'fixvx.com',
    'twittpr.com',
  ];
  override readonly priority = 20;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
    gif: true,
  });

  override normalize(url: URL): URL {
    if (url.hostname.toLowerCase() === 't.co') return url;
    const out = new URL(url.toString());
    out.hostname = 'x.com';
    out.protocol = 'https:';
    out.pathname = out.pathname.replace(/\/(photo|video)\/\d+\/?$/i, '');
    return out;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const target =
      url.hostname.toLowerCase() === 't.co' ? await this.expandShortLink(url, context) : url;
    return super.resolve(target, context);
  }

  private async expandShortLink(url: URL, context: ProviderContext): Promise<URL> {
    if (!context.open) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 't.co: no open helper available' });
    }
    const response = await context.open(url, {
      method: 'GET',
      followRedirects: false,
      headers: { 'user-agent': 'curl/8.7.1' },
    });
    let location = header(response.headers, 'location');
    if (!location && response.status === 200) {
      let html = '';
      try {
        for await (const chunk of response.body) {
          const text =
            typeof chunk === 'string'
              ? chunk
              : chunk instanceof Uint8Array
                ? Buffer.from(chunk).toString('utf8')
                : String(chunk);
          html += text;
          if (html.length > 64 * 1024) break;
        }
      } catch {}
      discard(response.body);
      const match =
        /content=["']\d+;\s*url=([^"'>]+)["']/i.exec(html) ??
        /location\.replace\(["']([^"']+)["']\)/i.exec(html);
      if (match?.[1]) {
        location = match[1].replace(/\\/g, '');
      }
    } else {
      discard(response.body);
    }
    if (!location && (response.status < 300 || response.status >= 400)) {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: 'That short link did not redirect.',
        detail: `t.co: returned HTTP ${response.status}`,
      });
    }
    if (!location) {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: 'That short link has no redirect location.',
        detail: 't.co: missing location header',
      });
    }
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      throw seraError('INVALID_URL', { detail: 't.co: malformed redirect location' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw seraError('BLOCKED_ADDRESS', { detail: `t.co redirect to ${target.protocol}` });
    }
    if (hostMatchesAny(target.hostname, context.config.blockedHosts)) {
      throw seraError('BLOCKED_ADDRESS', { detail: 't.co redirect to blocked host' });
    }
    if (target.port !== '' && target.port !== '80' && target.port !== '443') {
      throw seraError('BLOCKED_ADDRESS', { detail: `t.co redirect to port ${target.port}` });
    }
    const host = target.hostname.toLowerCase();
    const isTwitterHost = [
      'x.com',
      'twitter.com',
      'mobile.twitter.com',
      'vxtwitter.com',
      'fxtwitter.com',
      'fixupx.com',
      'fixvx.com',
      'twittpr.com',
    ].some((h) => host === h || host.endsWith(`.${h}`));
    const isStatus = /^\/(?:i\/(?:web\/)?|[^/]+\/)status\/\d+/i.test(target.pathname);
    if (!isTwitterHost || !isStatus) {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: 'That short link does not point to an X post.',
        detail: `t.co: target ${target.hostname}${target.pathname} is not an X status`,
      });
    }
    return this.normalize(target);
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
        id: 'syndication',
        label: "the endpoint X's embed widget calls",
        run: (target, ctx) => this.viaSyndication(target, ctx),
      },
      {
        id: 'fxtwitter',
        label: 'the FixTweet API',
        run: (target, ctx) => this.viaFxTwitter(target, ctx),
      },
      {
        id: 'gallerydl',
        label: 'the gallery scraper',
        run: (target, ctx) => this.viaGalleryDl(target, ctx),
      },
      {
        id: 'ytdlp',
        label: 'the extractor',
        run: (target, ctx) => this.runExtractor(target, ctx),
      },
    ];
  }

  private async viaSyndication(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const tweet = await this.readTweet(url, context).catch((error: unknown) => {
      if (context.signal?.aborted) throw error;
      return undefined;
    });
    const source = usableMedia(tweet).length ? tweet : (tweet?.quoted_tweet ?? tweet);
    const media = usableMedia(source);

    if (media.length) return this.fromEmbed(url, source!, media, context);

    if (tweet) {
      if (tweet.possibly_sensitive) {
        throw seraError('UNSUPPORTED_SOURCE', {
          detail: 'twitter: sensitive post attachments not served by syndication',
        });
      }
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: 'Syndication returned no media details',
      });
    }
    throw seraError('UNSUPPORTED_SOURCE', {
      detail: 'twitter: the syndication endpoint did not answer',
    });
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
      .map((entry, index) => toItem(entry, index, context.allowUrl))
      .filter((item): item is ResolvedItem => item !== undefined);

    if (!items.length) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'twitter: no usable direct attachment' });
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

  private async viaFxTwitter(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const id = /\/status(?:es)?\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'fxtwitter: no tweet id' });
    }

    const endpoint = new URL(`https://api.fxtwitter.com/status/${id}`);
    const { body } = await context.fetchText(endpoint, 4 * 1024 * 1024);
    let parsed: FxTweetResponse;
    try {
      parsed = JSON.parse(body) as FxTweetResponse;
    } catch {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'fxtwitter: invalid json' });
    }
    if (parsed.code === 404) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'That post is no longer available.',
        detail: 'fxtwitter: returned 404',
      });
    }
    const tweet = parsed.tweet;
    if (!tweet) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'fxtwitter: no tweet in response' });
    }

    const rawList = tweet.media?.all ?? tweet.media?.photos ?? tweet.media?.videos ?? [];
    const media = rawList.filter((item) => {
      if (typeof item.url !== 'string' || !item.url.startsWith('https://')) return false;
      try {
        if (context.allowUrl) context.allowUrl(item.url);
        else new URL(item.url);
        return true;
      } catch {
        return false;
      }
    });

    if (!media.length) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'That post has no media to download.',
        detail: 'fxtwitter: post contains no media',
      });
    }

    const author = nonEmpty(tweet.author?.name) ?? nonEmpty(tweet.author?.screen_name);
    const text = nonEmpty(tweet.text);

    const items = media
      .slice(0, context.config.maxItemsPerJob)
      .map((entry, index) => toFxItem(entry, index, context.allowUrl))
      .filter((item): item is ResolvedItem => item !== undefined);

    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'fxtwitter: no usable attachments' });
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
      metadata: { attachments: String(media.length), source: 'fxtwitter' },
    };
  }

  private async viaGalleryDl(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const media = await extractWithGalleryDl(url, context, { providerId: 'twitter' });
    return {
      ...media,
      provider: this.id,
      providerLabel: this.label,
    };
  }
}

interface FxTweetFormat {
  readonly url?: string;
  readonly bitrate?: number;
  readonly container?: string;
  readonly codec?: string;
}

interface FxTweetVariant {
  readonly url?: string;
  readonly bitrate?: number;
  readonly content_type?: string;
}

interface FxTweetMediaItem {
  readonly type?: 'photo' | 'video' | 'gif';
  readonly id?: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
  readonly description?: string;
  readonly thumbnail_url?: string;
  readonly duration?: number;
  readonly format?: string;
  readonly formats?: readonly FxTweetFormat[];
  readonly variants?: readonly FxTweetVariant[];
}

interface FxTweet {
  readonly text?: string;
  readonly author?: { readonly name?: string; readonly screen_name?: string };
  readonly media?: {
    readonly all?: readonly FxTweetMediaItem[];
    readonly photos?: readonly FxTweetMediaItem[];
    readonly videos?: readonly FxTweetMediaItem[];
  };
}

interface FxTweetResponse {
  readonly code?: number;
  readonly message?: string;
  readonly tweet?: FxTweet;
}

interface NormalizedTweetMedia {
  readonly source: string;
  readonly isPhoto: boolean;
  readonly isGif: boolean;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly alt?: string | undefined;
  readonly sourceId: string;
  readonly thumbnailUrl: string;
  readonly durationSeconds?: number | undefined;
  readonly variants: readonly {
    url: string;
    bitrate?: number | undefined;
    width?: number | undefined;
    height?: number | undefined;
  }[];
}

function validateTwitterMediaUrl(
  raw: string | undefined,
  allowUrl?: (url: string | URL) => URL,
): string | undefined {
  if (!raw?.startsWith('https://')) return undefined;
  if (!allowUrl) return raw;
  try {
    return allowUrl(raw).toString();
  } catch {
    return undefined;
  }
}

function buildTwitterMediaItem(
  normalized: NormalizedTweetMedia,
  index: number,
  allowUrl?: (url: string | URL) => URL,
): ResolvedItem | undefined {
  const { isPhoto, isGif, width, height, alt, sourceId, thumbnailUrl, durationSeconds, variants } =
    normalized;

  if (isPhoto) {
    const rawPhoto = originalPhotoUrl(normalized.source);
    const url = validateTwitterMediaUrl(rawPhoto, allowUrl);
    if (!url) return undefined;
    const container = containerFor(normalized.source);
    return {
      sourceId,
      index,
      kind: 'image',
      title: alt ? truncate(alt, 120) : `Image ${index + 1}`,
      thumbnailUrl,
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

  if (!variants.length) return undefined;

  const seenLabels = new Set<string>();
  const plans: DownloadPlan[] = [];
  for (const variant of variants) {
    const itemWidth = variant.width ?? width;
    const itemHeight = variant.height ?? height;
    const label = isGif ? 'Original' : qualityLabel(itemHeight, itemWidth);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const approximateBytes =
      variant.bitrate && durationSeconds ? (variant.bitrate / 8) * durationSeconds : undefined;
    plans.push({
      kind: isGif ? 'gif' : 'video',
      container: 'mp4',
      label,
      detail: ['MP4 · H.264', approximateBytes ? `~${formatBytes(approximateBytes)}` : undefined]
        .filter(Boolean)
        .join(' · '),
      ...(itemWidth ? { width: itemWidth } : {}),
      ...(itemHeight ? { height: itemHeight } : {}),
      ...(approximateBytes
        ? { filesizeBytes: Math.round(approximateBytes), filesizeIsApproximate: true }
        : {}),
      requiresConversion: false,
      recommended: plans.length === 0,
      fetch: { via: 'direct' as const, url: variant.url },
    });
  }

  const best = variants[0]!.url;
  if (isGif) {
    if (!durationSeconds || durationSeconds <= 30) {
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
    }
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

  const bestSize = sizeFromVariantUrl(best);
  const itemWidth = bestSize.width ?? width;
  const itemHeight = bestSize.height ?? height;
  return {
    sourceId,
    index,
    kind: isGif ? 'gif' : 'video',
    title: alt ? truncate(alt, 120) : isGif ? `GIF ${index + 1}` : `Video ${index + 1}`,
    thumbnailUrl,
    ...(itemWidth ? { width: itemWidth } : {}),
    ...(itemHeight ? { height: itemHeight } : {}),
    ...(durationSeconds ? { duration: durationSeconds } : {}),
    container: 'mp4',
    plans: ensureRecommendations(plans),
  };
}

function toFxItem(
  media: FxTweetMediaItem,
  index: number,
  allowUrl?: (url: string | URL) => URL,
): ResolvedItem | undefined {
  const source = validateTwitterMediaUrl(media.url, allowUrl);
  if (!source) return undefined;

  const width = media.width;
  const height = media.height;
  const alt = nonEmpty(media.altText) ?? nonEmpty(media.description);
  const sourceId =
    media.id ?? /\/([^/?#]+)\.[a-z0-9]+(?:[?#]|$)/i.exec(source)?.[1] ?? String(index);
  const rawVariants = (media.variants ?? [])
    .filter((variant) => variant.content_type === 'video/mp4')
    .map((variant) => ({
      url: validateTwitterMediaUrl(variant.url, allowUrl),
      bitrate: variant.bitrate,
    }))
    .filter((variant): variant is { url: string; bitrate: number | undefined } =>
      Boolean(variant.url),
    )
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  const variants =
    rawVariants.length > 0
      ? rawVariants.map((v) => ({
          url: v.url,
          bitrate: v.bitrate,
          ...sizeFromVariantUrl(v.url),
        }))
      : [{ url: source, width, height }];

  const thumbnailUrl = validateTwitterMediaUrl(media.thumbnail_url, allowUrl) ?? source;
  return buildTwitterMediaItem(
    {
      source,
      isPhoto: media.type === 'photo',
      isGif: media.type === 'gif',
      width,
      height,
      alt,
      sourceId,
      thumbnailUrl,
      durationSeconds: media.duration,
      variants,
    },
    index,
    allowUrl,
  );
}

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
  readonly possibly_sensitive?: boolean;
  readonly user?: { readonly name?: string; readonly screen_name?: string };
  readonly mediaDetails?: readonly TweetMedia[];
  readonly quoted_tweet?: SyndicatedTweet;
}

function usableMedia(tweet: SyndicatedTweet | undefined): readonly TweetMedia[] {
  return (
    tweet?.mediaDetails?.filter((entry) => {
      const url = nonEmpty(entry?.media_url_https);
      return Boolean(url?.startsWith('https://'));
    }) ?? []
  );
}

function sizeFromVariantUrl(url: string): { width?: number; height?: number } {
  const match = /\/(\d{2,4})x(\d{2,4})\//.exec(url);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function originalPhotoUrl(url: string): string | undefined {
  try {
    const out = new URL(url);
    if (out.protocol !== 'https:') return undefined;
    out.searchParams.set('name', 'orig');
    return out.toString();
  } catch {
    return undefined;
  }
}

function containerFor(url: string): ContainerFormat {
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpeg' || extension === 'jpg') return 'jpg';
  if (extension === 'png' || extension === 'webp' || extension === 'gif') {
    return extension;
  }
  return 'mp4';
}

function toItem(
  media: TweetMedia,
  index: number,
  allowUrl?: (url: string | URL) => URL,
): ResolvedItem | undefined {
  const source = validateTwitterMediaUrl(media.media_url_https, allowUrl);
  if (!source) return undefined;

  const width = media.original_info?.width;
  const height = media.original_info?.height;
  const alt = nonEmpty(media.ext_alt_text);
  const sourceId = /\/([^/?#]+)\.[a-z0-9]+(?:[?#]|$)/i.exec(source)?.[1] ?? String(index);
  const variants = (media.video_info?.variants ?? [])
    .filter((variant) => variant.content_type === 'video/mp4')
    .map((variant) => ({
      url: validateTwitterMediaUrl(variant.url, allowUrl),
      bitrate: variant.bitrate,
    }))
    .filter((variant): variant is { url: string; bitrate: number | undefined } =>
      Boolean(variant.url),
    )
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .map((v) => ({
      url: v.url,
      bitrate: v.bitrate,
      ...sizeFromVariantUrl(v.url),
    }));

  const durationSeconds = media.video_info?.duration_millis
    ? media.video_info.duration_millis / 1000
    : undefined;

  return buildTwitterMediaItem(
    {
      source,
      isPhoto: media.type === 'photo',
      isGif: media.type === 'animated_gif',
      width,
      height,
      alt,
      sourceId,
      thumbnailUrl: source,
      durationSeconds,
      variants,
    },
    index,
    allowUrl,
  );
}
