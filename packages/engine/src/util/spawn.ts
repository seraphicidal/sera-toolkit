import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { seraError } from '../errors.js';

export interface RunOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  readonly captureStdout?: boolean;
  readonly maxStdoutBytes?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderrTail: string;
}

const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_LINES = 40;
const KILL_GRACE_MS = 3_000;

function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    LC_ALL: 'C',
    LANG: 'C',
  };
  if (process.platform === 'win32') {
    base.SYSTEMROOT = process.env.SYSTEMROOT ?? '';
    base.WINDIR = process.env.WINDIR ?? '';
    base.PATHEXT = process.env.PATHEXT ?? '';
  }
  return { ...base, ...extra };
}

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

function signalTree(child: PipedChild, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminate(child: PipedChild): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalTree(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref();
}

export async function run(command: string, options: RunOptions): Promise<RunResult> {
  if (options.signal?.aborted) throw seraError('CANCELLED');

  const child = spawn(command, [...options.args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let overflowed = false;
  const stderrTail: string[] = [];

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, options.timeoutMs);

  const onAbort = () => terminate(child);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  if (options.onStdoutLine) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', options.onStdoutLine);
  }
  if (options.captureStdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        overflowed = true;
        terminate(child);
        return;
      }
      stdoutChunks.push(chunk);
    });
  }
  if (!options.onStdoutLine && !options.captureStdout) child.stdout.resume();

  {
    const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      options.onStderrLine?.(line);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });
  }

  let code: number;
  try {
    const [exitCode] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    code = exitCode ?? -1;
  } catch (cause) {
    throw seraError('INTERNAL', {
      detail: `failed to start ${command}`,
      cause,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const stderr = stderrTail.join('\n');

  if (options.signal?.aborted) throw seraError('CANCELLED');
  if (timedOut) {
    throw seraError('TIMEOUT', { detail: `${command} exceeded ${options.timeoutMs}ms` });
  }
  if (overflowed) {
    throw seraError('TOO_LARGE', { detail: `${command} produced more than ${maxStdout} bytes` });
  }

  return {
    code,
    stdout: options.captureStdout ? Buffer.concat(stdoutChunks).toString('utf8') : '',
    stderrTail: stderr,
  };
}
