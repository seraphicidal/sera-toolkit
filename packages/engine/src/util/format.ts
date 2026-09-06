/** Presentation helpers shared by the engine and, through the contracts, by the UI. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `1536` -> `1.5 KB`. Uses SI-style 1024 steps, matching what download UIs show. */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = fractionDigits ?? (unit === 0 ? 0 : value < 10 ? 1 : 0);
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** `154` -> `2:34`; `3725` -> `1:02:05`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Maps a pixel height onto the label people actually use for it. */
export function qualityLabel(height: number | undefined, width?: number): string {
  if (!height || height <= 0) return 'Source';
  // Vertical video reports its long edge as height; label by the short edge instead.
  const shortEdge = width && width < height ? width : height;
  const steps = [
    [4320, '8K'],
    [2160, '4K'],
    [1440, '1440p'],
    [1080, '1080p'],
    [720, '720p'],
    [480, '480p'],
    [360, '360p'],
    [240, '240p'],
    [144, '144p'],
  ] as const;
  for (const [threshold, label] of steps) {
    if (shortEdge >= threshold - threshold * 0.06) return label;
  }
  return `${shortEdge}p`;
}

/** Human names for the codec strings providers report. */
export function codecLabel(codec: string | undefined): string | undefined {
  if (!codec || codec === 'none') return undefined;
  const c = codec.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('hev1') || c.startsWith('hvc1') || c.startsWith('h265')) return 'H.265';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09') || c === 'vp9') return 'VP9';
  if (c.startsWith('vp8')) return 'VP8';
  if (c.startsWith('mp4a') || c.startsWith('aac')) return 'AAC';
  if (c.startsWith('opus')) return 'Opus';
  if (c.startsWith('vorbis')) return 'Vorbis';
  if (c.startsWith('mp3')) return 'MP3';
  if (c.startsWith('flac')) return 'FLAC';
  if (c.startsWith('ec-3') || c.startsWith('ac-3')) return 'Dolby';
  return codec.split('.')[0]?.toUpperCase();
}

/** Truncates to `max` characters on a word boundary where possible. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
