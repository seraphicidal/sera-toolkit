import type { ContainerFormat } from '@sera/contracts/types';

/**
 * What a file actually is, read from its first bytes.
 *
 * A provider has to name a format before it has the file — from a URL, an extension, a
 * `Content-Type` — and any of those can be wrong. Bluesky's CDN is the case that prompted
 * this: its image URLs end in `@jpeg` and it serves WebP, so a carousel arrived as three
 * `.jpg` files that no image viewer would open. Magic bytes are the only account of a
 * file that cannot be mistaken.
 *
 * Only formats SERA already names are returned; anything else is left alone rather than
 * renamed to something the rest of the pipeline does not understand.
 */
export const SNIFF_BYTES = 32;

export function sniffContainer(head: Uint8Array): ContainerFormat | undefined {
  const at = (offset: number, ...bytes: number[]): boolean =>
    bytes.every((byte, i) => head[offset + i] === byte);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((character, i) => head[offset + i] === character.charCodeAt(0));

  // Images.
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif';
  // RIFF containers name their form at byte 8: WEBP for images, WAVE for audio.
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'wav';
  // ISO base media: the brand at byte 8 separates a still from a film.
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'avif') || ascii(8, 'avis')) return 'avif';
    if (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1')) return 'jpg';
    if (ascii(8, 'qt  ')) return 'mov';
    return 'mp4';
  }

  // Audio and video.
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'webm'; // also Matroska; webm is the common case
  if (ascii(0, 'OggS')) return 'ogg';
  if (ascii(0, 'fLaC')) return 'flac';
  if (ascii(0, 'ID3')) return 'mp3';
  // A bare MPEG audio frame: 11 sync bits, then a layer that is not "reserved".
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ((head[1] ?? 0) & 0x06) !== 0x00) {
    return 'mp3';
  }

  return undefined;
}

/**
 * What a file is when it is not media at all.
 *
 * A source that has decided to refuse still answers 200, and what it sends is a login
 * page, a consent wall, a CAPTCHA or a JSON error — with whatever content type it
 * likes. Saved under the extension the plan asked for, that is a .jpg that opens to
 * "Log in to continue", and nothing downstream noticed: `sniffContainer` returns
 * undefined for it, so the container correction left it alone, and the ffprobe check
 * only runs on audio and video extensions.
 *
 * Reads the first bytes, skipping a UTF-8 BOM and leading whitespace, because that is
 * all it takes to tell markup and JSON from every magic number above.
 */
export function sniffTextImposter(head: Uint8Array): 'html' | 'json' | 'xml' | undefined {
  let start = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3;
  while (start < head.length && (head[start] ?? 0) <= 0x20) start += 1;

  const text = Buffer.from(head.subarray(start)).toString('latin1').toLowerCase();
  if (!text) return undefined;
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<head')) {
    return 'html';
  }
  if (text.startsWith('<?xml')) return 'xml';
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  return undefined;
}

/**
 * Formats that are genuinely the same file in different clothes, where renaming would be
 * noise rather than a correction.
 */
const EQUIVALENT: readonly ReadonlySet<string>[] = [
  new Set(['jpg', 'jpeg']),
  new Set(['mp4', 'm4v', 'm4a']),
  new Set(['ogg', 'oga', 'opus']),
  new Set(['mkv', 'webm']),
];

/** Whether a sniffed format contradicts the one a plan claimed. */
export function contradicts(claimed: string, sniffed: string): boolean {
  if (claimed === sniffed) return false;
  return !EQUIVALENT.some((group) => group.has(claimed) && group.has(sniffed));
}
