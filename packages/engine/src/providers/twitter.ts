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
    out.pathname = out.pathname.replace(/\/(photo|video)\/\d+$/, '');
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
    const host = target.hostname.toLowerCase();
    const isTwitterHost = [
      'x.com',
      'twitter.com',
      'mobile.twitter.com',
      'vxtwitter.com',
      'fxtwitter.com',
    ].some((h) => host === h || host.endsWith(`.${h}`));
    const isStatus = /^\/[^/]+\/status\/\d+/i.test(target.pathname);
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
        id: 'ytdlp',
        label: 'the extractor',
        run: (target, ctx) => this.runExtractor(target, ctx),
      },
    ];
  }

  private async viaSyndication(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const tweet = await this.readTweet(url, context).catch(() => undefined);
    const source = usableMedia(tweet).length ? tweet : (tweet?.quoted_tweet ?? tweet);
    const media = usableMedia(source);

    if (media.length) return this.fromEmbed(url, source!, media, context);

    if (tweet) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'That post has no media to download.',
        detail: 'twitter: embed endpoint reported no attachments',
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

function toItem(media: TweetMedia, index: number): ResolvedItem | undefined {
  const source = media.media_url_https;
  if (!source?.startsWith('https://')) return undefined;

  const width = media.original_info?.width;
  const height = media.original_info?.height;
  const alt = nonEmpty(media.ext_alt_text);
  const sourceId = /\/([^/?#]+)\.[a-z0-9]+(?:[?#]|$)/i.exec(source)?.[1] ?? String(index);

  if (media.type === 'photo') {
    const url = originalPhotoUrl(source);
    if (!url) return undefined;
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

  const variants = (media.video_info?.variants ?? [])
    .filter(
      (variant) => variant.content_type === 'video/mp4' && variant.url?.startsWith('https://'),
    )
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
