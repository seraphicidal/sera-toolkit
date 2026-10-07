import type { ContainerFormat } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { ResolvedItem, ResolvedMedia } from './types.js';

export const REDDIT_EMBED_AGENT = 'SERA.toolkit (+https://github.com/seraphicidal/sera-toolkit)';

interface ScreenviewData {
  readonly post?: {
    readonly id?: string;
    readonly url?: string;
    readonly type?: string;
    readonly nsfw?: boolean;
  };
  readonly subreddit?: { readonly name?: string };
}

interface Oembed {
  readonly title?: string;
  readonly author_name?: string;
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function embedUrlFor(url: URL): URL {
  const embed = new URL(url.toString());
  embed.hostname = 'embed.reddit.com';
  embed.search = '';
  return embed;
}

export function screenviewFrom(html: string): ScreenviewData | undefined {
  const match = /<shreddit-screenview-data\s+data="([^"]*)"/.exec(html);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(unescapeAttribute(match[1])) as ScreenviewData;
  } catch {
    return undefined;
  }
}

export function imagesFrom(html: string): string[] {
  return [
    ...new Set([...html.matchAll(/https:\/\/i\.redd\.it\/[A-Za-z0-9._-]+/g)].map((m) => m[0])),
  ];
}

export function videoBaseFromUrl(url: URL): string | undefined {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'v.redd.it') return undefined;
  const id = url.pathname.split('/').find(Boolean);
  return id && /^[A-Za-z0-9]+$/.test(id) ? `https://v.redd.it/${id}` : undefined;
}

export function videoBaseFrom(html: string): string | undefined {
  return [
    ...new Set([...html.matchAll(/https:\/\/v\.redd\.it\/[A-Za-z0-9]+/g)].map((m) => m[0])),
  ][0];
}

function containerFor(url: string): ContainerFormat {
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpeg' || extension === 'jpg') return 'jpg';
  if (extension === 'png' || extension === 'webp' || extension === 'gif') return extension;
  return 'jpg';
}

function imageItem(url: string, index: number): ResolvedItem {
  const container = containerFor(url);
  return {
    sourceId: url.split('/').pop() ?? String(index),
    index,
    kind: container === 'gif' ? 'gif' : 'image',
    title: `Image ${index + 1}`,
    thumbnailUrl: url,
    container,
    plans: ensureRecommendations([
      {
        kind: container === 'gif' ? 'gif' : 'image',
        container,
        label: 'Original',
        detail: `${container.toUpperCase()} · as posted`,
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct', url },
      },
    ]),
  };
}

function videoItem(base: string): ResolvedItem {
  return {
    sourceId: base.split('/').pop() ?? 'video',
    index: 0,
    kind: 'video',
    title: 'Video',
    container: 'mp4',
    plans: ensureRecommendations([
      {
        kind: 'video',
        container: 'mp4',
        label: 'Best available',
        detail: 'MP4 · from the streaming manifest',
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'ytdlp', selector: 'bestvideo*+bestaudio/best', merge: 'mp4' },
      },
      {
        kind: 'audio',
        container: 'mp3',
        label: 'MP3',
        detail: '192 kbps · extracted',
        audioBitrateKbps: 192,
        requiresConversion: true,
        recommended: false,
        fetch: {
          via: 'ytdlp',
          selector: 'bestaudio/best',
          audio: { format: 'mp3', quality: '192' },
        },
      },
    ]),
  };
}

export async function readViaEmbed(
  url: URL,
  fetchText: (
    target: URL,
    maxBytes?: number,
    options?: { headers?: Record<string, string> },
  ) => Promise<{ body: string }>,
  limit: number,
): Promise<ResolvedMedia> {
  const headers = { 'user-agent': REDDIT_EMBED_AGENT };

  const direct = videoBaseFromUrl(url);
  if (direct) {
    return {
      provider: 'reddit',
      providerLabel: 'Reddit',
      url: `${direct}/HLSPlaylist.m3u8`,
      type: 'single',
      title: 'Reddit video',
      items: [videoItem(direct)],
      metadata: { source: 'v.redd.it', items: '1' },
    };
  }

  const { body: html } = await fetchText(embedUrlFor(url), 2 * 1024 * 1024, { headers });
  const screenview = screenviewFrom(html);
  const images = imagesFrom(html);
  const videoBase = videoBaseFrom(html);

  let items: ResolvedItem[];
  let extractFrom = url.toString();

  if (videoBase) {
    items = [videoItem(videoBase)];
    extractFrom = `${videoBase}/HLSPlaylist.m3u8`;
  } else if (images.length) {
    items = images.slice(0, limit).map((image, index) => imageItem(image, index));
  } else {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'That post has no media to download.',
      detail: `reddit: the embed named no media (type ${screenview?.post?.type ?? 'unknown'})`,
    });
  }

  const oembedUrl = new URL('https://www.reddit.com/oembed');
  oembedUrl.searchParams.set('url', url.toString());
  const oembed = await fetchText(oembedUrl, 256 * 1024, { headers })
    .then(({ body }) => JSON.parse(body) as Oembed)
    .catch(() => undefined);

  const author = nonEmpty(oembed?.author_name);
  const title = nonEmpty(oembed?.title);

  return {
    provider: 'reddit',
    providerLabel: 'Reddit',
    url: extractFrom,
    type: items.length > 1 ? 'collection' : 'single',
    title: title ? truncate(title, 200) : 'Reddit post',
    ...(author ? { author: `u/${author}` } : {}),
    ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
    items,
    metadata: {
      source: 'embed',
      ...(screenview?.subreddit?.name ? { subreddit: `r/${screenview.subreddit.name}` } : {}),
      items: String(items.length),
    },
  };
}
