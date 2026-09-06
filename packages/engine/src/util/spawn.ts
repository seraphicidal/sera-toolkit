import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { seraError } from '../errors.js';

/**
 * The only way the engine starts an external process.
 *
 * `shell` is never enabled and arguments are always passed as an array, so no part of a
 * user-supplied URL is ever parsed by a command interpreter. Callers must additionally
 * place `--` before any positional argument that could begin with a dash.
 */
export interface RunOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Kills the process after this many milliseconds. */
  readonly timeoutMs: number;
  /** Called for each complete stdout line. */
  readonly onStdoutLine?: (line: string) => void;
  /** Called for each complete stderr line. */
  readonly onStderrLine?: (line: string) => void;
  /** Collect stdout into the result. Off by default to avoid buffering large output. */
  readonly captureStdout?: boolean;
  /** Upper bound on captured stdout; beyond this the process is killed. */
  readonly maxStdoutBytes?: number;
  /** Aborts the run; the process is killed and `CANCELLED` is thrown. */
  readonly signal?: AbortSignal;
  /**
   * Environment for the child. A minimal env is used by default so the child cannot
   * inherit credentials or proxy settings that were meant for the server itself.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  /** The last few stderr lines, for diagnostics. Bounded so a chatty tool cannot blow up memory. */
  readonly stderrTail: string;
}

const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_LINES = 40;
/** Grace period between asking a process to stop and forcing it. */
const KILL_GRACE_MS = 3_000;

/** A deliberately small environment for child processes. */
function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    // FFmpeg and yt-dlp both write temp files; keep them pointed at the sandbox.
    TMPDIR: process.env.TMPDIR ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    // Predictable, parseable tool output regardless of the host locale.
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

/** stdin is ignored, so the child exposes only stdout and stderr. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

/** Terminates a child, escalating to SIGKILL if it lingers. */
function terminate(child: PipedChild): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref();
}

/**
 * Runs `command` with `args` and resolves once it exits.
 *
 * Rejects with a `SeraError` on timeout, abort, or a non-zero exit code; the caller is
 * expected to translate the exit code into something the user can read.
 */
export async function run(command: string, options: RunOptions): Promise<RunResult> {
  if (options.signal?.aborted) throw seraError('CANCELLED');

  const child = spawn(command, [...options.args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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

/** True when `value` could be mistaken for a command-line flag. */
export function looksLikeFlag(value: string): boolean {
  return value.startsWith('-');
}
