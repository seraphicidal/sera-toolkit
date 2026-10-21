import { extname } from 'node:path';
import type { TrimRange } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { run } from '../util/spawn.js';
import { probe, type FfmpegOptions } from './ffmpeg.js';

export const KEYFRAME_TOLERANCE_SECONDS = 0.25;

export interface TrimMediaRequest extends FfmpegOptions {
  readonly input: string;
  readonly output: string;
  readonly range: TrimRange;
  readonly threads?: number;
}

export function copyIsAccurate(start: number, keyframe: number | undefined): boolean {
  if (start <= 0) return true;
  return keyframe !== undefined && start - keyframe <= KEYFRAME_TOLERANCE_SECONDS;
}

export async function keyframeAtOrBefore(
  path: string,
  seconds: number,
  options: FfmpegOptions,
): Promise<number | undefined> {
  const from = Math.max(0, seconds - 30);
  const result = await run(options.ffprobePath, {
    args: [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe,data',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      '-read_intervals',
      `${from}%${seconds + 1}`,
      '-i',
      path,
    ],
    timeoutMs: Math.min(options.timeoutMs, 30_000),
    captureStdout: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.code !== 0) return undefined;
  const times = result.stdout
    .split('\n')
    .map((line) => Number.parseFloat(line))
    .filter((value) => Number.isFinite(value) && value <= seconds + 0.01);
  return times.length ? Math.max(...times) : undefined;
}

const AUDIO_ONLY_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);

function reencodeArgs(extension: string): string[] {
  if (AUDIO_ONLY_EXTENSIONS.has(extension)) {
    switch (extension) {
      case 'mp3':
        return ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
      case 'opus':
        return ['-vn', '-c:a', 'libopus', '-b:a', '160k'];
      case 'ogg':
        return ['-vn', '-c:a', 'libvorbis', '-b:a', '192k'];
      case 'wav':
        return ['-vn', '-c:a', 'pcm_s16le'];
      case 'flac':
        return ['-vn', '-c:a', 'flac'];
      default:
        return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
    }
  }
  if (extension === 'webm') {
    return [...videoCodecArgs(extension), '-c:a', 'libopus', '-b:a', '160k'];
  }
  return [...videoCodecArgs(extension), '-c:a', 'aac', '-b:a', '192k'];
}

function videoCodecArgs(extension: string): string[] {
  if (extension === 'webm') {
    return [
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '32',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
    ];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

export async function trimMedia(request: TrimMediaRequest): Promise<{ reencoded: boolean }> {
  const { range } = request;
  const source = await probe(request.input, request);
  const extension = extname(request.output).slice(1).toLowerCase();
  const hasVideo = Boolean(source.video) && !AUDIO_ONLY_EXTENSIONS.has(extension);
  const keyframe =
    hasVideo && range.start > 0
      ? await keyframeAtOrBefore(request.input, range.start, request)
      : undefined;
  const copy = !hasVideo || copyIsAccurate(range.start, keyframe);

  const length = range.end !== undefined ? range.end - range.start : undefined;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-protocol_whitelist',
    'file,pipe,data',
    '-ss',
    String(range.start),
    '-i',
    request.input,
    ...(length !== undefined ? ['-t', String(length)] : []),
    ...(copy ? ['-c', 'copy'] : reencodeArgs(extension)),
    '-avoid_negative_ts',
    'make_zero',
    '-threads',
    String(request.threads ?? 2),
    ...(extension === 'mp4' || extension === 'mov' || extension === 'm4a'
      ? ['-movflags', '+faststart']
      : []),
    request.output,
  ];

  const result = await run(request.ffmpegPath, {
    args,
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (result.code !== 0) {
    throw seraError('CONVERSION_FAILED', {
      message: 'The media was downloaded, but trimming it failed.',
      detail: `ffmpeg trim exit ${result.code}: ${result.stderrTail.slice(-500)}`,
    });
  }
  return { reencoded: !copy };
}
