import { describe, expect, it } from 'vitest';
import { buildArgs, type ConvertRequest, type ProbeResult } from './ffmpeg.js';

function makeRequest(spec: ConvertRequest['spec'], output = '/tmp/out.mp4'): ConvertRequest {
  return {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    timeoutMs: 30_000,
    input: '/tmp/in.bin',
    output,
    spec,
  };
}

describe('ffmpeg buildArgs stream copy vs transcode', () => {
  it('uses stream copy (-c copy -movflags +faststart) when H.264 + AAC matches mp4', () => {
    const source: ProbeResult = {
      video: { codec: 'h264', width: 1920, height: 1080 },
      audio: { codec: 'aac', bitrate: 128_000 },
    };
    const args = buildArgs(makeRequest({ kind: 'video', container: 'mp4' }), source);
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).toContain('+faststart');
    expect(args).not.toContain('libx264');
  });

  it('transcodes with libx264 when converting GIF or VP9 to mp4', () => {
    const source: ProbeResult = {
      video: { codec: 'gif', width: 480, height: 480 },
    };
    const args = buildArgs(makeRequest({ kind: 'video', container: 'mp4' }), source);
    expect(args).toContain('libx264');
    expect(args).toContain('-an');
  });

  it('uses stream copy (-c copy) when VP9 + Opus matches webm', () => {
    const source: ProbeResult = {
      video: { codec: 'vp9', width: 1280, height: 720 },
      audio: { codec: 'opus' },
    };
    const args = buildArgs(
      makeRequest({ kind: 'video', container: 'webm' }, '/tmp/out.webm'),
      source,
    );
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).not.toContain('libvpx-vp9');
  });

  it('transcodes with libvpx-vp9 when converting H.264 to webm', () => {
    const source: ProbeResult = {
      video: { codec: 'h264', width: 1280, height: 720 },
      audio: { codec: 'aac' },
    };
    const args = buildArgs(
      makeRequest({ kind: 'video', container: 'webm' }, '/tmp/out.webm'),
      source,
    );
    expect(args).toContain('libvpx-vp9');
    expect(args).toContain('libopus');
  });
});
