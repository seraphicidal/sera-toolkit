import type { ContainerFormat } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { nonEmpty, truncate } from '../util/format.js';
import type { ResolvedItem, ResolvedMedia } from './types.js';

/**
 * A Reddit post, read the way any site embedding it reads one.
 *
 * Reddit refuses hosted address ranges — measured from this deployment, every anonymous
 * route to the *data* answers 403: `www.reddit.com/…/.json`, `api.reddit.com`,
 * `old.reddit.com`, the bare comments JSON. That is Reddit's documented position for
 * servers and this does not argue with it.
 *
 * What is *not* refused is the embed. `embed.reddit.com`, `www.reddit.com/oembed` and the
 * `.rss` feed all answer 200 from the same blocked address, because they are what Reddit
 * publishes for anyone quoting a post on their own site — the same thing a WordPress
 * plugin or a news article receives. So does `i.redd.it`, and so do the `v.redd.it`
 * streaming manifests; only the progressive MP4 is refused.
 *
 * That is enough to read a public post completely, with no account and no application
 * registration:
 *
 * - **oEmbed** gives the title and the author.
 * - **The embed page** carries a `<shreddit-screenview-data>` element whose `data`
 *   attribute is JSON: the post's type and its media URL. Galleries list each image.
 * - **Video** goes through `HLSPlaylist.m3u8`, which yt-dlp resolves — measured at 1280p
 *   with audio, from the blocked address.
 *
 * The OAuth path stays and stays first when it is configured: it is the supported API,
 * it sees more, and an operator who registered an app should get what they paid attention
 * for. This is what happens when nobody has.
 */

/** Reddit's own agent rules ask for something that names the app and its version. */
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

/** HTML attribute escaping, reversed. The blob arrives inside a double-quoted attribute. */
function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The embed host serves the same path as the canonical one. */
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

/**
 * Every image the page names, in the order it names them.
 *
 * Document order is the gallery's order — the same reason the carousel providers keep
 * theirs. `preview.redd.it` is deliberately excluded: it is a resized variant of an
 * image already listed, and it is the one host of Reddit's that answers 403 here anyway.
 */
export function imagesFrom(html: string): string[] {
  return [
    ...new Set([...html.matchAll(/https:\/\/i\.redd\.it\/[A-Za-z0-9._-]+/g)].map((m) => m[0])),
  ];
}

/**
 * The `v.redd.it` base, when the URL *is* one.
 *
 * Both the bare form and any of the manifests hanging off it, so the same function
 * answers whether the pipeline is holding the link a visitor pasted or the one this
 * provider handed back.
 */
export function videoBaseFromUrl(url: URL): string | undefined {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'v.redd.it') return undefined;
  const id = url.pathname.split('/').find(Boolean);
  return id && /^[A-Za-z0-9]+$/.test(id) ? `https://v.redd.it/${id}` : undefined;
}

/** The hosted-video id, from which the manifests hang. */
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

/**
 * The video item, pointed at the manifest rather than the file.
 *
 * The progressive MP4 is the one thing on `v.redd.it` this host is refused, and the
 * manifest is also the only route that carries the audio Reddit stores as a separate
 * stream. So both reasons point the same way.
 */
function videoItem(base: string): ResolvedItem {
  const manifest = `${base}/HLSPlaylist.m3u8`;
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
    metadata: { manifest },
  } as ResolvedItem;
}

/**
 * Reads a post from what Reddit publishes for embedding.
 *
 * `fetchText` is the engine's guarded client, so this inherits the address checks, the
 * redirect rules and the size ceiling that everything else here gets.
 */
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

  // A resolution has to survive being resolved again.
  //
  // The handle a job carries holds `resolved.url`, and for hosted video that is the
  // manifest rather than the post — it has to be, because the post page is refused to
  // this address and the progressive file is too. So at download time the pipeline asks
  // this provider to read a `v.redd.it` URL, which is not a post and has no embed. It
  // used to answer "no post id" and the job died at the last step with a message about
  // the media being gone, which was true of nothing.
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
    // The runner hands this to the extractor, and for hosted video it has to be the
    // manifest: the post page is refused to this host and the file is too.
    extractFrom = `${videoBase}/HLSPlaylist.m3u8`;
  } else if (images.length) {
    items = images.slice(0, limit).map((image, index) => imageItem(image, index));
  } else {
    throw seraError('MEDIA_UNAVAILABLE', {
      message: 'That post has no media to download.',
      detail: `reddit: the embed named no media (type ${screenview?.post?.type ?? 'unknown'})`,
    });
  }

  // Title and author come from oEmbed, which is a small JSON document rather than the
  // 350 KB script shell the embed page is. A failure here costs a nicer name, not the
  // download, so it is not allowed to fail the resolution.
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
