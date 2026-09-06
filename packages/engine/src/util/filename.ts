import { basename, extname } from 'node:path';

/** Characters that are illegal or hostile in a filename on any mainstream filesystem. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
/** Names Windows refuses regardless of extension. */
const RESERVED_WINDOWS =
  /^(con|prn|aux|nul|com[0-9\u00b2\u00b3\u00b9]|lpt[0-9\u00b2\u00b3\u00b9])$/i;
/** Bidirectional-override and zero-width characters, which can disguise an extension. */

const DECEPTIVE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const MAX_STEM_LENGTH = 120;

/**
 * Reduces arbitrary text to a filename stem that is safe on every target filesystem.
 *
 * Everything path-like is removed rather than escaped: the result can never contain a
 * separator, a drive letter, a parent reference, or a leading dash. An empty or
 * fully-stripped input yields `media`, so the caller always gets a usable name.
 */
export function sanitizeStem(input: string, fallback = 'media'): string {
  let out = input.normalize('NFC').replace(DECEPTIVE, '').replace(ILLEGAL, ' ');

  // Collapse whitespace runs and strip characters that are legal but awkward at an edge.
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');

  if (out.length > MAX_STEM_LENGTH) {
    out =
      out
        .slice(0, MAX_STEM_LENGTH)
        .replace(/\s+\S*$/, '')
        .trim() || out.slice(0, MAX_STEM_LENGTH);
  }
  // Re-strip: truncation can expose a new trailing dot or dash.
  out = out.replace(/[.\-\s]+$/, '').trim();

  if (!out || RESERVED_WINDOWS.test(out)) return fallback;
  return out;
}

/** Normalizes an extension to a lowercase, dot-less, alphanumeric token. */
export function sanitizeExtension(ext: string, fallback = 'bin'): string {
  const cleaned = ext
    .replace(/^\.+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!cleaned || cleaned.length > 8) return fallback;
  return cleaned;
}

/** Builds `stem.ext`, both sanitized. */
export function buildFilename(stem: string, ext: string, fallbackStem = 'media'): string {
  return `${sanitizeStem(stem, fallbackStem)}.${sanitizeExtension(ext)}`;
}

/**
 * The conventional name for a downloaded item: `creator - title.ext`.
 *
 * Either part may be missing; the separator only appears when both are present.
 */
export function mediaFilename(parts: {
  author?: string | undefined;
  title?: string | undefined;
  /** A container name; `ContainerFormat` values are the expected inputs. */
  container: string;
  /** Appended as ` (n)` for items 2..n of a collection. */
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

/**
 * Returns a name not already present in `taken`, appending ` (2)`, ` (3)`, ... as needed.
 * Mutates `taken` so repeated calls stay collision-free.
 */
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

/**
 * Guards a filesystem read against path traversal.
 *
 * Accepts only a bare filename: anything containing a separator, a parent reference, a
 * drive letter, or a NUL byte is rejected. Callers join the result onto a directory they
 * chose themselves, so a rejected name can never escape the workspace.
 */
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

/** Percent-encodes a filename for `Content-Disposition`'s `filename*` parameter. */
export function contentDispositionValue(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
