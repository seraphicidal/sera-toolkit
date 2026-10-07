import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { seraError } from '../errors.js';
import { run } from '../util/spawn.js';
import { probe, type FfmpegOptions } from './ffmpeg.js';

export const TAGGABLE_AUDIO = new Set(['mp3', 'm4a', 'opus']);

export interface AudioTags {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
}

export interface TagAudioRequest extends FfmpegOptions {
  readonly input: string;
  readonly output: string;
  readonly tags: AudioTags;
  readonly coverPath?: string;
  readonly scratchDir: string;
}

function escapeMetadata(value: string): string {
  return value.replace(/[=;#\\\n]/g, (character) => `\\${character}`);
}

export function pictureBlock(jpeg: Buffer, width: number, height: number): string {
  const mime = Buffer.from('image/jpeg', 'ascii');
  const parts: Buffer[] = [];
  const u32 = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    parts.push(b);
  };
  u32(3);
  u32(mime.length);
  parts.push(mime);
  u32(0);
  u32(width);
  u32(height);
  u32(24);
  u32(0);
  u32(jpeg.length);
  parts.push(jpeg);
  return Buffer.concat(parts).toString('base64');
}

export async function squareCover(
  input: string,
  output: string,
  options: FfmpegOptions,
): Promise<{ readonly size: number }> {
  const result = await run(options.ffmpegPath, {
    args: [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      input,
      '-vf',
      "crop='min(iw,ih)':'min(iw,ih)',scale='min(1000,iw)':-2",
      '-frames:v',
      '1',
      '-q:v',
      '3',
      output,
    ],
    timeoutMs: Math.min(options.timeoutMs, 60_000),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.code !== 0) {
    throw seraError('CONVERSION_FAILED', {
      detail: `cover crop exit ${result.code}: ${result.stderrTail.slice(-300)}`,
    });
  }
  const cover = await probe(output, options);
  return { size: cover.video?.width ?? 0 };
}

export async function tagAudio(request: TagAudioRequest): Promise<void> {
  const extension = extname(request.output).slice(1).toLowerCase();
  if (!TAGGABLE_AUDIO.has(extension)) {
    throw seraError('CONVERSION_FAILED', { detail: `cannot tag .${extension}` });
  }

  const lines = [';FFMETADATA1'];
  const { title, artist, album } = request.tags;
  if (title) lines.push(`title=${escapeMetadata(title)}`);
  if (artist) lines.push(`artist=${escapeMetadata(artist)}`);
  if (album) lines.push(`album=${escapeMetadata(album)}`);

  const oggCover = extension === 'opus' && request.coverPath;
  if (oggCover) {
    const jpeg = await readFile(request.coverPath);
    const cover = await probe(request.coverPath, request);
    const side = cover.video?.width ?? 0;
    lines.push(`METADATA_BLOCK_PICTURE=${escapeMetadata(pictureBlock(jpeg, side, side))}`);
  }

  const metadataPath = `${request.scratchDir}/tags.ffmeta`;
  await writeFile(metadataPath, `${lines.join('\n')}\n`, 'utf8');

  const picture = request.coverPath && !oggCover;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    request.input,
    '-i',
    metadataPath,
    ...(picture ? ['-i', request.coverPath] : []),
    '-map',
    '0:a',
    ...(picture ? ['-map', '2:v'] : []),
    '-map_metadata',
    '1',
    '-c',
    'copy',
    ...(picture ? ['-disposition:v', 'attached_pic', '-metadata:s:v', 'title=Cover'] : []),
    ...(extension === 'mp3' ? ['-id3v2_version', '3'] : []),
    request.output,
  ];

  const result = await run(request.ffmpegPath, {
    args,
    timeoutMs: Math.min(request.timeoutMs, 120_000),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (result.code !== 0) {
    throw seraError('CONVERSION_FAILED', {
      detail: `ffmpeg tag exit ${result.code}: ${result.stderrTail.slice(-500)}`,
    });
  }
}
