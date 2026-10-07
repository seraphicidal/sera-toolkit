import { basename, extname } from 'node:path';

// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const RESERVED_WINDOWS =
  /^(con|prn|aux|nul|com[0-9\u00b2\u00b3\u00b9]|lpt[0-9\u00b2\u00b3\u00b9])$/i;

const DECEPTIVE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const MAX_STEM_LENGTH = 120;

export function sanitizeStem(input: string, fallback = 'media'): string {
  let out = input.normalize('NFC').replace(DECEPTIVE, '').replace(ILLEGAL, ' ');

  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');

  if (out.length > MAX_STEM_LENGTH) {
    out =
      out
        .slice(0, MAX_STEM_LENGTH)
        .replace(/\s+\S*$/, '')
        .trim() || out.slice(0, MAX_STEM_LENGTH);
  }
  out = out.replace(/[.\-\s]+$/, '').trim();

  if (!out || RESERVED_WINDOWS.test(out)) return fallback;
  return out;
}

export function sanitizeExtension(ext: string, fallback = 'bin'): string {
  const cleaned = ext
    .replace(/^\.+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!cleaned || cleaned.length > 8) return fallback;
  return cleaned;
}

export function buildFilename(stem: string, ext: string, fallbackStem = 'media'): string {
  return `${sanitizeStem(stem, fallbackStem)}.${sanitizeExtension(ext)}`;
}

export function mediaFilename(parts: {
  author?: string | undefined;
  title?: string | undefined;
  container: string;
  index?: number | undefined;
}): string {
  const author = parts.author ? sanitizeStem(parts.author, '') : '';
  const title = parts.title ? sanitizeStem(parts.title, '') : '';
  let stem = [author, title].filter(Boolean).join(' - ');
  if (parts.index !== undefined && parts.index > 0) {
    stem = stem ? `${stem} (${parts.index})` : `media (${parts.index})`;
  }
  return buildFilename(stem, String(parts.container));
}

export function dedupeFilename(name: string, taken: Set<string>): string {
  const key = name.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  /* c8 ignore next 3 -- unreachable with a 10k ceiling on a single job's file count */
  const unique = `${stem} (${Date.now()})${ext}`;
  taken.add(unique.toLowerCase());
  return unique;
}

export function assertSafeFilename(name: string): string {
  if (
    !name ||
    name.length > 255 ||
    name.includes('\u0000') ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    /^[a-zA-Z]:/.test(name) ||
    basename(name) !== name
  ) {
    throw new Error(`unsafe filename: ${JSON.stringify(name.slice(0, 64))}`);
  }
  return name;
}

export function contentDispositionValue(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
