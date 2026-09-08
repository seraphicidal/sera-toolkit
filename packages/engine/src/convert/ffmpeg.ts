import { basename, dirname, join } from 'node:path';
import { seraError } from '../errors.js';
import { run } from '../util/spawn.js';

/**
 * FFmpeg and ffprobe adapter.
 *
 * Conversions are described declaratively and turned into an argument array here, so no
 * caller ever assembles a command line. Every recipe prefers `-c copy` where the source
 * already satisfies the request: re-encoding costs minutes of CPU and loses quality, and
 * most "convert to MP4" requests are really remux requests.
 */

export interface FfmpegOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ProbeResult {
  readonly durationSeconds?: number;
  readonly formatName?: string;
  readonly sizeBytes?: number;
  readonly bitrate?: number;
  readonly video?: {
    readonly codec: string;
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
  };
  readonly audio?: {
    readonly codec: string;
    readonly channels?: number;
    readonly sampleRate?: number;
    readonly bitrate?: number;
  };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

/** Reads a file's real properties, used both for UI detail and for output validation. */
export async function probe(path: string, options: FfmpegOptions): Promise<ProbeResult> {
  const result = await run(options.ffprobePath, {
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
    timeoutMs: Math.min(options.timeoutMs, 30_000),
    captureStdout: true,
    maxStdoutBytes: 4 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (result.code !== 0) {
    throw seraError('CONVERSION_FAILED', {
      message: 'The downloaded file could not be read.',
      detail: `ffprobe exit ${result.code}: ${result.stderrTail.slice(-400)}`,
    });
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch (cause) {
    throw seraError('CONVERSION_FAILED', { detail: 'unparseable ffprobe output', cause });
  }

  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');

  const out: {
    durationSeconds?: number;
    formatName?: string;
    sizeBytes?: number;
    bitrate?: number;
    video?: ProbeResult['video'];
    audio?: ProbeResult['audio'];
  } = {};

  const duration = Number(parsed.format?.duration);
  if (Number.isFinite(duration) && duration > 0) out.durationSeconds = duration;
  if (parsed.format?.format_name) out.formatName = parsed.format.format_name;
  const size = Number(parsed.format?.size);
  if (Number.isFinite(size)) out.sizeBytes = size;
  const bitrate = Number(parsed.format?.bit_rate);
  if (Number.isFinite(bitrate)) out.bitrate = bitrate;

  if (video?.codec_name) {
    out.video = {
      codec: video.codec_name,
      ...(video.width ? { width: video.width } : {}),
      ...(video.height ? { height: video.height } : {}),
      ...(parseFrameRate(video.avg_frame_rate) !== undefined
        ? { fps: parseFrameRate(video.avg_frame_rate)! }
        : {}),
    };
  }
  if (audio?.codec_name) {
    const audioBitrate = Number(audio.bit_rate);
    out.audio = {
      codec: audio.codec_name,
      ...(audio.channels ? { channels: audio.channels } : {}),
      ...(audio.sample_rate ? { sampleRate: Number(audio.sample_rate) } : {}),
      ...(Number.isFinite(audioBitrate) ? { bitrate: audioBitrate } : {}),
    };
  }
  return out;
}

/** `30000/1001` -> `29.97`. */
function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return undefined;
  return Math.round((numerator / denominator) * 100) / 100;
}

export type ConversionSpec =
  /** Extract or transcode audio. */
  | {
      readonly kind: 'audio';
      readonly container: 'mp3' | 'm4a' | 'aac' | 'opus' | 'ogg' | 'wav' | 'flac';
      readonly bitrateKbps?: number;
    }
  /** Change container only; fails rather than silently re-encoding. */
  | { readonly kind: 'remux'; readonly container: 'mp4' | 'webm' | 'mov' | 'mkv' }
  /** Video to animated GIF, via a generated palette. */
  | { readonly kind: 'gif'; readonly fps?: number; readonly maxWidth?: number }
  /** GIF (or any video) to a modern video container. */
  | { readonly kind: 'video'; readonly container: 'mp4' | 'webm' };

export interface ConvertRequest extends FfmpegOptions {
  readonly input: string;
  readonly output: string;
  readonly spec: ConversionSpec;
  /** Source duration in seconds; enables percentage progress. */
  readonly durationSeconds?: number;
  /**
   * Ceiling on what the conversion may write.
   *
   * The input is bounded and the duration is bounded, and neither bounds the output: a
   * re-encode can be larger than what it was given. FFmpeg stops writing here rather
   * than filling the disk, and the caller's own check turns the short file into an
   * honest "too large" instead of a confusing "conversion failed".
   */
  readonly maxOutputBytes?: number;
  readonly onProgress?: (percent: number) => void;
}

/** Audio encoder settings per container. */
const AUDIO_ENCODERS: Record<string, { codec: string; extra?: string[] }> = {
  mp3: { codec: 'libmp3lame' },
  m4a: { codec: 'aac' },
  aac: { codec: 'aac' },
  opus: { codec: 'libopus' },
  ogg: { codec: 'libvorbis' },
  wav: { codec: 'pcm_s16le' },
  flac: { codec: 'flac' },
};

/** Codecs that can be copied straight into a container rather than re-encoded. */
const COPYABLE_AUDIO: Record<string, readonly string[]> = {
  mp3: ['mp3'],
  m4a: ['aac'],
  aac: ['aac'],
  opus: ['opus'],
  ogg: ['vorbis'],
  flac: ['flac'],
  wav: [],
};

function audioArgs(
  spec: Extract<ConversionSpec, { kind: 'audio' }>,
  sourceAudioCodec: string | undefined,
): string[] {
  const canCopy = (COPYABLE_AUDIO[spec.container] ?? []).includes(sourceAudioCodec ?? '');
  if (canCopy) return ['-vn', '-c:a', 'copy'];

  const encoder = AUDIO_ENCODERS[spec.container];
  /* c8 ignore next -- container is constrained by the ConversionSpec union */
  if (!encoder)
    throw seraError('CONVERSION_FAILED', { detail: `no encoder for ${spec.container}` });

  const args = ['-vn', '-c:a', encoder.codec, ...(encoder.extra ?? [])];
  if (spec.bitrateKbps && spec.container !== 'wav' && spec.container !== 'flac') {
    args.push('-b:a', `${spec.bitrateKbps}k`);
  }
  return args;
}

function buildArgs(request: ConvertRequest, source: ProbeResult): string[] {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    request.input,
    // Bound what a single conversion can consume on a shared host.
    '-threads',
    '2',
    '-max_muxing_queue_size',
    '1024',
  ];

  switch (request.spec.kind) {
    case 'audio':
      args.push(...audioArgs(request.spec, source.audio?.codec));
      // Carry the source tags across so a converted MP3 keeps its title and artist.
      args.push('-map_metadata', '0', '-id3v2_version', '3');
      break;

    case 'remux':
      args.push('-c', 'copy');
      if (request.spec.container === 'mp4' || request.spec.container === 'mov') {
        args.push('-movflags', '+faststart');
      }
      break;

    case 'gif': {
      const fps = request.spec.fps ?? 15;
      const width = request.spec.maxWidth ?? 480;
      // A generated palette is the difference between a usable GIF and a dithered mess;
      // `split` lets one pass build the palette and apply it without a temp file.
      args.push(
        '-filter_complex',
        `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        '-loop',
        '0',
      );
      break;
    }

    case 'video':
      if (request.spec.container === 'mp4') {
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          // Odd dimensions are legal in a GIF and illegal in H.264.
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-movflags',
          '+faststart',
        );
        args.push(source.audio ? '-c:a' : '-an', ...(source.audio ? ['aac', '-b:a', '160k'] : []));
      } else {
        args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1');
        args.push(
          source.audio ? '-c:a' : '-an',
          ...(source.audio ? ['libopus', '-b:a', '128k'] : []),
        );
      }
      break;
  }

  if (request.maxOutputBytes) args.push('-fs', String(request.maxOutputBytes));
  args.push('-progress', 'pipe:1', '-nostats', request.output);
  return args;
}

/** Runs one conversion, reporting 0-100 progress derived from the output timestamp. */
export async function convert(request: ConvertRequest): Promise<void> {
  const source = await probe(request.input, request);
  const duration = request.durationSeconds ?? source.durationSeconds;

  if (request.spec.kind === 'audio' && !source.audio) {
    throw seraError('CONVERSION_FAILED', {
      message: 'This media has no audio track to extract.',
      hint: 'Choose a video format instead.',
      detail: 'no audio stream in source',
    });
  }

  let lastPercent = 0;
  const onLine = (line: string): void => {
    const [key, value] = line.split('=');
    if (key !== 'out_time_us' && key !== 'out_time_ms') return;
    if (!duration || duration <= 0 || !value || value === 'N/A') return;
    // `out_time_ms` is a misnomer: FFmpeg reports microseconds in both fields.
    const micros = Number(value);
    if (!Number.isFinite(micros)) return;
    const percent = Math.min(99, (micros / 1_000_000 / duration) * 100);
    if (percent > lastPercent) {
      lastPercent = percent;
      request.onProgress?.(percent);
    }
  };

  const args = buildArgs(request, source);
  const result = await run(request.ffmpegPath, {
    args,
    cwd: dirname(request.output),
    timeoutMs: request.timeoutMs,
    onStdoutLine: onLine,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (result.code !== 0) {
    throw seraError('CONVERSION_FAILED', {
      detail: `ffmpeg exit ${result.code} for ${request.spec.kind}: ${result.stderrTail.slice(-500)}`,
    });
  }
  request.onProgress?.(100);
}

/** Reports the installed FFmpeg version, or throws if the binary is unusable. */
export async function ffmpegVersion(ffmpegPath: string, timeoutMs = 10_000): Promise<string> {
  const result = await run(ffmpegPath, {
    args: ['-hide_banner', '-version'],
    timeoutMs,
    captureStdout: true,
    maxStdoutBytes: 256 * 1024,
  });
  if (result.code !== 0) {
    throw seraError('INTERNAL', { detail: `ffmpeg -version exited ${result.code}` });
  }
  const first = result.stdout.split('\n')[0] ?? '';
  return /ffmpeg version (\S+)/.exec(first)?.[1] ?? first.trim();
}

/** Places `name` alongside `reference`, used to build sibling output paths. */
export function siblingPath(reference: string, name: string): string {
  return join(dirname(reference), basename(name));
}
