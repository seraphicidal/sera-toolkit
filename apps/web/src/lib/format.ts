import type { JobState, MediaKind } from '@sera/contracts/types';

/**
 * Presentation helpers for the browser.
 *
 * Deliberately duplicated from the engine rather than imported: the engine is a
 * server-side package that pulls in the extractor, the archiver and a validator, and
 * none of that belongs in a bundle sent to a phone.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** `00:08` for an ETA; blank when there is nothing meaningful to say. */
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

export function formatRelativeDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const KIND_LABELS: Record<Exclude<MediaKind, 'unknown'>, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  gif: 'GIF',
};

/** Plural-aware count, e.g. `1 file` / `7 files`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** States in which the job is still doing something. */
export function isRunning(state: JobState): boolean {
  return !['ready', 'failed', 'cancelled', 'expired'].includes(state);
}

/**
 * A trimmed URL for display: the host plus enough path to recognise the link.
 * Never used for navigation, only as a label.
 */
export function displayUrl(raw: string, maxLength = 52): string {
  let text = raw;
  try {
    const url = new URL(raw);
    text = `${url.hostname.replace(/^www\./, '')}${url.pathname}${url.search}`;
  } catch {
    // Not a URL; show whatever was pasted.
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Joins class names, skipping anything falsy. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
