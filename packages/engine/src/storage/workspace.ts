import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Logger } from '../logging.js';
import { seraError } from '../errors.js';
import { assertSafeFilename } from '../util/filename.js';

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
const ACTIVE_LEASE_NAME = '.active';
const DOWNLOAD_LEASE_PREFIX = '.dl-';
const DOWNLOAD_LEASE_REFRESH_MS = 60_000;
const DOWNLOAD_LEASE_TTL_SECONDS = 180;
const MAX_ACTIVE_LEASE_SECONDS = 3600;
const WORKSPACE_DIR_PATTERN = /^(?:remote-)?[a-f0-9]{16,64}$/i;
const USAGE_SCAN_CONCURRENCY = 8;
const OUTPUT_DIR = 'out';
const SCRATCH_DIR = 'work';

export class WorkspaceManager {
  private readonly activeJobs = new Set<string>();
  private readonly activeDownloads = new Map<string, number>();
  private readonly activeLeaseOps = new Map<string, Promise<void>>();

  constructor(
    private readonly rootDir: string,
    private readonly retentionSeconds: number,
    private readonly logger: Logger,
  ) {}

  private enqueueActiveLeaseOp(jobId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.activeLeaseOps.get(jobId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(op)
      .catch(() => undefined);
    const tracked = next.finally(() => {
      if (this.activeLeaseOps.get(jobId) === tracked) {
        this.activeLeaseOps.delete(jobId);
      }
    });
    this.activeLeaseOps.set(jobId, tracked);
    return tracked;
  }

  markActive(jobId: string): void {
    this.activeJobs.add(jobId);
    const leasePath = join(this.jobDir(jobId), ACTIVE_LEASE_NAME);
    void this.enqueueActiveLeaseOp(jobId, () =>
      writeFile(leasePath, String(process.pid)).catch(() => undefined),
    );
  }

  markInactive(jobId: string): void {
    this.activeJobs.delete(jobId);
    const leasePath = join(this.jobDir(jobId), ACTIVE_LEASE_NAME);
    void this.enqueueActiveLeaseOp(jobId, () => unlink(leasePath).catch(() => undefined));
  }

  acquireDownload(jobId: string): () => void {
    this.activeDownloads.set(jobId, (this.activeDownloads.get(jobId) ?? 0) + 1);
    let leasePath: string | undefined;
    let leaseOp: Promise<void> = Promise.resolve();
    try {
      leasePath = join(
        this.jobDir(jobId),
        `${DOWNLOAD_LEASE_PREFIX}${String(process.pid)}-${randomBytes(6).toString('hex')}`,
      );
      const target = leasePath;
      leaseOp = writeFile(target, String(process.pid)).catch(() => undefined);
    } catch {
      leasePath = undefined;
    }
    let released = false;
    const refreshTimer = leasePath
      ? setInterval(() => {
          const target = leasePath!;
          leaseOp = leaseOp.then(() => {
            if (released) return;
            const now = new Date();
            return utimes(target, now, now).catch(() => undefined);
          });
        }, DOWNLOAD_LEASE_REFRESH_MS)
      : undefined;
    refreshTimer?.unref();

    return () => {
      if (released) return;
      released = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (leasePath) {
        const target = leasePath;
        leaseOp = leaseOp.then(() => unlink(target).catch(() => undefined));
      }
      const next = (this.activeDownloads.get(jobId) ?? 1) - 1;
      if (next <= 0) this.activeDownloads.delete(jobId);
      else this.activeDownloads.set(jobId, next);
    };
  }

  async touch(jobId: string): Promise<void> {
    const dir = this.jobDir(jobId);
    const now = new Date();
    await utimes(dir, now, now).catch(() => undefined);
  }

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
    if (this.activeJobs.has(jobId)) {
      await this.enqueueActiveLeaseOp(jobId, () =>
        this.activeJobs.has(jobId)
          ? writeFile(join(base, ACTIVE_LEASE_NAME), String(process.pid)).catch(() => undefined)
          : Promise.resolve(),
      );
    }
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

    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) throw seraError('NOT_FOUND');
    return path;
  }

  async destroy(jobId: string): Promise<void> {
    this.activeJobs.delete(jobId);
    await (this.activeLeaseOps.get(jobId) ?? Promise.resolve());
    await rm(this.jobDir(jobId), { recursive: true, force: true }).catch(() => undefined);
  }

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
      if (!WORKSPACE_DIR_PATTERN.test(entry.name)) continue;
      if (this.activeJobs.has(entry.name) || this.activeDownloads.has(entry.name)) continue;

      const path = join(this.rootDir, entry.name);
      try {
        const lease = await stat(join(path, ACTIVE_LEASE_NAME)).catch(() => undefined);
        if (
          lease &&
          (now - lease.mtimeMs) / 1000 < Math.max(this.retentionSeconds, MAX_ACTIVE_LEASE_SECONDS)
        ) {
          continue;
        }
        if (await hasActiveDownloadLease(path, now)) {
          continue;
        }
        const info = await stat(path);
        let newestMs = info.mtimeMs;
        if (entry.name.startsWith('remote-')) {
          newestMs = Math.max(newestMs, await latestEntryMtime(path));
        }
        const ageSeconds = (now - newestMs) / 1000;
        if (ageSeconds < this.retentionSeconds) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.logger.warn({ err: error, workspace: entry.name }, 'failed to reap workspace');
      }
    }
    if (removed) {
      this.logger.info({ removed }, 'reaped expired workspaces');
      void this.usage(true).catch(() => undefined);
    }
    return removed;
  }

  startReaper(intervalSeconds: number): () => void {
    const timer = setInterval(() => {
      void this.reap().catch((error: unknown) => {
        this.logger.error({ err: error }, 'reaper failed');
      });
    }, intervalSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private cachedUsage: { workspaces: number; bytes: number; expiresAt: number } | undefined;
  private usageInFlight: Promise<{ workspaces: number; bytes: number }> | undefined;

  async usage(force = false): Promise<{ workspaces: number; bytes: number }> {
    const now = Date.now();
    if (!force && this.cachedUsage && now < this.cachedUsage.expiresAt) {
      return { workspaces: this.cachedUsage.workspaces, bytes: this.cachedUsage.bytes };
    }
    if (this.usageInFlight) return this.usageInFlight;
    this.usageInFlight = this.computeUsage()
      .then((usage) => {
        this.cachedUsage = { ...usage, expiresAt: Date.now() + 60_000 };
        return usage;
      })
      .finally(() => {
        this.usageInFlight = undefined;
      });
    return this.usageInFlight;
  }

  private async computeUsage(): Promise<{ workspaces: number; bytes: number }> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter(
      (entry) => entry.isDirectory() && WORKSPACE_DIR_PATTERN.test(entry.name),
    );
    let bytes = 0;
    let cursor = 0;
    const workerCount = Math.min(USAGE_SCAN_CONCURRENCY, dirs.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= dirs.length) return;
        const size = await directorySize(join(this.rootDir, dirs[index]!.name));
        bytes += size;
      }
    });
    await Promise.all(workers);
    return {
      workspaces: dirs.length,
      bytes,
    };
  }
}

async function hasActiveDownloadLease(dir: string, now: number): Promise<boolean> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(DOWNLOAD_LEASE_PREFIX)) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info) continue;
    if ((now - info.mtimeMs) / 1000 < DOWNLOAD_LEASE_TTL_SECONDS) {
      return true;
    }
    await unlink(join(dir, name)).catch(() => undefined);
  }
  return false;
}

async function latestEntryMtime(dir: string): Promise<number> {
  let newest = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const mtimes = await Promise.all(
    entries.map((entry) =>
      stat(join(dir, entry.name))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    ),
  );
  for (const ms of mtimes) {
    if (ms > newest) newest = ms;
  }
  return newest;
}

async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return directorySize(path);
      if (entry.isFile()) {
        return lstat(path)
          .then((s) => (s.isFile() ? s.size : 0))
          .catch(() => 0);
      }
      return Promise.resolve(0);
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export class Workspace {
  constructor(
    readonly jobId: string,
    readonly baseDir: string,
    readonly scratchDir: string,
    readonly outputDir: string,
  ) {}

  outputPath(name: string): string {
    return join(this.outputDir, assertSafeFilename(name));
  }

  async writeManifest(manifest: JobManifest): Promise<void> {
    await writeFile(join(this.baseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  }

  async clearScratch(): Promise<void> {
    await rm(this.scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const MIME_TYPES: Readonly<Record<string, string>> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
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
  pdf: 'application/pdf',
  iso: 'application/x-iso9660-image',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/x-msdownload',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  bin: 'application/octet-stream',
};

export function mimeTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(MIME_TYPES, extension) ? MIME_TYPES[extension]! : 'application/octet-stream';
}
