import type { ContainerFormat, MediaInfoType, ProviderCapabilities } from '@sera/contracts/types';
import { subtitleTracks } from './subtitles.js';
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
import { runStrategies, type ExtractionStrategy } from '../extract/strategy.js';
import { hostMatchesAny } from '../security/url.js';
import { truncate } from '../util/format.js';
import type {
  DownloadPlan,
  MediaProvider,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './types.js';

export abstract class YtdlpProvider implements MediaProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly hosts: readonly string[];
  readonly priority: number = 100;

  readonly capabilities: ProviderCapabilities = declare();

  canHandle(_url: URL, host: string): boolean {
    return hostMatchesAny(host, this.hosts);
  }

  normalize(url: URL): URL {
    return url;
  }

  protected wantsPlaylist(_url: URL): boolean {
    return false;
  }

  protected extractorArgs(_url: URL, _context: ProviderContext): readonly string[] {
    return [];
  }

  protected treatsSilentShortVideoAsGif(): boolean {
    return false;
  }

  protected multiItemType(_url: URL): MediaInfoType {
    return 'collection';
  }

  protected strategies(_url: URL, _context: ProviderContext): readonly ExtractionStrategy[] {
    return [
      {
        id: 'ytdlp',
        label: 'the extractor',
        run: (target, context) => this.runExtractor(target, context),
      },
    ];
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const ladder = this.strategies(url, context);
    if (ladder.length === 1) return ladder[0]!.run(url, context);

    const outcome = await runStrategies(ladder, url, context, {
      provider: this.id,
      logger: context.logger,
      includeDegraded: context.allowDegraded === true,
    });
    return outcome.attempts.length
      ? {
          ...outcome.media,
          metadata: { ...outcome.media.metadata, extractionStrategy: outcome.strategy },
        }
      : outcome.media;
  }

  protected async runExtractor(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const proxy = context.config.proxyFor(this.id);
    const info = await context.probe(url.toString(), {
      playlist: this.wantsPlaylist(url),
      extractorArgs: this.extractorArgs(url, context),
      timeoutMs: context.config.resolveTimeoutMsFor(this.id),
      ...(proxy ? { proxy } : {}),
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
    const thumbnailFallbackUrl = str(entry.thumbnail);
    const subtitles = kind === 'video' || kind === 'audio' ? subtitleTracks(entry) : [];
    const title = str(entry.title);
    const filesize = num(entry.filesize) ?? num(entry.filesize_approx);
    const sourceId = str(entry.id);
    const tags = {
      ...(str(entry.artist) ? { artist: str(entry.artist)! } : {}),
      ...(str(entry.album) ? { album: str(entry.album)! } : {}),
      ...(str(entry.track) ? { track: str(entry.track)! } : {}),
    };

    return {
      ...(sourceId ? { sourceId } : {}),
      index,
      kind,
      ...(title ? { title } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(thumbnailFallbackUrl && thumbnailFallbackUrl !== thumbnailUrl
        ? { thumbnailFallbackUrl }
        : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      ...(subtitles.length ? { subtitles } : {}),
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

export function collectEntries(info: YtdlpInfo): YtdlpInfo[] {
  if (!info.entries?.length) return [info];
  const out: YtdlpInfo[] = [];
  for (const entry of info.entries) {
    if (!entry) continue;
    if (entry.entries?.length) {
      for (const nested of entry.entries) if (nested) out.push(nested);
    } else {
      out.push(entry);
    }
  }
  return out.length ? out : [info];
}

export function pickThumbnail(info: YtdlpInfo): string | undefined {
  const direct = str(info.thumbnail);
  const candidates = (info.thumbnails ?? []).filter((t): t is YtdlpThumbnail & { url: string } =>
    Boolean(t?.url),
  );
  if (!candidates.length) return direct;

  const score = (t: YtdlpThumbnail & { url: string }): number => {
    const width = num(t.width) ?? 0;
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
