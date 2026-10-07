import { MAX_IMPORTED_ITEMS } from '@sera/contracts';
import type { ContainerFormat } from '@sera/contracts/types';
import { seraError, type SeraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatchesAny } from '../security/url.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from './types.js';

const APP_ID = '936619743392459';

export interface InstagramCandidate {
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface InstagramNode {
  readonly id?: string;
  readonly code?: string;
  readonly media_type?: number;
  readonly carousel_media?: readonly InstagramNode[];
  readonly image_versions2?: { readonly candidates?: readonly InstagramCandidate[] };
  readonly video_versions?: readonly InstagramCandidate[];
  readonly video_duration?: number;
  readonly accessibility_caption?: string;
  readonly user?: { readonly username?: string; readonly full_name?: string };
  readonly caption?: { readonly text?: string };
}

export interface InstagramOembed {
  readonly title?: string;
  readonly author_name?: string;
  readonly author_url?: string;
  readonly media_id?: string;
  readonly thumbnail_url?: string;
  readonly thumbnail_width?: number;
  readonly thumbnail_height?: number;
}

export async function oembedFor(
  url: URL,
  fetchText: (url: URL, maxBytes?: number) => Promise<{ body: string }>,
): Promise<InstagramOembed> {
  const endpoint = new URL('https://www.instagram.com/api/v1/oembed/');
  endpoint.searchParams.set('url', url.toString());
  const { body } = await fetchText(endpoint, 256 * 1024);
  return JSON.parse(body) as InstagramOembed;
}

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function mediaIdFromShortcode(shortcode: string): string {
  let id = 0n;
  for (const character of shortcode.slice(0, 11)) {
    const digit = SHORTCODE_ALPHABET.indexOf(character);
    if (digit < 0) throw seraError('UNSUPPORTED_SOURCE', { detail: 'instagram: bad shortcode' });
    id = id * 64n + BigInt(digit);
  }
  return id.toString();
}

export function coverItemFrom(oembed: InstagramOembed): ResolvedItem | undefined {
  const url = nonEmpty(oembed.thumbnail_url);
  if (!url) return undefined;

  const width = oembed.thumbnail_width;
  const height = oembed.thumbnail_height;
  const container = containerFor(url, 'jpg');

  return {
    sourceId: nonEmpty(oembed.media_id) ?? 'cover',
    index: 0,
    kind: 'image',
    title: 'Cover image',
    thumbnailUrl: url,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    container,
    plans: ensureRecommendations([
      {
        kind: 'image',
        container,
        label: 'Cover image',
        detail: [
          container.toUpperCase(),
          width && height ? `${width} × ${height}` : undefined,
          'the preview Instagram publishes',
        ]
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

export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    'x-ig-app-id': APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    cookie: `sessionid=${sessionId}`,
  };
}

function widest(
  candidates: readonly InstagramCandidate[] | undefined,
): InstagramCandidate | undefined {
  return [...(candidates ?? [])]
    .filter((candidate) => nonEmpty(candidate.url))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
}

function containerFor(url: string, fallback: ContainerFormat): ContainerFormat {
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpeg' || extension === 'jpg') return 'jpg';
  if (extension === 'png' || extension === 'webp') return extension;
  if (extension === 'mp4') return 'mp4';
  return fallback;
}

export interface ImportedEntry {
  readonly s: string;
  readonly kind: 'image' | 'video';
  readonly url: string;
  readonly w?: number;
  readonly h?: number;
  readonly container: ContainerFormat;
  readonly d?: number;
}

export interface InstagramSlide {
  readonly entry: ImportedEntry;
  readonly title: string;
  readonly thumbnailUrl?: string;
}

function slideFrom(node: InstagramNode, position: number): InstagramSlide | undefined {
  const video = widest(node.video_versions);
  const image = widest(node.image_versions2?.candidates);
  const alt = nonEmpty(node.accessibility_caption);
  const s = nonEmpty(node.id) ?? String(position);

  if (node.media_type === 2 && video?.url) {
    return {
      entry: {
        s,
        kind: 'video',
        url: video.url,
        ...(video.width ? { w: video.width } : {}),
        ...(video.height ? { h: video.height } : {}),
        container: containerFor(video.url, 'mp4'),
        ...(node.video_duration ? { d: node.video_duration } : {}),
      },
      title: alt ? truncate(alt, 120) : `Video ${position + 1}`,
      ...(image?.url ? { thumbnailUrl: image.url } : {}),
    };
  }

  if (!image?.url) return undefined;
  return {
    entry: {
      s,
      kind: 'image',
      url: image.url,
      ...(image.width ? { w: image.width } : {}),
      ...(image.height ? { h: image.height } : {}),
      container: containerFor(image.url, 'jpg'),
    },
    title: alt ? truncate(alt, 120) : `Image ${position + 1}`,
    thumbnailUrl: image.url,
  };
}

export function slideCount(node: InstagramNode): number {
  return node.media_type === 8 && node.carousel_media?.length ? node.carousel_media.length : 1;
}

export function slidesFrom(node: InstagramNode, limit: number): InstagramSlide[] {
  const nodes = node.media_type === 8 && node.carousel_media?.length ? node.carousel_media : [node];
  return nodes
    .slice(0, limit)
    .map((slide, position) => slideFrom(slide, position))
    .filter((slide): slide is InstagramSlide => slide !== undefined);
}

export function itemFromEntry(entry: ImportedEntry, index: number): ResolvedItem {
  const dimensions = {
    ...(entry.w ? { width: entry.w } : {}),
    ...(entry.h ? { height: entry.h } : {}),
  };
  const original: DownloadPlan = {
    kind: entry.kind,
    container: entry.container,
    label: 'Original',
    detail: [
      entry.container.toUpperCase(),
      entry.w && entry.h ? `${entry.w} × ${entry.h}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    ...dimensions,
    requiresConversion: false,
    recommended: true,
    fetch: { via: 'direct', url: entry.url },
  };
  const plans: DownloadPlan[] =
    entry.kind === 'video'
      ? [
          original,
          {
            kind: 'audio',
            container: 'mp3',
            label: 'MP3',
            detail: '320 kbps · extracted',
            audioBitrateKbps: 320,
            requiresConversion: true,
            recommended: false,
            fetch: { via: 'direct', url: entry.url },
            convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
          },
        ]
      : [original];

  return {
    sourceId: entry.s,
    index,
    kind: entry.kind,
    ...dimensions,
    ...(entry.d ? { duration: entry.d } : {}),
    container: entry.container,
    plans: ensureRecommendations(plans),
  };
}

export function itemsFrom(node: InstagramNode, limit: number): ResolvedItem[] {
  return slidesFrom(node, limit).map((slide, index) => ({
    ...itemFromEntry(slide.entry, index),
    title: slide.title,
    ...(slide.thumbnailUrl ? { thumbnailUrl: slide.thumbnailUrl } : {}),
  }));
}

export function titleFor(node: InstagramNode): { title: string; author?: string } {
  const author = nonEmpty(node.user?.full_name) ?? nonEmpty(node.user?.username);
  const caption = nonEmpty(node.caption?.text);
  return {
    title: caption ? truncate(caption, 200) : `Post by ${author ?? 'an Instagram account'}`,
    ...(author ? { author } : {}),
  };
}

export function authorUrlFor(node: InstagramNode): string | undefined {
  const username = node.user?.username;
  return username && /^[A-Za-z0-9._]{1,30}$/.test(username)
    ? `https://www.instagram.com/${username}/`
    : undefined;
}

export function shortcodeFrom(url: URL): string | undefined {
  return /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
}

export interface ImportedPost {
  readonly url: string;
  readonly title: string;
  readonly author?: string;
  readonly entries: readonly ImportedEntry[];
}

export function mediaFromImport(post: ImportedPost): ResolvedMedia {
  const items = post.entries.map((entry, index) => itemFromEntry(entry, index));
  return {
    provider: 'instagram',
    providerLabel: 'Instagram',
    url: post.url,
    type: items.length > 1 ? 'collection' : 'single',
    title: post.title,
    ...(post.author ? { author: post.author } : {}),
    items,
    metadata: { items: String(items.length), source: 'visitor-browser' },
  };
}

export interface MediaHostPolicy {
  readonly hosts: readonly string[];
  readonly requireHttps: boolean;
}

export const INSTAGRAM_MEDIA_HOSTS: MediaHostPolicy = {
  hosts: ['cdninstagram.com', 'fbcdn.net'],
  requireHttps: true,
};

export function isAllowedMediaUrl(value: string | URL, policy: MediaHostPolicy): boolean {
  let url: URL;
  try {
    url = typeof value === 'string' ? new URL(value) : value;
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (policy.requireHttps) {
    if (url.protocol !== 'https:' || url.port !== '') return false;
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }
  return hostMatchesAny(url.hostname, policy.hosts);
}

export function assertCdnHosts(urls: readonly string[], policy: MediaHostPolicy): void {
  const refused = urls.findIndex((url) => !isAllowedMediaUrl(url, policy));
  if (refused === -1) return;
  throw seraError('BLOCKED_ADDRESS', {
    message: 'That post pointed at media somewhere other than Instagram.',
    hint: 'Send the post again from instagram.com.',
    detail: `import: url ${refused} is not on the media hosts`,
  });
}

export function cdnExpiry(url: string): number | undefined {
  let oe: string | null;
  try {
    oe = new URL(url).searchParams.get('oe');
  } catch {
    return undefined;
  }
  return oe && /^[0-9a-f]{1,12}$/i.test(oe) ? Number.parseInt(oe, 16) : undefined;
}

export function importExpired(detail: string): SeraError {
  return seraError('EXPIRED', {
    message: 'The links Instagram gave your browser for this post have expired.',
    hint: 'Open the post on Instagram again and send it to SERA again.',
    detail,
  });
}

export function importRefused(detail: string): SeraError {
  return seraError('EXPIRED', {
    message: 'Instagram refused the links your browser sent for this post.',
    hint: 'They have most likely expired. Open the post on Instagram again and send it to SERA again.',
    detail,
  });
}

const IMPORT_CONTAINERS: ReadonlySet<string> = new Set(['jpg', 'png', 'webp', 'mp4']);

export function isImportedEntries(value: unknown): value is readonly ImportedEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_IMPORTED_ITEMS &&
    value.every(isImportedEntry)
  );
}

function isImportedEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.s === 'string' &&
    (entry.kind === 'image' || entry.kind === 'video') &&
    typeof entry.url === 'string' &&
    typeof entry.container === 'string' &&
    IMPORT_CONTAINERS.has(entry.container) &&
    [entry.w, entry.h, entry.d].every(
      (field) =>
        field === undefined || (typeof field === 'number' && Number.isFinite(field) && field >= 0),
    )
  );
}
