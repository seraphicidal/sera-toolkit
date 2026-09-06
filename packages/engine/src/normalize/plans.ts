import type { ContainerFormat, MediaKind } from '@sera/contracts/types';
import type { YtdlpInfo } from '../extract/ytdlp-types.js';
import { num, str } from '../extract/ytdlp-types.js';
import type { DownloadPlan } from '../providers/types.js';
import { codecLabel, formatBytes, qualityLabel } from '../util/format.js';
import {
  audioBitrateChoices,
  bestAudio,
  bestVideoPerHeight,
  estimateSize,
  fitsInMp4,
  nativeContainer,
  splitFormats,
  toUsableFormats,
  type UsableFormat,
} from './formats.js';

/**
 * Builds the list of things a user can ask for, from one yt-dlp entry.
 *
 * The guiding rule is that every row must mean something different. A second row is
 * worth adding only when it changes the resolution, the container, or the bitrate in a
 * way the person would notice — anything else is menu noise dressed up as choice.
 */

export interface PlanBuildOptions {
  /** Above this, a video is not offered as a GIF; the output would be unusable anyway. */
  readonly maxGifDurationSeconds?: number;
  /** Ceiling from configuration; larger renditions are dropped rather than offered. */
  readonly maxFilesizeBytes?: number;
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'bmp',
  'heic',
  'tif',
  'tiff',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'wma']);

/** Classifies an entry, which is what decides the whole shape of its option list. */
export function kindOf(info: YtdlpInfo): MediaKind {
  const ext = (str(info.ext) ?? '').toLowerCase();
  if (ext === 'gif') return 'gif';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';

  const formats = toUsableFormats(info.formats);
  if (formats.length) {
    const { videoOnly, progressive, audioOnly } = splitFormats(formats);
    if (videoOnly.length || progressive.length) {
      // A "video" with a single frame and no audio is a still image behind a video URL.
      const onlyImages = formats.every((f) => IMAGE_EXTENSIONS.has(f.ext));
      return onlyImages ? 'image' : 'video';
    }
    if (audioOnly.length) return 'audio';
  }

  const vcodec = str(info.vcodec);
  const acodec = str(info.acodec);
  if (vcodec && vcodec !== 'none') return 'video';
  if (acodec && acodec !== 'none') return 'audio';
  return 'unknown';
}

function sizeDetail(bytes: number | undefined, approximate: boolean): string | undefined {
  if (!bytes) return undefined;
  return `${approximate ? '~' : ''}${formatBytes(bytes)}`;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(' · ') : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Video                                                                     */
/* -------------------------------------------------------------------------- */

interface VideoPlanInput {
  readonly video: UsableFormat;
  readonly audio?: UsableFormat;
  readonly container: ContainerFormat;
  readonly duration?: number;
  readonly recommended: boolean;
}

function makeVideoPlan(input: VideoPlanInput): DownloadPlan {
  const { video, audio, container } = input;
  const videoSize = estimateSize(video, input.duration);
  const audioSize = audio ? estimateSize(audio, input.duration) : 0;
  const total = videoSize !== undefined ? videoSize + (audioSize ?? 0) : undefined;
  const approximate = video.filesizeIsApproximate || (audio?.filesizeIsApproximate ?? false);

  const selector = audio ? `${video.id}+${audio.id}` : video.id;
  const vLabel = codecLabel(video.vcodec);
  const aLabel = codecLabel(audio?.acodec ?? video.acodec);
  const detail = joinDetail(
    container.toUpperCase(),
    vLabel && aLabel ? `${vLabel} + ${aLabel}` : (vLabel ?? aLabel),
    video.fps && video.fps >= 50 ? `${video.fps} fps` : undefined,
    sizeDetail(total, approximate),
  );

  return {
    kind: 'video',
    container,
    label: qualityLabel(video.height, video.width),
    ...(detail ? { detail } : {}),
    ...(video.width ? { width: video.width } : {}),
    ...(video.height ? { height: video.height } : {}),
    ...(video.fps ? { fps: video.fps } : {}),
    ...(video.vcodec ? { videoCodec: video.vcodec } : {}),
    ...((audio?.acodec ?? video.acodec) ? { audioCodec: (audio?.acodec ?? video.acodec)! } : {}),
    ...(total !== undefined ? { filesizeBytes: total } : {}),
    ...(total !== undefined && approximate ? { filesizeIsApproximate: true } : {}),
    // Merging two streams is a container operation, not a re-encode.
    requiresConversion: false,
    recommended: input.recommended,
    fetch: { via: 'ytdlp', selector, ...(audio ? { merge: container } : {}) },
  };
}

export function buildVideoPlans(
  formats: readonly UsableFormat[],
  duration: number | undefined,
  options: PlanBuildOptions,
): DownloadPlan[] {
  const { videoOnly, audioOnly, progressive } = splitFormats(formats);
  const plans: DownloadPlan[] = [];

  // Renditions that already carry audio are preferred at a given height: one stream,
  // no merge step, and nothing to get wrong.
  const progressiveByHeight = new Map<number, UsableFormat>();
  for (const format of progressive) {
    const height = format.height;
    if (!height) continue;
    const current = progressiveByHeight.get(height);
    if (!current || (format.tbr ?? 0) > (current.tbr ?? 0)) progressiveByHeight.set(height, format);
  }

  const heights = bestVideoPerHeight(videoOnly);
  const seen = new Set<number>();
  let first = true;

  const emit = (video: UsableFormat, audio: UsableFormat | undefined): void => {
    const height = video.height ?? 0;
    if (seen.has(height)) return;

    const container: ContainerFormat = audio
      ? fitsInMp4(video.vcodec, audio.acodec)
        ? 'mp4'
        : 'webm'
      : nativeContainer(video.vcodec);

    const plan = makeVideoPlan({
      video,
      ...(audio ? { audio } : {}),
      container,
      ...(duration !== undefined ? { duration } : {}),
      recommended: first,
    });

    if (
      options.maxFilesizeBytes &&
      plan.filesizeBytes &&
      plan.filesizeBytes > options.maxFilesizeBytes
    ) {
      return;
    }
    seen.add(height);
    plans.push(plan);
    first = false;
  };

  for (const video of heights) {
    const height = video.height ?? 0;
    const progressiveMatch = progressiveByHeight.get(height);
    // Use the muxed rendition only when it is not markedly worse than the split pair.
    if (progressiveMatch && (progressiveMatch.tbr ?? 0) >= (video.tbr ?? 0) * 0.8) {
      emit(progressiveMatch, undefined);
      continue;
    }
    const preferred = nativeContainer(video.vcodec);
    emit(video, bestAudio(audioOnly, preferred));
  }

  // Sources that only ever publish muxed streams (most of TikTok, X and Reddit).
  if (!plans.length) {
    for (const format of [...progressiveByHeight.values()].sort(
      (a, b) => (b.height ?? 0) - (a.height ?? 0),
    )) {
      emit(format, undefined);
    }
  }

  return plans;
}

/**
 * Adds a container alternative for the best rendition.
 *
 * Only losslessly reachable containers are offered. MOV in particular is a pure remux of
 * MP4-compatible streams, so it costs nothing to provide and saves anyone on a video
 * editor a round trip.
 */
export function buildAlternateContainerPlans(best: DownloadPlan | undefined): DownloadPlan[] {
  if (best?.kind !== 'video' || best.fetch.via !== 'ytdlp') return [];
  const plans: DownloadPlan[] = [];

  if (best.container === 'mp4' && fitsInMp4(best.videoCodec, best.audioCodec)) {
    plans.push({
      ...best,
      container: 'mov',
      // The container is named in the label, not only the detail: a quality dropdown
      // listing "1080p" twice is worse than no alternative at all.
      label: `${best.label} (MOV)`,
      detail: joinDetail('MOV', codecLabel(best.videoCodec), 'remux')!,
      recommended: false,
      requiresConversion: false,
      fetch: { ...best.fetch, remux: 'mov' },
    });
  }
  return plans;
}

/* -------------------------------------------------------------------------- */
/*  Audio                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Audio targets, each with the source it would rather be built from.
 *
 * The preference matters: asking for M4A when the best-bitrate stream happens to be
 * Opus would transcode for no reason, when the same page also publishes AAC that could
 * simply be copied. Each target therefore picks its own source rather than sharing one.
 */
const AUDIO_TARGETS: {
  container: ContainerFormat;
  format: string;
  label: string;
  prefer: 'mp4' | 'webm' | 'any';
  /** Narrows yt-dlp's selection to the codec this target can copy. */
  selectorPrefix?: string;
}[] = [
  { container: 'mp3', format: 'mp3', label: 'MP3', prefer: 'any' },
  {
    container: 'm4a',
    format: 'm4a',
    label: 'M4A',
    prefer: 'mp4',
    selectorPrefix: 'bestaudio[acodec^=mp4a]',
  },
  {
    container: 'opus',
    format: 'opus',
    label: 'Opus',
    prefer: 'webm',
    selectorPrefix: 'bestaudio[acodec=opus]',
  },
  { container: 'wav', format: 'wav', label: 'WAV', prefer: 'any' },
];

export function buildAudioPlans(
  formats: readonly UsableFormat[],
  duration: number | undefined,
  options: PlanBuildOptions,
): DownloadPlan[] {
  const { audioOnly, progressive } = splitFormats(formats);
  const pool = audioOnly.length ? audioOnly : progressive;
  if (!bestAudio(pool)) return [];

  const plans: DownloadPlan[] = [];

  for (const target of AUDIO_TARGETS) {
    const source = bestAudio(pool, target.prefer);
    /* c8 ignore next -- the pool is non-empty, so a source always exists */
    if (!source) continue;

    const sourceAbr = source.abr ?? (source.hasVideo ? undefined : source.tbr);
    const sourceCodec = (source.acodec ?? '').toLowerCase();

    const isLossless = target.container === 'wav';
    const canCopy =
      (target.container === 'm4a' && sourceCodec.startsWith('mp4a')) ||
      (target.container === 'opus' && sourceCodec.startsWith('opus')) ||
      (target.container === 'mp3' && sourceCodec.startsWith('mp3'));

    // Falls back to a muxed stream, because plenty of sources publish no audio-only
    // rendition at all; when the target can copy, its codec is asked for first.
    const base = audioOnly.length ? 'bestaudio/best' : 'best';
    const selector = canCopy && target.selectorPrefix ? `${target.selectorPrefix}/${base}` : base;

    // Never advertise a bitrate the source cannot actually supply.
    const bitrate = isLossless || canCopy ? undefined : audioBitrateChoices(sourceAbr)[0];

    const estimatedBytes = isLossless
      ? duration
        ? Math.round(duration * 44100 * 2 * 2)
        : undefined
      : duration && (bitrate ?? sourceAbr)
        ? Math.round((((bitrate ?? sourceAbr)! * 1000) / 8) * duration)
        : estimateSize(source, duration);

    if (options.maxFilesizeBytes && estimatedBytes && estimatedBytes > options.maxFilesizeBytes) {
      continue;
    }

    plans.push({
      kind: 'audio',
      container: target.container,
      label: target.label,
      detail:
        joinDetail(
          canCopy
            ? 'Original quality'
            : bitrate
              ? `${bitrate} kbps`
              : isLossless
                ? 'Lossless'
                : undefined,
          // The source codec is only worth naming when it is what the user will get.
          // "WAV · Lossless · AAC" reads as a contradiction, because it is one.
          canCopy ? codecLabel(source.acodec) : undefined,
          sizeDetail(estimatedBytes, true),
        ) ?? target.label,
      ...(bitrate ? { audioBitrateKbps: bitrate } : {}),
      ...(source.acodec ? { audioCodec: source.acodec } : {}),
      ...(estimatedBytes !== undefined ? { filesizeBytes: estimatedBytes } : {}),
      ...(estimatedBytes !== undefined ? { filesizeIsApproximate: true } : {}),
      requiresConversion: !canCopy,
      recommended: target.container === 'mp3',
      fetch: {
        via: 'ytdlp',
        selector,
        audio: {
          format: target.format,
          ...(bitrate ? { quality: `${bitrate}K` } : { quality: '0' }),
        },
      },
    });
  }

  return plans;
}

/* -------------------------------------------------------------------------- */
/*  Images and GIFs                                                           */
/* -------------------------------------------------------------------------- */

export function buildImagePlans(info: YtdlpInfo, directUrl: string | undefined): DownloadPlan[] {
  const ext = (str(info.ext) ?? 'jpg').toLowerCase();
  const container = (IMAGE_EXTENSIONS.has(ext) ? ext : 'jpg') as ContainerFormat;
  const width = num(info.width);
  const height = num(info.height);
  const size = num(info.filesize) ?? num(info.filesize_approx);

  return [
    {
      kind: 'image',
      container,
      label: 'Original',
      detail:
        joinDetail(
          container.toUpperCase(),
          width && height ? `${width} × ${height}` : undefined,
          sizeDetail(size, num(info.filesize) === undefined),
        ) ?? container.toUpperCase(),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(size !== undefined ? { filesizeBytes: size } : {}),
      ...(size !== undefined && num(info.filesize) === undefined
        ? { filesizeIsApproximate: true }
        : {}),
      requiresConversion: false,
      recommended: true,
      fetch: directUrl ? { via: 'direct', url: directUrl } : { via: 'ytdlp', selector: 'best' },
    },
  ];
}

/**
 * Options for animated media.
 *
 * Most platforms store what users call a GIF as a silent short MP4, so the honest
 * presentation offers the real video first and treats the actual GIF as a conversion.
 */
export function buildGifPlans(
  sourceIsRealGif: boolean,
  videoPlans: readonly DownloadPlan[],
  duration: number | undefined,
  options: PlanBuildOptions,
): DownloadPlan[] {
  const plans: DownloadPlan[] = [];
  const maxGif = options.maxGifDurationSeconds ?? 30;
  const best = videoPlans[0];

  if (sourceIsRealGif) {
    plans.push({
      kind: 'gif',
      container: 'gif',
      label: 'Original',
      detail: 'GIF · unmodified',
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'ytdlp', selector: 'best' },
    });
  }

  if (best?.fetch.via === 'ytdlp') {
    if (!sourceIsRealGif && (!duration || duration <= maxGif)) {
      plans.push({
        kind: 'gif',
        container: 'gif',
        label: 'GIF',
        detail: `Converted · ${best.fps && best.fps > 15 ? 15 : (best.fps ?? 15)} fps`,
        requiresConversion: true,
        recommended: false,
        fetch: best.fetch,
        convert: { kind: 'gif', fps: 15, maxWidth: 480 },
      });
    }
    if (sourceIsRealGif) {
      plans.push(
        {
          kind: 'video',
          container: 'mp4',
          label: 'MP4',
          detail: 'Converted from GIF · H.264',
          requiresConversion: true,
          recommended: false,
          fetch: { via: 'ytdlp', selector: 'best' },
          convert: { kind: 'video', container: 'mp4' },
        },
        {
          kind: 'video',
          container: 'webm',
          label: 'WebM',
          detail: 'Converted from GIF · VP9',
          requiresConversion: true,
          recommended: false,
          fetch: { via: 'ytdlp', selector: 'best' },
          convert: { kind: 'video', container: 'webm' },
        },
      );
    }
  }

  return plans;
}

/** Marks exactly one plan per kind as the default, preferring the first of each. */
export function applyRecommendations(plans: readonly DownloadPlan[]): DownloadPlan[] {
  const claimed = new Set<string>();
  return plans.map((plan) => {
    if (plan.recommended && !claimed.has(plan.kind)) {
      claimed.add(plan.kind);
      return plan;
    }
    return plan.recommended ? { ...plan, recommended: false } : plan;
  });
}

/** Guarantees each kind has a default even when no plan claimed one. */
export function ensureRecommendations(plans: readonly DownloadPlan[]): DownloadPlan[] {
  const withFlags = applyRecommendations(plans);
  const kinds = new Set(withFlags.map((p) => p.kind));
  const result = [...withFlags];
  for (const kind of kinds) {
    if (result.some((p) => p.kind === kind && p.recommended)) continue;
    const index = result.findIndex((p) => p.kind === kind);
    if (index >= 0) result[index] = { ...result[index]!, recommended: true };
  }
  return result;
}
