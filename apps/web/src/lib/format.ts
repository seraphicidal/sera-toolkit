import {
  formatTimecode,
  isTerminalJobState,
  type DownloadOption,
  type JobState,
  type MediaKind,
} from '@sera/contracts/types';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || Math.round(value * 10) >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  return formatTimecode(seconds);
}

export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return '00:00';
  if (seconds > 86_400) return '';
  return formatDuration(seconds).padStart(5, '0');
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond)) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export const KIND_LABELS: Record<Exclude<MediaKind, 'unknown'>, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  gif: 'GIF',
};

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function isRunning(state: JobState): boolean {
  return !isTerminalJobState(state);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function formatCodecBadge(rawCodec: string | undefined): string | undefined {
  if (!rawCodec) return undefined;
  const normalized = rawCodec.trim().toLowerCase();
  if (!normalized || normalized === 'none') return undefined;
  if (normalized.startsWith('av01') || normalized === 'av1') return 'AV1';
  if (
    normalized.startsWith('avc1') ||
    normalized.startsWith('avc3') ||
    normalized === 'h264' ||
    normalized === 'h.264' ||
    normalized === 'x264'
  ) {
    return 'H.264';
  }
  if (
    normalized.startsWith('hev1') ||
    normalized.startsWith('hvc1') ||
    normalized === 'hevc' ||
    normalized === 'h265' ||
    normalized === 'h.265' ||
    normalized === 'x265'
  ) {
    return 'HEVC';
  }
  if (normalized.startsWith('vp09') || normalized === 'vp9') return 'VP9';
  if (normalized.startsWith('vp08') || normalized === 'vp8') return 'VP8';
  if (normalized.includes('opus')) return 'Opus';
  if (normalized.startsWith('mp4a') || normalized === 'aac') return 'AAC';
  if (normalized === 'mp3' || normalized.startsWith('mp3')) return 'MP3';
  if (normalized === 'flac') return 'FLAC';
  if (normalized === 'vorbis') return 'Vorbis';
  if (normalized === 'wav' || normalized.startsWith('pcm')) return 'WAV';
  return rawCodec.trim().toUpperCase();
}

export function optionBadges(
  option: Pick<
    DownloadOption,
    'videoCodec' | 'audioCodec' | 'audioBitrateKbps' | 'detail' | 'container' | 'fps'
  >,
): string[] {
  const badges: string[] = [];
  const seen = new Set<string>();
  const add = (badge: string | undefined) => {
    if (!badge) return;
    const key = badge.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    badges.push(badge);
  };

  add(formatCodecBadge(option.videoCodec));
  add(formatCodecBadge(option.audioCodec));
  if (
    option.audioBitrateKbps &&
    Number.isFinite(option.audioBitrateKbps) &&
    option.audioBitrateKbps > 0
  ) {
    add(`${Math.round(option.audioBitrateKbps)}kbps`);
  }
  if (option.fps && option.fps >= 50) {
    add(`${Math.round(option.fps)}fps`);
  }

  if (option.detail) {
    const detailTokens = [
      { pattern: /\bav1\b|\bav01\b/i, label: 'AV1' },
      { pattern: /\bh\.?264\b|\bavc1?\b|\bx264\b/i, label: 'H.264' },
      { pattern: /\bhevc\b|\bh\.?265\b|\bhev1\b|\bhvc1\b/i, label: 'HEVC' },
      { pattern: /\bvp9\b|\bvp09\b/i, label: 'VP9' },
      { pattern: /\bvp8\b/i, label: 'VP8' },
      { pattern: /\bopus\b/i, label: 'Opus' },
      { pattern: /\baac\b|\bmp4a\b/i, label: 'AAC' },
      { pattern: /\bmp3\b/i, label: 'MP3' },
      { pattern: /\bflac\b/i, label: 'FLAC' },
      { pattern: /\bwav\b|\bpcm\b/i, label: 'WAV' },
    ];
    for (const token of detailTokens) {
      if (token.pattern.test(option.detail)) add(token.label);
    }
    const bitrateMatch = /(\d{2,4})\s*kbps/i.exec(option.detail);
    if (bitrateMatch?.[1]) {
      add(`${bitrateMatch[1]}kbps`);
    }
  }

  return badges;
}

export const PIPELINE_STEPS = [
  'Resolving',
  'Downloading',
  'Transcoding',
  'Tagging',
  'Done',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export function resolvePipelineStepIndex(state: JobState, step?: string): number {
  const text = (step ?? '').toLowerCase();
  if (state === 'ready' || /\bdone\b|\bcomplete|\bfinished\b/.test(text)) return 4;
  if (
    state === 'packaging' ||
    state === 'finalizing' ||
    /tag|metadata|embed|packag|finaliz|zip|archiv/.test(text)
  ) {
    return 3;
  }
  if (
    state === 'merging' ||
    state === 'converting' ||
    /transcod|convert|merg|mux|trim|ffmpeg|re-encod/.test(text)
  ) {
    return 2;
  }
  if (state === 'downloading' || /download|fetch|receiv|stream/.test(text)) {
    return 1;
  }
  return 0;
}
