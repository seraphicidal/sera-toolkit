import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { convert } from './ffmpeg.js';

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

    const [a, b] = await Promise.all([stat(unbounded), stat(bounded)]);
    expect(b.size).toBe(a.size);
    expect(a.size).toBeGreaterThan(256 * 1024);
  }, 120_000);
});
