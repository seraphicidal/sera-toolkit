import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatchesAny, urlExtension } from '../security/url.js';
import { nonEmpty, truncate } from '../util/format.js';
import { normalizeContainer } from './direct.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from './types.js';

export const THREADS_EMBED_AGENT = 'SERA.toolkit (+https://github.com/seraphicidal/sera-toolkit)';

const MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

export interface ThreadsPostRef {
  readonly code: string;
  readonly user?: string;
}

export interface ThreadsMedia {
  readonly kind: 'video' | 'image';
  readonly url: string;
  readonly poster?: string;
}

export interface ThreadsEmbed {
  readonly media: readonly ThreadsMedia[];
  readonly text?: string;
}

export function postRefFrom(url: URL): ThreadsPostRef | undefined {
  const post = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (post) return { user: post[1]!, code: post[2]! };
  const short = /^\/t\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  return short ? { code: short[1]! } : undefined;
}

export function embedUrlFor(ref: ThreadsPostRef): URL {
  const path = ref.user ? `/@${ref.user}/post/${ref.code}` : `/t/${ref.code}`;
  return new URL(`https://www.threads.com${path}/embed`);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function mediaUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = decodeEntities(raw);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hostMatchesAny(url.hostname, MEDIA_HOSTS)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function focusedPost(html: string): string | undefined {
  const marker = html.indexOf('OuterContainerFull');
  if (marker < 0) return undefined;
  const start = html.lastIndexOf('<div', marker);
  const post = html.slice(start < 0 ? marker : start);
  const end = post.indexOf('PostDateContainer');
  return end < 0 ? post : post.slice(0, end);
}

export function readEmbed(html: string): ThreadsEmbed | undefined {
  const post = focusedPost(html);
  if (post === undefined) return undefined;

  const media: ThreadsMedia[] = [];
  const seen = new Set<string>();
  for (const match of post.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>|<img\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith('<video')) {
      const source = /<source\b[^>]*>/.exec(tag)?.[0];
      const url = mediaUrl((source && attribute(source, 'src')) ?? attribute(tag, 'src'));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const poster = mediaUrl(attribute(tag, 'poster'));
      media.push({ kind: 'video', url, ...(poster ? { poster } : {}) });
      continue;
    }
    const url = mediaUrl(attribute(tag, 'src'));
    if (!url || seen.has(url) || !/\/t51\.\d+-15\//.test(new URL(url).pathname)) continue;
    seen.add(url);
    media.push({ kind: 'image', url });
  }

  const body = /BodyTextContainer[^>]*>([\s\S]*?)<\/span>/.exec(post)?.[1];
  const text = body
    ? decodeEntities(body.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    : undefined;
  return { media, ...(text ? { text } : {}) };
}

function videoItem(entry: ThreadsMedia, index: number): ResolvedItem {
  const plans: DownloadPlan[] = [
    {
      kind: 'video',
      container: 'mp4',
      label: 'Original',
      detail: 'MP4 · as posted',
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'direct', url: entry.url },
    },
    {
      kind: 'audio',
      container: 'mp3',
      label: 'MP3',
      detail: '192 kbps · extracted',
      audioBitrateKbps: 192,
      requiresConversion: true,
      recommended: false,
      fetch: { via: 'direct', url: entry.url },
      convert: { kind: 'audio', container: 'mp3', bitrateKbps: 192 },
    },
  ];
  return {
    sourceId: new URL(entry.url).pathname.split('/').pop() ?? String(index),
    index,
    kind: 'video',
    title: `Video ${index + 1}`,
    ...(entry.poster ? { thumbnailUrl: entry.poster } : {}),
    container: 'mp4',
    plans: ensureRecommendations(plans),
  };
}

function imageItem(entry: ThreadsMedia, index: number): ResolvedItem {
  const container = normalizeContainer('', urlExtension(new URL(entry.url)) ?? 'jpg');
  return {
    sourceId: new URL(entry.url).pathname.split('/').pop() ?? String(index),
    index,
    kind: 'image',
    title: `Image ${index + 1}`,
    thumbnailUrl: entry.url,
    container,
    plans: ensureRecommendations([
      {
        kind: 'image',
        container,
        label: 'Original',
        detail: `${container.toUpperCase()} · as posted`,
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct', url: entry.url },
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
  const ref = postRefFrom(url);
  if (!ref) {
    throw seraError('UNSUPPORTED_SOURCE', {
      message: 'That does not look like a Threads post.',
      hint: 'Use the link to a single post.',
      detail: `threads: no post code in ${url.pathname}`,
    });
  }

  const { body } = await fetchText(embedUrlFor(ref), 2 * 1024 * 1024, {
    headers: { 'user-agent': THREADS_EMBED_AGENT },
  });
  const embed = readEmbed(body);
  if (!embed) {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'That post is not available.',
      hint: 'It may have been deleted, or its author may have limited who can see it.',
      detail: 'threads: the embed showed no post',
    });
  }
  if (!embed.media.length) {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'That post has no media to download.',
      detail: 'threads: the post has no photo or video',
    });
  }

  const items = embed.media
    .slice(0, limit)
    .map((entry, index) =>
      entry.kind === 'video' ? videoItem(entry, index) : imageItem(entry, index),
    );
  const author = ref.user ? `@${ref.user}` : undefined;
  const text = nonEmpty(embed.text);

  return {
    provider: 'threads',
    providerLabel: 'Threads',
    url: ref.user
      ? `https://www.threads.com/@${ref.user}/post/${ref.code}`
      : `https://www.threads.com/t/${ref.code}`,
    type: items.length > 1 ? 'collection' : 'single',
    title: text ? truncate(text, 200) : `Post by ${author ?? 'a Threads account'}`,
    ...(text ? { description: truncate(text, 500) } : {}),
    ...(author ? { author, authorUrl: `https://www.threads.com/${author}` } : {}),
    ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
    items,
    metadata: { source: 'embed', items: String(items.length) },
  };
}
