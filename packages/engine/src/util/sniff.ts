import type { ContainerFormat } from '@sera/contracts/types';

export const SNIFF_BYTES = 32;

export function sniffContainer(head: Uint8Array): ContainerFormat | undefined {
  const at = (offset: number, ...bytes: number[]): boolean =>
    bytes.every((byte, i) => head[offset + i] === byte);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((character, i) => head[offset + i] === character.charCodeAt(0));

  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'wav';
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'avif') || ascii(8, 'avis')) return 'avif';
    if (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1')) return 'jpg';
    if (ascii(8, 'qt  ')) return 'mov';
    return 'mp4';
  }

  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'webm';
  if (ascii(0, 'OggS')) return 'ogg';
  if (ascii(0, 'fLaC')) return 'flac';
  if (ascii(0, 'ID3')) return 'mp3';
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ((head[1] ?? 0) & 0x06) !== 0x00) {
    return 'mp3';
  }

  return undefined;
}

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

const EQUIVALENT: readonly ReadonlySet<string>[] = [
  new Set(['jpg', 'jpeg']),
  new Set(['mp4', 'm4v', 'm4a']),
  new Set(['ogg', 'oga', 'opus']),
  new Set(['mkv', 'webm']),
];

export function contradicts(claimed: string, sniffed: string): boolean {
  if (claimed === sniffed) return false;
  return !EQUIVALENT.some((group) => group.has(claimed) && group.has(sniffed));
}
