import { MAX_IMPORTED_ITEMS } from '@sera/contracts';
import type { ContainerFormat } from '@sera/contracts/types';
import { seraError, type SeraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatchesAny } from '../security/url.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { DownloadPlan, ResolvedItem, ResolvedMedia } from './types.js';

/**
 * Instagram's own web API, as two different parties read it.
 *
 * The operator's route reads a post here, with a session the operator supplied for their
 * own server; it runs only when one is configured, and without one nothing here runs and
 * photo posts are refused with an explanation. The visitor's route holds no session on this
 * side at all: the visitor's browser, already signed in to Instagram, reads the one post it
 * is showing and hands SERA the answer. Both arrive in the same shape and go through the
 * same functions below, so a photograph comes out the same whichever way it came in.
 *
 * The shape is the one gallery-dl and yt-dlp both normalize: `items[0]` with a
 * `media_type` (1 image, 2 video, 8 carousel), `carousel_media` for the slides, and
 * `image_versions2.candidates` / `video_versions` sorted widest-first on each.
 */

/** The public web client's app id. instagram.com sends this on every one of these calls. */
const APP_ID = '936619743392459';

export interface InstagramCandidate {
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface InstagramNode {
  readonly id?: string;
  /** The post's shortcode, as it appears in the post's URL. */
  readonly code?: string;
  /** 1 image, 2 video, 8 carousel. */
  readonly media_type?: number;
  readonly carousel_media?: readonly InstagramNode[];
  readonly image_versions2?: { readonly candidates?: readonly InstagramCandidate[] };
  readonly video_versions?: readonly InstagramCandidate[];
  readonly video_duration?: number;
  readonly accessibility_caption?: string;
  readonly user?: { readonly username?: string; readonly full_name?: string };
  readonly caption?: { readonly text?: string };
}

/**
 * What Instagram publishes about a post to anyone embedding it.
 *
 * The one endpoint still answering without a session. Measured against public posts on
 * 2026-09-08: it returns the caption, the account, the numeric media id, and a signed
 * thumbnail on the CDN — 640×564 for a photo post, 640×1136 for a Reel, both real JPEGs
 * of about 60 KB. The signature is on the size, so asking for a bigger one is a 403;
 * 640 is what Instagram publishes and therefore what this can honestly offer.
 */
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

/** oEmbed answers anonymously and is the only place the numeric id is published. */
export async function mediaIdFor(
  shortcode: string,
  fetchText: (url: URL, maxBytes?: number) => Promise<{ body: string }>,
): Promise<string> {
  const oembed = await oembedFor(new URL(`https://www.instagram.com/p/${shortcode}/`), fetchText);
  if (typeof oembed.media_id !== 'string') {
    throw seraError('MEDIA_UNAVAILABLE', { detail: 'instagram: oembed carried no media id' });
  }
  // `<pk>_<userId>`; the media endpoint wants the pk.
  return oembed.media_id.split('_')[0] ?? oembed.media_id;
}

/**
 * The published cover image as a one-item resolution.
 *
 * Deliberately labelled for what it is. A carousel's cover is its first slide and a
 * Reel's is a frame, so calling either "the post" would be a lie the picker then repeats
 * — the option says "Cover image" and the metadata records that this was a fallback, so
 * a report can tell the difference between a post that worked and a post that was
 * salvaged.
 */
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

/** Headers instagram.com's own web client sends. The session is one of them. */
export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    'x-ig-app-id': APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    // Sent as a cookie because that is where Instagram looks for it. Never logged.
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

/* -------------------------------------------------------------------------- */
/*  Slides                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One photograph or video, reduced to what fetching it needs.
 *
 * For the operator's route this is an intermediate step. For a post a visitor's browser
 * read, it is what the server signs into the resolution token, because a job made from that
 * post cannot read it again — nothing on this side can. Single-letter keys for that reason:
 * a carousel carries twenty of these to the browser and back.
 */
export interface ImportedEntry {
  /** Instagram's id for the slide. Option tokens name it. */
  readonly s: string;
  readonly kind: 'image' | 'video';
  /** The widest rendition, on Instagram's CDN. */
  readonly url: string;
  readonly w?: number;
  readonly h?: number;
  readonly container: ContainerFormat;
  /** Seconds, for a video, so the duration ceiling still applies at job time. */
  readonly d?: number;
}

/** A slide as read: what a job needs, and what only the person choosing sees. */
export interface InstagramSlide {
  readonly entry: ImportedEntry;
  readonly title: string;
  readonly thumbnailUrl?: string;
}

/**
 * One node — a whole post, or one slide of a carousel — as a slide.
 *
 * The candidates are sorted widest first, so the first is the original upload. `position` is
 * the slide's place in the post before empty slides are dropped.
 */
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

/** How many slides a post has, counting any that turn out to hold nothing. */
export function slideCount(node: InstagramNode): number {
  return node.media_type === 8 && node.carousel_media?.length ? node.carousel_media.length : 1;
}

/**
 * Every slide of a post, in the order Instagram lists them.
 *
 * A carousel can mix photographs and video, so nothing here assumes one kind — the
 * decision is made per slide, which is what makes a mixed post come out right.
 */
export function slidesFrom(node: InstagramNode, limit: number): InstagramSlide[] {
  const nodes = node.media_type === 8 && node.carousel_media?.length ? node.carousel_media : [node];
  return nodes
    .slice(0, limit)
    .map((slide, position) => slideFrom(slide, position))
    .filter((slide): slide is InstagramSlide => slide !== undefined);
}

/**
 * What one slide offers, and the only place that is decided.
 *
 * A pure function of the entry. That is what lets a job rebuild exactly the options a
 * visitor chose from without asking Instagram again: the same entry in, the same plan keys
 * out. A photograph is offered as itself and nothing else; a video also gets its audio.
 */
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

/** Every slide of a post as SERA items, titled and with thumbnails, for the operator's route. */
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

/** The account's page, when the username is one Instagram could have issued. */
export function authorUrlFor(node: InstagramNode): string | undefined {
  const username = node.user?.username;
  return username && /^[A-Za-z0-9._]{1,30}$/.test(username)
    ? `https://www.instagram.com/${username}/`
    : undefined;
}

/** The shortcode, from any of the paths Instagram serves a post at. */
export function shortcodeFrom(url: URL): string | undefined {
  return /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
}

/* -------------------------------------------------------------------------- */
/*  A post the visitor's browser read                                         */
/* -------------------------------------------------------------------------- */

/** An imported post as the server approved it: everything a job needs, and nothing else. */
export interface ImportedPost {
  /** The post's canonical URL. */
  readonly url: string;
  readonly title: string;
  readonly author?: string;
  readonly entries: readonly ImportedEntry[];
}

/**
 * The resolution an imported post stands for.
 *
 * Pure — no clock, no network, nothing random — and called twice: when the post arrives, to
 * build the options the visitor chooses from, and when the job runs, to find the plans those
 * options name. The same signed entries in, the same plan keys out, which is what makes a job
 * that cannot re-resolve safe to match against.
 */
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

/**
 * Where an imported post's media may be fetched from.
 *
 * The check that turns "a browser sent this" into "SERA will fetch this". Whatever a payload
 * says, the only URLs admitted are HTTPS on Instagram's own CDN hosts, with no port and no
 * credentials — so the most a forged payload can do is have SERA fetch something from
 * Instagram's CDN that its sender already held a signed link to.
 */
export interface MediaHostPolicy {
  /** Registrable domains; their subdomains match too. */
  readonly hosts: readonly string[];
  /** HTTPS on the default port. Only a test against a loopback origin turns this off. */
  readonly requireHttps: boolean;
}

/** Photographs come from `scontent-*.cdninstagram.com`; video can also come from `*.fbcdn.net`. */
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

/** Throws unless every URL is one `policy` admits. The API counts the refusal as abuse. */
export function assertCdnHosts(urls: readonly string[], policy: MediaHostPolicy): void {
  const refused = urls.findIndex((url) => !isAllowedMediaUrl(url, policy));
  if (refused === -1) return;
  throw seraError('BLOCKED_ADDRESS', {
    message: 'That post pointed at media somewhere other than Instagram.',
    hint: 'Send the post again from instagram.com.',
    // Which one, not what it said: this detail reaches the log, and the URL must not.
    detail: `import: url ${refused} is not on the media hosts`,
  });
}

/**
 * When Instagram's CDN stops honouring a URL, in epoch seconds.
 *
 * Every signed media URL carries it as `oe`, in hex, and the signature covers it — measured:
 * changing `oe` turns a 200 into a 403. Undefined when a URL has none.
 */
export function cdnExpiry(url: string): number | undefined {
  let oe: string | null;
  try {
    oe = new URL(url).searchParams.get('oe');
  } catch {
    return undefined;
  }
  return oe && /^[0-9a-f]{1,12}$/i.test(oe) ? Number.parseInt(oe, 16) : undefined;
}

/** What an imported post says once the links Instagram signed into it have run out. */
export function importExpired(detail: string): SeraError {
  return seraError('EXPIRED', {
    message: 'The links Instagram gave your browser for this post have expired.',
    hint: 'Open the post on Instagram again and send it to SERA again.',
    detail,
  });
}

/** What a job says when Instagram's CDN refuses one of those links outright. */
export function importRefused(detail: string): SeraError {
  return seraError('EXPIRED', {
    message: 'Instagram refused the links your browser sent for this post.',
    hint: 'They have most likely expired. Open the post on Instagram again and send it to SERA again.',
    detail,
  });
}

const IMPORT_CONTAINERS: ReadonlySet<string> = new Set(['jpg', 'png', 'webp', 'mp4']);

/**
 * Whether a value is a list of entries this server could have signed.
 *
 * A token's signature already says it came from here. This is what keeps one minted by an
 * older build, or by a bug, from reaching the runner in a shape the runner does not expect.
 */
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
