import { describe, expect, it } from 'vitest';
import { run } from './spawn.js';

/**
 * Stopping a process stops what it started.
 *
 * yt-dlp runs FFmpeg as its own child. Ending yt-dlp alone left FFmpeg running, holding the
 * pipes it inherited, so `run` never saw them close and a cancelled job never finished. A
 * shell stands in for yt-dlp here, running a long command as its child the way yt-dlp runs
 * FFmpeg. (Not Node: on Windows a Node parent puts its children in a job object that dies
 * with it, which hides the problem.)
 */

const [shell, args] =
  process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', 'ping -n 30 127.0.0.1 & echo done']]
    : ['sh', ['-c', 'sleep 30; echo done']];

describe('cancelling a run', () => {
  it('ends the process and the child it started, and returns at once', async () => {
    const controller = new AbortController();
    const running = run(shell, { args, timeoutMs: 60_000, signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    // The child had the pipes too; returning at all means it is gone.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
});

describe('a run that finishes', () => {
  it('is unaffected', async () => {
    const result = await run(process.execPath, {
      args: ['-e', 'process.stdout.write("ok")'],
      timeoutMs: 10_000,
      captureStdout: true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok');
  });
});
