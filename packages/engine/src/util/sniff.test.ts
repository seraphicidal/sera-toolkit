import { describe, expect, it } from 'vitest';
import { contradicts, sniffContainer, SNIFF_BYTES } from './sniff.js';

function header(...parts: (string | number[])[]): Uint8Array {
  const bytes: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') bytes.push(...[...part].map((c) => c.charCodeAt(0)));
    else bytes.push(...part);
  }
  const buffer = new Uint8Array(SNIFF_BYTES);
  buffer.set(bytes.slice(0, SNIFF_BYTES));
  return buffer;
}

describe('sniffContainer', () => {
  it('reads the image formats', () => {
    expect(sniffContainer(header([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffContainer(header([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffContainer(header('GIF89a'))).toBe('gif');
    expect(sniffContainer(header('GIF87a'))).toBe('gif');
  });

  it('tells the two RIFF forms apart', () => {
    expect(sniffContainer(header('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(sniffContainer(header('RIFF', [0, 0, 0, 0], 'WAVEfmt '))).toBe('wav');
    expect(sniffContainer(header('RIFF', [0, 0, 0, 0], 'AVI '))).toBeUndefined();
  });

  it('tells the ISO base media brands apart', () => {
    expect(sniffContainer(header([0, 0, 0, 0x20], 'ftypavif'))).toBe('avif');
    expect(sniffContainer(header([0, 0, 0, 0x20], 'ftypisom'))).toBe('mp4');
    expect(sniffContainer(header([0, 0, 0, 0x14], 'ftypqt  '))).toBe('mov');
  });

  it('reads the audio and video containers', () => {
    expect(sniffContainer(header([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
    expect(sniffContainer(header('OggS'))).toBe('ogg');
    expect(sniffContainer(header('fLaC'))).toBe('flac');
    expect(sniffContainer(header('ID3', [0x03, 0x00]))).toBe('mp3');
    expect(sniffContainer(header([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });

  it('says nothing rather than guessing', () => {
    expect(sniffContainer(header('<!DOCTYPE html>'))).toBeUndefined();
    expect(sniffContainer(header('{"error":"nope"}'))).toBeUndefined();
    expect(sniffContainer(new Uint8Array(0))).toBeUndefined();
  });

  it('does not mistake a JPEG-like 0xFF pair for MPEG audio', () => {
    expect(sniffContainer(header([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
  });
});

describe('contradicts', () => {
  it('flags a real mismatch', () => {
    expect(contradicts('jpg', 'webp')).toBe(true);
    expect(contradicts('gif', 'mp4')).toBe(true);
    expect(contradicts('png', 'jpg')).toBe(true);
  });

  it('leaves the same file under a different name alone', () => {
    expect(contradicts('jpg', 'jpg')).toBe(false);
    expect(contradicts('jpeg', 'jpg')).toBe(false);
    expect(contradicts('m4a', 'mp4')).toBe(false);
    expect(contradicts('opus', 'ogg')).toBe(false);
    expect(contradicts('mkv', 'webm')).toBe(false);
  });
});
