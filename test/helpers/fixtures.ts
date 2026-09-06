import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { locateTool } from '@sera/engine';

/**
 * Real media, generated once with FFmpeg and reused by the end-to-end tests.
 *
 * Synthesising the fixtures rather than committing binaries keeps the repository small
 * and, more importantly, means the pipeline is exercised against files a real encoder
 * produced: containers with proper indexes, actual keyframes, a genuine audio stream.
 * A hand-written stub would pass the same assertions while proving much less.
 */

export const FIXTURE_DIR = resolve(import.meta.dirname, '..', '..', '.data', 'fixtures');

export const ffmpegPath = locateTool('ffmpeg', '');
export const ffprobePath = locateTool('ffprobe', '');
export const ytdlpPath = locateTool('yt-dlp', '');

export interface Fixtures {
  /** 3s H.264 + AAC, 640x360. */
  readonly video: string;
  /** 3s H.264 only, no audio track: what platforms call a GIF. */
  readonly silentVideo: string;
  /** 2s MP3. */
  readonly audio: string;
  /** A single JPEG frame. */
  readonly image: string;
  /** A short animated GIF. */
  readonly gif: string;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

let cached: Fixtures | undefined;

/** Builds the fixture set if it is not already on disk. */
export async function ensureFixtures(): Promise<Fixtures> {
  if (cached) return cached;
  await mkdir(FIXTURE_DIR, { recursive: true });

  const paths: Fixtures = {
    video: join(FIXTURE_DIR, 'sample.mp4'),
    silentVideo: join(FIXTURE_DIR, 'silent.mp4'),
    audio: join(FIXTURE_DIR, 'sample.mp3'),
    image: join(FIXTURE_DIR, 'sample.jpg'),
    gif: join(FIXTURE_DIR, 'sample.gif'),
  };

  if (!existsSync(paths.video)) {
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=24:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      paths.video,
    ]);
  }

  if (!existsSync(paths.silentVideo)) {
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x320:rate=15:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      paths.silentVideo,
    ]);
  }

  if (!existsSync(paths.audio)) {
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=2',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      paths.audio,
    ]);
  }

  if (!existsSync(paths.image)) {
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=800x600:rate=1:duration=1',
      '-frames:v',
      '1',
      paths.image,
    ]);
  }

  if (!existsSync(paths.gif)) {
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=10:duration=2',
      '-vf',
      'fps=10,scale=160:-1:flags=lanczos',
      '-loop',
      '0',
      paths.gif,
    ]);
  }

  cached = paths;
  return paths;
}

export interface ProbeSummary {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly durationSeconds: number;
  readonly formatName: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Reads a produced file with ffprobe, so assertions are about real media. */
export async function probeFile(path: string): Promise<ProbeSummary> {
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(stdout) : rejectPromise(new Error(`ffprobe exited ${code}`)),
    );
  });

  const parsed = JSON.parse(output) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  };
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');

  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    durationSeconds: Number(parsed.format?.duration ?? 0),
    formatName: parsed.format?.format_name ?? '',
    ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
  };
}

/** First bytes of a file, for magic-number checks. */
export async function magic(path: string, length = 12): Promise<Buffer> {
  const buffer = await readFile(path);
  return buffer.subarray(0, length);
}

export function toolsAvailable(): boolean {
  return existsSync(ffmpegPath) || ffmpegPath !== 'ffmpeg';
}
