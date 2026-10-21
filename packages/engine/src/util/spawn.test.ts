import { describe, expect, it } from 'vitest';
import { run } from './spawn.js';

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
