import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { convert } from './ffmpeg.js';

/**
 * The bound the input's bound does not give you.
 *
 * A download is capped, and a duration is capped, and neither caps what a re-encode
 * writes — a transcode can be larger than what it was handed. Without a ceiling on the
 * output, a job that is legitimate at every earlier step can still fill the disk of a
 * host with a few gigabytes free.
 */

const run = promisify(execFile);
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERA_SECRET: 'bounds-secret',
  SERA_DATA_DIR: '.data/test',
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sera-bounds-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A real file, because a stand-in would only prove that the argument was passed. */
async function source(): Promise<string> {
  const path = join(dir, 'source.mp4');
  await run(config.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x480:rate=25:duration=4',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  return path;
}

describe('a conversion cannot write more than it was allowed', () => {
  it('stops at the ceiling instead of filling the disk', async () => {
    const input = await source();
    const output = join(dir, 'out.gif');

    // A GIF of four seconds of colour bars is far larger than this. Without the bound
    // FFmpeg writes all of it.
    await convert({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: 60_000,
      input,
      output,
      spec: { kind: 'gif', fps: 15, maxWidth: 480 },
      maxOutputBytes: 32 * 1024,
    });

    const written = await stat(output);
    // Measured: 626,876 bytes unbounded, 46,372 with this ceiling. FFmpeg stops on the
    // next frame boundary after the limit rather than exactly on it, so the assertion is
    // that it stopped near the ceiling and nowhere near the whole file.
    expect(written.size).toBeLessThan(256 * 1024);
  }, 90_000);

  it('writes the whole thing when the ceiling is not in the way', async () => {
    const input = await source();
    const bounded = join(dir, 'bounded.gif');
    const unbounded = join(dir, 'unbounded.gif');

    await convert({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: 60_000,
      input,
      output: unbounded,
      spec: { kind: 'gif', fps: 15, maxWidth: 480 },
    });
    await convert({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      timeoutMs: 60_000,
      input,
      output: bounded,
      spec: { kind: 'gif', fps: 15, maxWidth: 480 },
      maxOutputBytes: 512 * 1024 * 1024,
    });

    // The ceiling is a ceiling, not a change of behaviour.
    const [a, b] = await Promise.all([stat(unbounded), stat(bounded)]);
    expect(b.size).toBe(a.size);
    expect(a.size).toBeGreaterThan(256 * 1024);
  }, 120_000);
});
