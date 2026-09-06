import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Logger } from '../logging.js';
import { seraError } from '../errors.js';
import { assertSafeFilename } from '../util/filename.js';

/**
 * Per-job scratch space.
 *
 * Every job gets its own directory and nothing is ever written outside it. The API and
 * the workers reach files only through `resolveFile`, which re-derives the path from the
 * job id and a validated bare filename — so a request for `../../etc/passwd` cannot
 * name a path at all, rather than being caught by a check that might be forgotten.
 */

/** Written by the worker, read by the API when it serves the result. */
export interface JobManifest {
  readonly jobId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly primary: string;
  readonly isArchive: boolean;
  readonly files: readonly {
    readonly name: string;
    readonly sizeBytes: number;
    readonly mimeType: string;
  }[];
}

const MANIFEST_NAME = 'manifest.json';
const OUTPUT_DIR = 'out';
const SCRATCH_DIR = 'work';

export class WorkspaceManager {
  constructor(
    private readonly rootDir: string,
    private readonly retentionSeconds: number,
    private readonly logger: Logger,
  ) {}

  /** The directory for a job. Job ids are hex, so they cannot contain a separator. */
  private jobDir(jobId: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(jobId)) {
      throw seraError('NOT_FOUND', { detail: 'malformed job id' });
    }
    return join(this.rootDir, jobId);
  }

  async create(jobId: string): Promise<Workspace> {
    const base = this.jobDir(jobId);
    const scratch = join(base, SCRATCH_DIR);
    const output = join(base, OUTPUT_DIR);
    await mkdir(scratch, { recursive: true });
    await mkdir(output, { recursive: true });
    return new Workspace(jobId, base, scratch, output);
  }

  async readManifest(jobId: string): Promise<JobManifest | undefined> {
    try {
      const raw = await readFile(join(this.jobDir(jobId), MANIFEST_NAME), 'utf8');
      return JSON.parse(raw) as JobManifest;
    } catch {
      return undefined;
    }
  }

  /**
   * Maps a job id and filename onto an absolute path inside that job's output directory.
   *
   * The filename is validated as a bare name first, then the joined path is checked to
   * still be under the output directory. Two independent guards, because this is the one
   * function that turns user input into a filesystem read.
   */
  async resolveFile(jobId: string, filename: string): Promise<string> {
    let safe: string;
    try {
      safe = assertSafeFilename(filename);
    } catch {
      throw seraError('NOT_FOUND', { detail: 'unsafe filename requested' });
    }

    const outputDir = resolve(join(this.jobDir(jobId), OUTPUT_DIR));
    const path = resolve(join(outputDir, safe));
    if (path !== outputDir && !path.startsWith(outputDir + sep)) {
      throw seraError('NOT_FOUND', { detail: 'path escaped workspace' });
    }

    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw seraError('NOT_FOUND');
    return path;
  }

  async destroy(jobId: string): Promise<void> {
    await rm(this.jobDir(jobId), { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Deletes every workspace past its retention window.
   *
   * Retention is the privacy guarantee, so the reaper is deliberately dumb: it deletes by
   * directory age and does not consult the job store. A crashed worker or a lost job
   * record therefore cannot leave media on disk indefinitely.
   */
  async reap(now = Date.now()): Promise<number> {
    let removed = 0;
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.rootDir, entry.name);
      try {
        const info = await stat(path);
        const ageSeconds = (now - info.mtimeMs) / 1000;
        if (ageSeconds < this.retentionSeconds) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.logger.warn({ err: error, workspace: entry.name }, 'failed to reap workspace');
      }
    }
    if (removed) this.logger.info({ removed }, 'reaped expired workspaces');
    return removed;
  }

  /** Starts the periodic sweep. Returns a function that stops it. */
  startReaper(intervalSeconds: number): () => void {
    const timer = setInterval(() => {
      void this.reap().catch((error: unknown) => {
        this.logger.error({ err: error }, 'reaper failed');
      });
    }, intervalSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Total bytes currently held across all workspaces. */
  async usage(): Promise<{ workspaces: number; bytes: number }> {
    let workspaces = 0;
    let bytes = 0;
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      workspaces += 1;
      bytes += await directorySize(join(this.rootDir, entry.name));
    }
    return { workspaces, bytes };
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else
      total += await stat(path)
        .then((s) => s.size)
        .catch(() => 0);
  }
  return total;
}

/** A single job's directories, handed to the pipeline. */
export class Workspace {
  constructor(
    readonly jobId: string,
    readonly baseDir: string,
    /** Downloads and intermediate files. Never served. */
    readonly scratchDir: string,
    /** Finished files. Only these are reachable over HTTP. */
    readonly outputDir: string,
  ) {}

  scratchPath(name: string): string {
    return join(this.scratchDir, assertSafeFilename(name));
  }

  outputPath(name: string): string {
    return join(this.outputDir, assertSafeFilename(name));
  }

  async writeManifest(manifest: JobManifest): Promise<void> {
    await writeFile(join(this.baseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  }

  /** Removes intermediate files once the outputs are final. */
  async clearScratch(): Promise<void> {
    await rm(this.scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async listOutputs(): Promise<{ name: string; sizeBytes: number }[]> {
    const entries = await readdir(this.outputDir, { withFileTypes: true }).catch(() => []);
    const files: { name: string; sizeBytes: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const size = await stat(join(this.outputDir, entry.name))
        .then((s) => s.size)
        .catch(() => 0);
      files.push({ name: entry.name, sizeBytes: size });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** A short, stable, filesystem-safe token derived from arbitrary text. */
export function shortHash(input: string, length = 8): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/** Content types for the containers SERA produces. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  zip: 'application/zip',
  bin: 'application/octet-stream',
};

export function mimeTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}
