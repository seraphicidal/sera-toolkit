import type { YtdlpFormat, YtdlpInfo } from '../extract/ytdlp-types.js';
import { num, str } from '../extract/ytdlp-types.js';

/**
 * Turns yt-dlp's raw format list into something a person can choose from.
 *
 * Providers return dozens of entries per video: the same stream over several protocols,
 * storyboard sheets, loudness-normalized audio twins, and duplicate renditions that
 * differ only in an internal id. Showing that list is the difference between a tool and
 * a debug dump, so everything below is about reducing it to the few rows that actually
 * mean something different to the person downloading.
 */

export interface UsableFormat {
  readonly id: string;
  readonly ext: string;
  readonly protocol: string;
  readonly vcodec?: string;
  readonly acodec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly tbr?: number;
  readonly abr?: number;
  readonly asr?: number;
  readonly filesize?: number;
  readonly filesizeIsApproximate: boolean;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly note?: string;
}

/** Protocols the pipeline can actually download and remux. */
const SUPPORTED_PROTOCOLS = new Set([
  'https',
  'http',
  'm3u8_native',
  'm3u8',
  'http_dash_segments',
  'mhtml_ignored',
]);

/** Storyboard sheets, which are images of the timeline rather than media. */
function isStoryboard(format: YtdlpFormat): boolean {
  return (
    format.ext === 'mhtml' ||
    format.protocol === 'mhtml' ||
    (str(format.format_note) ?? '').toLowerCase().includes('storyboard')
  );
}

/**
 * Loudness-normalized audio duplicates (`-drc`) and the `-<n>` "premium" video twins
 * YouTube emits alongside the ordinary rendition. Both are byte-for-byte alternatives
 * to a format already in the list, so keeping them only doubles the menu.
 */
function isRedundantTwin(format: YtdlpFormat): boolean {
  const id = str(format.format_id) ?? '';
  if (id.endsWith('-drc')) return true;
  const note = (str(format.format_note) ?? '').toLowerCase();
  return note.includes('drc') || note.includes('premium');
}

export function toUsableFormats(formats: readonly YtdlpFormat[] | undefined): UsableFormat[] {
  if (!formats?.length) return [];
  const out: UsableFormat[] = [];

  for (const format of formats) {
    const id = str(format.format_id);
    if (!id) continue;
    if (isStoryboard(format) || isRedundantTwin(format)) continue;

    const protocol = str(format.protocol) ?? 'https';
    if (!SUPPORTED_PROTOCOLS.has(protocol)) continue;

    const vcodec = str(format.vcodec);
    const acodec = str(format.acodec);
    const hasVideo = Boolean(vcodec) && vcodec !== 'none';
    const hasAudio = Boolean(acodec) && acodec !== 'none';
    if (!hasVideo && !hasAudio) continue;

    const exact = num(format.filesize);
    const approx = num(format.filesize_approx);

    const usable: UsableFormat = {
      id,
      ext: str(format.ext) ?? 'bin',
      protocol,
      ...(vcodec ? { vcodec } : {}),
      ...(acodec ? { acodec } : {}),
      ...(num(format.width) ? { width: num(format.width)! } : {}),
      ...(num(format.height) ? { height: num(format.height)! } : {}),
      ...(num(format.fps) ? { fps: Math.round(num(format.fps)!) } : {}),
      ...(num(format.tbr) ? { tbr: num(format.tbr)! } : {}),
      ...(num(format.abr) ? { abr: num(format.abr)! } : {}),
      ...(num(format.asr) ? { asr: num(format.asr)! } : {}),
      ...((exact ?? approx) ? { filesize: exact ?? approx! } : {}),
      filesizeIsApproximate: exact === undefined,
      hasVideo,
      hasAudio,
      ...(str(format.format_note) ? { note: str(format.format_note)! } : {}),
    };
    out.push(usable);
  }
  return out;
}

/** Estimates a size from bitrate when the provider reports none. */
export function estimateSize(format: UsableFormat, durationSeconds?: number): number | undefined {
  if (format.filesize) return format.filesize;
  const bitrate = format.tbr ?? format.abr;
  if (!bitrate || !durationSeconds) return undefined;
  return Math.round((bitrate * 1000 * durationSeconds) / 8);
}

/** Containers a codec can be remuxed into without re-encoding. */
export function nativeContainer(vcodec: string | undefined): 'mp4' | 'webm' {
  const codec = (vcodec ?? '').toLowerCase();
  if (codec.startsWith('vp9') || codec.startsWith('vp09') || codec.startsWith('vp8')) return 'webm';
  return 'mp4';
}

/** True when the codec pair can live in an MP4 without re-encoding. */
export function fitsInMp4(vcodec: string | undefined, acodec: string | undefined): boolean {
  const v = (vcodec ?? '').toLowerCase();
  const a = (acodec ?? '').toLowerCase();
  const videoOk =
    !v ||
    v === 'none' ||
    v.startsWith('avc') ||
    v.startsWith('h264') ||
    v.startsWith('av01') ||
    v.startsWith('hev') ||
    v.startsWith('hvc');
  const audioOk =
    !a ||
    a === 'none' ||
    a.startsWith('mp4a') ||
    a.startsWith('aac') ||
    a.startsWith('ac-3') ||
    a.startsWith('ec-3');
  return videoOk && audioOk;
}

export interface FormatSplit {
  readonly videoOnly: readonly UsableFormat[];
  readonly audioOnly: readonly UsableFormat[];
  readonly progressive: readonly UsableFormat[];
}

export function splitFormats(formats: readonly UsableFormat[]): FormatSplit {
  const videoOnly: UsableFormat[] = [];
  const audioOnly: UsableFormat[] = [];
  const progressive: UsableFormat[] = [];
  for (const format of formats) {
    if (format.hasVideo && format.hasAudio) progressive.push(format);
    else if (format.hasVideo) videoOnly.push(format);
    else audioOnly.push(format);
  }
  return { videoOnly, audioOnly, progressive };
}

/** Ranks audio, preferring the container that muxes cleanly with the chosen video. */
export function bestAudio(
  audio: readonly UsableFormat[],
  prefer: 'mp4' | 'webm' | 'any' = 'any',
): UsableFormat | undefined {
  if (!audio.length) return undefined;
  const score = (format: UsableFormat): number => {
    const codec = (format.acodec ?? '').toLowerCase();
    let containerBonus = 0;
    if (prefer === 'mp4' && (codec.startsWith('mp4a') || codec.startsWith('aac')))
      containerBonus = 2000;
    if (prefer === 'webm' && codec.startsWith('opus')) containerBonus = 2000;
    return containerBonus + (format.abr ?? format.tbr ?? 0);
  };
  return [...audio].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Picks one video rendition per distinct height.
 *
 * Ranking prefers a higher frame rate, then a codec that remuxes into MP4 without
 * re-encoding, then bitrate. The codec preference is what makes "1080p, MP4" usually
 * mean a stream copy rather than a two-minute transcode.
 */
export function bestVideoPerHeight(video: readonly UsableFormat[]): UsableFormat[] {
  const byHeight = new Map<number, UsableFormat>();
  for (const format of video) {
    const height = format.height;
    if (!height) continue;
    const current = byHeight.get(height);
    if (!current || rankVideo(format) > rankVideo(current)) byHeight.set(height, format);
  }
  return [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

function rankVideo(format: UsableFormat): number {
  const codec = (format.vcodec ?? '').toLowerCase();
  let codecScore = 0;
  if (codec.startsWith('avc') || codec.startsWith('h264')) codecScore = 3;
  else if (codec.startsWith('av01')) codecScore = 2;
  else if (codec.startsWith('vp9') || codec.startsWith('vp09')) codecScore = 1;
  const fpsScore = (format.fps ?? 30) >= 50 ? 1 : 0;
  return fpsScore * 100_000 + codecScore * 10_000 + (format.tbr ?? 0);
}

/** The set of audio bitrates worth offering, given what the source actually carries. */
export function audioBitrateChoices(sourceAbr: number | undefined): number[] {
  const source = sourceAbr ?? 0;
  // Offering 320 kbps for a 64 kbps source would be a lie about quality, not an upgrade.
  const candidates = [320, 192, 128];
  const usable = candidates.filter((rate) => source === 0 || rate <= Math.max(source * 1.1, 128));
  return usable.length ? usable : [Math.round(Math.max(source, 64))];
}

/** Reads the primary duration from an info object, in seconds. */
export function infoDuration(info: YtdlpInfo): number | undefined {
  return num(info.duration);
}
