import type { ContainerFormat, MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { seraError } from '../errors.js';
import type { YtdlpInfo, YtdlpThumbnail } from '../extract/ytdlp-types.js';
import { num, str } from '../extract/ytdlp-types.js';
import { toUsableFormats } from '../normalize/formats.js';
import {
  buildAlternateContainerPlans,
  buildAudioPlans,
  buildGifPlans,
  buildImagePlans,
  buildVideoPlans,
  ensureRecommendations,
  kindOf,
  type PlanBuildOptions,
} from '../normalize/plans.js';
import { hostMatchesAny } from '../security/url.js';
import { truncate } from '../util/format.js';
import type {
  DownloadPlan,
  MediaProvider,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './types.js';

/**
 * The shared implementation nearly every provider is built from.
 *
 * yt-dlp already normalizes several hundred sites into one metadata shape, so a provider
 * that adds nothing beyond a host list is three lines. Subclasses override only where a
 * platform genuinely differs: how a carousel is exposed, whether a playlist should be
 * expanded, or what a "GIF" means on that site.
 */
export abstract class YtdlpProvider implements MediaProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly hosts: readonly string[];
  readonly priority: number = 100;

  /**
   * What most extractor-backed providers do. A provider whose platform differs — photos
   * it cannot reach, audio it has none of — overrides this rather than leaving the
   * client to find out one link at a time.
   */
  readonly capabilities: ProviderCapabilities = declare();

  canHandle(_url: URL, host: string): boolean {
    return hostMatchesAny(host, this.hosts);
  }

  /** Identity by default; subclasses canonicalize the URL forms their platform serves. */
  normalize(url: URL): URL {
    return url;
  }

  /** Whether a URL should be expanded into its entries rather than treated as one item. */
  protected wantsPlaylist(_url: URL): boolean {
    return false;
  }

  /**
   * Site-specific tuning passed to yt-dlp as `--extractor-args`.
   *
   * These were declared by providers and then dropped on the floor: nothing forwarded
   * them to the probe, so YouTube's own comment about keeping 1080p visible described
   * something that was not happening.
   */
  protected extractorArgs(_url: URL, _context: ProviderContext): readonly string[] {
    return [];
  }

  /** Hook for platforms whose "GIF" posts are really short silent videos. */
  protected treatsSilentShortVideoAsGif(): boolean {
    return false;
  }

  /**
   * What a multi-entry result means for this URL.
   *
   * yt-dlp represents both an Instagram carousel and a YouTube playlist as `_type:
   * "playlist"`, but they are different things to a person: a carousel is one post with
   * several attachments, while a playlist is a list of separate works. Providers that
   * expand true playlists override this; carousels keep the default.
   */
  protected multiItemType(_url: URL): MediaInfoType {
    return 'collection';
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const info = await context.probe(url.toString(), {
      playlist: this.wantsPlaylist(url),
      extractorArgs: this.extractorArgs(url, context),
      timeoutMs: context.config.resolveTimeoutMsFor(this.id),
    });
    return this.toResolvedMedia(info, url, context);
  }

  protected toResolvedMedia(info: YtdlpInfo, url: URL, context: ProviderContext): ResolvedMedia {
    const planOptions: PlanBuildOptions = {
      maxFilesizeBytes: context.config.maxFilesizeBytes,
    };

    const entries = collectEntries(info);
    const items: ResolvedItem[] = [];

    entries.forEach((entry, index) => {
      const item = this.toItem(entry, index, planOptions);
      if (item) items.push(item);
    });

    // The tuning that produced this format list has to produce the download too.
    //
    // These were reaching the probe and stopping there: a provider could ask for the
    // player clients that expose 1080p, list them for the visitor, and then fetch with
    // whatever the extractor defaults to — a different client, a different format list,
    // and for YouTube a different answer about whether the request is allowed at all.
    // The args travel with the plan so both halves of a job agree.
    const args = this.extractorArgs(url, context);
    if (args.length) {
      for (const [index, item] of items.entries()) {
        items[index] = {
          ...item,
          plans: item.plans.map((plan) =>
            plan.fetch.via === 'ytdlp'
              ? { ...plan, fetch: { ...plan.fetch, extractorArgs: args } }
              : plan,
          ),
        };
      }
    }

    if (!items.length) {
      throw seraError('MEDIA_UNAVAILABLE', {
        message: 'No downloadable media was found at that link.',
        hint: 'If the post is public, it may use a format this server cannot read.',
        detail: `${this.id}: 0 usable items from ${entries.length} entries`,
      });
    }

    const duration = num(info.duration) ?? items[0]?.duration;
    const type: MediaInfoType = items.length > 1 ? this.multiItemType(url) : 'single';

    const author =
      str(info.uploader) ?? str(info.channel) ?? str(info.creator) ?? str(info.uploader_id);
    const authorUrl = str(info.uploader_url) ?? str(info.channel_url);
    const thumbnail = pickThumbnail(info) ?? items.find((i) => i.thumbnailUrl)?.thumbnailUrl;
    const createdAt = parseTimestamp(info);
    const description = str(info.description);

    return {
      provider: this.id,
      providerLabel: this.label,
      url: str(info.webpage_url) ?? url.toString(),
      type,
      title: str(info.title) ?? str(info.fulltitle) ?? this.fallbackTitle(url),
      ...(description ? { description: truncate(description, 500) } : {}),
      ...(author ? { author } : {}),
      ...(authorUrl ? { authorUrl } : {}),
      ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(createdAt ? { createdAt } : {}),
      items,
      ...(buildMetadata(info) ? { metadata: buildMetadata(info)! } : {}),
    };
  }

  /** Turns one yt-dlp entry into an item with its full option list. */
  protected toItem(
    entry: YtdlpInfo,
    index: number,
    planOptions: PlanBuildOptions,
  ): ResolvedItem | undefined {
    const kind = kindOf(entry);
    const formats = toUsableFormats(entry.formats);
    const duration = num(entry.duration);
    const plans: DownloadPlan[] = [];

    if (kind === 'image') {
      plans.push(...buildImagePlans(entry, str(entry.url)));
    } else if (kind === 'gif') {
      const videoPlans = buildVideoPlans(formats, duration, planOptions);
      plans.push(...buildGifPlans(true, videoPlans, duration, planOptions));
    } else if (kind === 'video') {
      const videoPlans = buildVideoPlans(formats, duration, planOptions);
      plans.push(...videoPlans);
      plans.push(...buildAlternateContainerPlans(videoPlans[0]));
      plans.push(...buildAudioPlans(formats, duration, planOptions));

      const silent = formats.length > 0 && formats.every((f) => !f.hasAudio);
      if (this.treatsSilentShortVideoAsGif() && silent) {
        plans.push(...buildGifPlans(false, videoPlans, duration, planOptions));
      }
    } else if (kind === 'audio') {
      plans.push(...buildAudioPlans(formats, duration, planOptions));
    }

    if (!plans.length) return undefined;

    const width = num(entry.width) ?? plans.find((p) => p.width)?.width;
    const height = num(entry.height) ?? plans.find((p) => p.height)?.height;
    const container = (str(entry.ext) ?? plans[0]?.container) as ContainerFormat | undefined;
    const thumbnailUrl = pickThumbnail(entry);
    const title = str(entry.title);
    const filesize = num(entry.filesize) ?? num(entry.filesize_approx);
    const sourceId = str(entry.id);

    return {
      ...(sourceId ? { sourceId } : {}),
      index,
      kind,
      ...(title ? { title } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(container ? { container } : {}),
      ...(filesize !== undefined ? { filesizeBytes: filesize } : {}),
      ...(entry.is_live ? { isLive: true } : {}),
      plans: ensureRecommendations(plans),
    };
  }

  protected fallbackTitle(url: URL): string {
    const segment = url.pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment).replace(/[-_]+/g, ' ') : this.label;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers shared by every provider                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flattens an info object into the entries that carry media.
 *
 * A carousel arrives as a playlist of entries; a plain video arrives as one object with
 * no entries at all. Treating both as "a list of things to offer" is what lets one code
 * path serve a single MP4 and a four-item Instagram post.
 */
export function collectEntries(info: YtdlpInfo): YtdlpInfo[] {
  if (!info.entries?.length) return [info];
  const out: YtdlpInfo[] = [];
  for (const entry of info.entries) {
    if (!entry) continue;
    // Nested playlists appear on channel pages; one level of flattening is enough.
    if (entry.entries?.length) {
      for (const nested of entry.entries) if (nested) out.push(nested);
    } else {
      out.push(entry);
    }
  }
  return out.length ? out : [info];
}

/**
 * Chooses a thumbnail that is large enough to look sharp but small enough to fetch
 * quickly, preferring yt-dlp's own ranking when it supplies one.
 */
export function pickThumbnail(info: YtdlpInfo): string | undefined {
  const direct = str(info.thumbnail);
  const candidates = (info.thumbnails ?? []).filter((t): t is YtdlpThumbnail & { url: string } =>
    Boolean(t?.url),
  );
  if (!candidates.length) return direct;

  const score = (t: YtdlpThumbnail & { url: string }): number => {
    const width = num(t.width) ?? 0;
    // 640px covers the preview card on a high-DPI display without fetching a poster.
    const distance = Math.abs(width - 640);
    return (num(t.preference) ?? 0) * 1000 - distance;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0]?.url ?? direct;
}

export function parseTimestamp(info: YtdlpInfo): string | undefined {
  const epoch = num(info.timestamp) ?? num(info.release_timestamp);
  if (epoch) return new Date(epoch * 1000).toISOString();
  const uploadDate = str(info.upload_date);
  if (uploadDate && /^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
  }
  return undefined;
}

/** A small, non-identifying set of facts worth showing on the preview card. */
export function buildMetadata(
  info: YtdlpInfo,
): Record<string, string | number | boolean> | undefined {
  const metadata: Record<string, string | number | boolean> = {};
  const views = num(info.view_count);
  const likes = num(info.like_count);
  if (views) metadata.viewCount = views;
  if (likes) metadata.likeCount = likes;
  if (info.was_live) metadata.wasLive = true;
  const extractor = str(info.extractor_key) ?? str(info.extractor);
  if (extractor) metadata.extractor = extractor;
  return Object.keys(metadata).length ? metadata : undefined;
}
