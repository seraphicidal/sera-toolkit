import * as cheerio from 'cheerio';
import type { MediaKind } from '@sera/contracts/types';
import { MEDIA_EXTENSIONS, urlExtension } from '../security/url.js';

/**
 * Finds media a page publishes about itself.
 *
 * This reads only what a page already declares for embeds and previews — OpenGraph
 * tags, media elements, and schema.org metadata. It does not follow links, execute
 * scripts, or guess at URLs, so a page that publishes nothing yields nothing rather
 * than triggering a crawl.
 */

export interface DiscoveredMedia {
  readonly url: string;
  readonly kind: MediaKind;
  /** Where it was found, ordered by how much the page is asserting it is the media. */
  readonly source:
    'og:video' | 'twitter:player' | 'video' | 'audio' | 'json-ld' | 'og:image' | 'link';
  readonly width?: number;
  readonly height?: number;
  readonly mimeType?: string;
}

export interface PageMedia {
  readonly title?: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly author?: string;
  readonly thumbnail?: string;
  readonly media: readonly DiscoveredMedia[];
}

/** Ranks discovery sources; a declared video beats a preview image. */
const SOURCE_RANK: Record<DiscoveredMedia['source'], number> = {
  'og:video': 0,
  'twitter:player': 1,
  video: 2,
  audio: 3,
  'json-ld': 4,
  'og:image': 5,
  link: 6,
};

interface JsonLdNode {
  '@type'?: string | string[];
  contentUrl?: string;
  embedUrl?: string;
  thumbnailUrl?: string | string[];
  name?: string;
  description?: string;
  author?: { name?: string } | string;
  '@graph'?: JsonLdNode[];
  video?: JsonLdNode | JsonLdNode[];
}

function absolute(candidate: string | undefined, base: URL): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return undefined;
  try {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function kindFromUrl(url: string, hint: MediaKind): MediaKind {
  try {
    const extension = urlExtension(new URL(url));
    if (!extension || !MEDIA_EXTENSIONS.has(extension)) return hint;
    if (extension === 'gif') return 'gif';
    if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic'].includes(extension)) {
      return 'image';
    }
    if (['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'wma'].includes(extension)) {
      return 'audio';
    }
    return 'video';
  } catch {
    return hint;
  }
}

/** Parses a page and returns whatever media it declares. */
export function discoverMedia(html: string, pageUrl: URL): PageMedia {
  const $ = cheerio.load(html);
  const found: DiscoveredMedia[] = [];
  const seen = new Set<string>();

  const add = (
    rawUrl: string | undefined,
    source: DiscoveredMedia['source'],
    hint: MediaKind,
    extra: { width?: number; height?: number; mimeType?: string } = {},
  ): void => {
    const url = absolute(rawUrl, pageUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push({
      url,
      kind: kindFromUrl(url, hint),
      source,
      ...(extra.width ? { width: extra.width } : {}),
      ...(extra.height ? { height: extra.height } : {}),
      ...(extra.mimeType ? { mimeType: extra.mimeType } : {}),
    });
  };

  const meta = (property: string): string | undefined =>
    $(`meta[property="${property}"]`).attr('content') ??
    $(`meta[name="${property}"]`).attr('content');

  const numericMeta = (property: string): number | undefined => {
    const value = Number(meta(property));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  // OpenGraph video, the strongest signal a page can give about its own media.
  const ogVideoSize = {
    width: numericMeta('og:video:width'),
    height: numericMeta('og:video:height'),
  };
  for (const property of ['og:video:secure_url', 'og:video:url', 'og:video']) {
    const value = meta(property);
    if (value) {
      add(value, 'og:video', 'video', {
        ...(ogVideoSize.width ? { width: ogVideoSize.width } : {}),
        ...(ogVideoSize.height ? { height: ogVideoSize.height } : {}),
        ...(meta('og:video:type') ? { mimeType: meta('og:video:type')! } : {}),
      });
    }
  }
  add(meta('twitter:player:stream'), 'twitter:player', 'video');

  $('video').each((_, element) => {
    const node = $(element);
    add(node.attr('src'), 'video', 'video');
    node.find('source').each((__, sourceElement) => {
      const source = $(sourceElement);
      add(source.attr('src'), 'video', 'video', {
        ...(source.attr('type') ? { mimeType: source.attr('type')! } : {}),
      });
    });
  });

  $('audio').each((_, element) => {
    const node = $(element);
    add(node.attr('src'), 'audio', 'audio');
    node.find('source').each((__, sourceElement) => {
      const source = $(sourceElement);
      add(source.attr('src'), 'audio', 'audio', {
        ...(source.attr('type') ? { mimeType: source.attr('type')! } : {}),
      });
    });
  });

  // schema.org VideoObject, which many CMS templates emit even without OpenGraph tags.
  const jsonLd: JsonLdNode[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw || raw.length > 512 * 1024) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (node && typeof node === 'object') jsonLd.push(node as JsonLdNode);
      }
    } catch {
      // A page with malformed JSON-LD is common and not worth failing the resolve over.
    }
  });

  const visitLd = (node: JsonLdNode, depth = 0): void => {
    if (depth > 3) return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((t) => t === 'VideoObject' || t === 'AudioObject')) {
      add(node.contentUrl, 'json-ld', types.includes('AudioObject') ? 'audio' : 'video');
    }
    for (const child of node['@graph'] ?? []) visitLd(child, depth + 1);
    const nested = node.video;
    for (const child of Array.isArray(nested) ? nested : nested ? [nested] : []) {
      visitLd(child, depth + 1);
    }
  };
  for (const node of jsonLd) visitLd(node);

  // A preview image is media in its own right when the page has nothing better.
  add(meta('og:image:secure_url') ?? meta('og:image'), 'og:image', 'image', {
    ...(numericMeta('og:image:width') ? { width: numericMeta('og:image:width')! } : {}),
    ...(numericMeta('og:image:height') ? { height: numericMeta('og:image:height')! } : {}),
  });
  add($('link[rel="image_src"]').attr('href'), 'link', 'image');

  const ldTitle = jsonLd.find((n) => n.name)?.name;
  const ldAuthor = jsonLd.find((n) => n.author)?.author;

  const title = meta('og:title') ?? ($('title').first().text().trim() || undefined);
  const description = meta('og:description') ?? meta('description');
  const siteName = meta('og:site_name');
  const author =
    meta('author') ??
    (typeof ldAuthor === 'string' ? ldAuthor : ldAuthor?.name) ??
    siteName ??
    pageUrl.hostname;
  const thumbnail = absolute(meta('og:image:secure_url') ?? meta('og:image'), pageUrl);

  return {
    ...((title ?? ldTitle) ? { title: (title ?? ldTitle)!.trim() } : {}),
    ...(description ? { description: description.trim() } : {}),
    ...(siteName ? { siteName } : {}),
    ...(author ? { author } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    media: found.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]),
  };
}
