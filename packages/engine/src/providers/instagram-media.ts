import type { ContainerFormat } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { DownloadPlan, ResolvedItem } from './types.js';

/**
 * Instagram's own web API, read with a session the operator supplied for their server.
 *
 * This is the endpoint instagram.com itself calls, with the headers it sends. It is used
 * only when a session is configured; without one nothing here runs and photo posts are
 * refused with an explanation, which is the default.
 *
 * The shape it returns is the one gallery-dl and yt-dlp both normalize: `items[0]` with a
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

/** oEmbed answers anonymously and is the only place the numeric id is published. */
export async function mediaIdFor(
  shortcode: string,
  fetchText: (url: URL, maxBytes?: number) => Promise<{ body: string }>,
): Promise<string> {
  const endpoint = new URL('https://www.instagram.com/api/v1/oembed/');
  endpoint.searchParams.set('url', `https://www.instagram.com/p/${shortcode}/`);
  const { body } = await fetchText(endpoint, 256 * 1024);
  const mediaId = (JSON.parse(body) as { media_id?: unknown }).media_id;
  if (typeof mediaId !== 'string') {
    throw seraError('MEDIA_UNAVAILABLE', { detail: 'instagram: oembed carried no media id' });
  }
  // `<pk>_<userId>`; the media endpoint wants the pk.
  return mediaId.split('_')[0] ?? mediaId;
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

/**
 * One node — a whole post, or one slide of a carousel — as a SERA item.
 *
 * The candidates are sorted widest first, so the first is the original upload. A
 * photograph is offered as itself and nothing else; a video also gets its audio.
 */
function toItem(node: InstagramNode, index: number): ResolvedItem | undefined {
  const video = widest(node.video_versions);
  const image = widest(node.image_versions2?.candidates);
  const alt = nonEmpty(node.accessibility_caption);

  if (node.media_type === 2 && video?.url) {
    const container = containerFor(video.url, 'mp4');
    const plans: DownloadPlan[] = [
      {
        kind: 'video',
        container,
        label: 'Original',
        detail: [
          container.toUpperCase(),
          video.width && video.height ? `${video.width} × ${video.height}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        ...(video.width ? { width: video.width } : {}),
        ...(video.height ? { height: video.height } : {}),
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct', url: video.url },
      },
      {
        kind: 'audio',
        container: 'mp3',
        label: 'MP3',
        detail: '320 kbps · extracted',
        audioBitrateKbps: 320,
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: video.url },
        convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
      },
    ];
    return {
      sourceId: nonEmpty(node.id) ?? String(index),
      index,
      kind: 'video',
      title: alt ? truncate(alt, 120) : `Video ${index + 1}`,
      ...(image?.url ? { thumbnailUrl: image.url } : {}),
      ...(video.width ? { width: video.width } : {}),
      ...(video.height ? { height: video.height } : {}),
      ...(node.video_duration ? { duration: node.video_duration } : {}),
      container,
      plans: ensureRecommendations(plans),
    };
  }

  if (!image?.url) return undefined;
  const container = containerFor(image.url, 'jpg');
  return {
    sourceId: nonEmpty(node.id) ?? String(index),
    index,
    kind: 'image',
    title: alt ? truncate(alt, 120) : `Image ${index + 1}`,
    thumbnailUrl: image.url,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    container,
    plans: ensureRecommendations([
      {
        kind: 'image',
        container,
        label: 'Original',
        detail: [
          container.toUpperCase(),
          image.width && image.height ? `${image.width} × ${image.height}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct', url: image.url },
      },
    ]),
  };
}

/**
 * Every slide of a post, in the order Instagram lists them.
 *
 * A carousel can mix photographs and video, so nothing here assumes one kind — the
 * decision is made per slide, which is what makes a mixed post come out right.
 */
export function itemsFrom(node: InstagramNode, limit: number): ResolvedItem[] {
  const nodes = node.media_type === 8 && node.carousel_media?.length ? node.carousel_media : [node];
  return nodes
    .slice(0, limit)
    .map((entry, index) => toItem(entry, index))
    .filter((item): item is ResolvedItem => item !== undefined)
    .map((item, index) => ({ ...item, index }));
}

export function titleFor(node: InstagramNode): { title: string; author?: string } {
  const author = nonEmpty(node.user?.full_name) ?? nonEmpty(node.user?.username);
  const caption = nonEmpty(node.caption?.text);
  return {
    title: caption ? truncate(caption, 200) : `Post by ${author ?? 'an Instagram account'}`,
    ...(author ? { author } : {}),
  };
}
