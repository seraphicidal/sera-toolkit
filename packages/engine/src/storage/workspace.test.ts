import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logging.js';
import { mimeTypeFor, WorkspaceManager } from './workspace.js';

/**
 * Retention is the privacy promise, so the reaper gets its own tests.
 *
 * The failure mode it guards against is silent: media that should have been deleted
 * simply accumulates, and nothing surfaces until the disk fills or someone looks.
 */

let root: string;
let manager: WorkspaceManager;

const RETENTION_SECONDS = 60;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sera-ws-'));
  manager = new WorkspaceManager(root, RETENTION_SECONDS, silentLogger());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jobId = (n: number) => n.toString(16).padStart(32, '0');

/** Backdates a workspace so the reaper sees it as old. */
async function age(id: string, secondsAgo: number): Promise<void> {
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(join(root, id), when, when);
}

describe('reaper', () => {
  it('deletes workspaces past the retention window', async () => {
    const workspace = await manager.create(jobId(1));
    await writeFile(workspace.outputPath('video.mp4'), Buffer.alloc(1024));
    await age(jobId(1), RETENTION_SECONDS + 10);

    expect(await manager.reap()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('leaves workspaces that are still within the window', async () => {
    await manager.create(jobId(2));
    await age(jobId(2), RETENTION_SECONDS - 10);

    expect(await manager.reap()).toBe(0);
    expect(await readdir(root)).toHaveLength(1);
  });

  it('deletes the media, not just the directory entry', async () => {
    const workspace = await manager.create(jobId(3));
    const file = workspace.outputPath('secret.mp4');
    await writeFile(file, Buffer.alloc(4096));
    await age(jobId(3), RETENTION_SECONDS + 10);

    await manager.reap();
    await expect(stat(file)).rejects.toThrow();
  });

  it('removes a workspace whose job crashed mid-download', async () => {
    // The reaper deletes by directory age and never consults the job store, so a lost
    // or crashed job cannot leave media behind indefinitely.
    const workspace = await manager.create(jobId(4));
    await mkdir(join(workspace.scratchDir, 'sel-0'), { recursive: true });
    await writeFile(join(workspace.scratchDir, 'sel-0', 'media.mp4.part'), Buffer.alloc(2048));
    await age(jobId(4), RETENTION_SECONDS + 10);

    expect(await manager.reap()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('reaps several at once and leaves the fresh ones', async () => {
    for (let i = 10; i < 15; i += 1) await manager.create(jobId(i));
    for (let i = 10; i < 13; i += 1) await age(jobId(i), RETENTION_SECONDS + 30);

    expect(await manager.reap()).toBe(3);
    expect(await readdir(root)).toHaveLength(2);
  });

  it('survives a missing root directory', async () => {
    await rm(root, { recursive: true, force: true });
    await expect(manager.reap()).resolves.toBe(0);
  });

  it('reports usage across workspaces', async () => {
    const a = await manager.create(jobId(20));
    await writeFile(a.outputPath('a.mp4'), Buffer.alloc(3000));
    const b = await manager.create(jobId(21));
    await writeFile(b.outputPath('b.mp4'), Buffer.alloc(5000));

    const usage = await manager.usage();
    expect(usage.workspaces).toBe(2);
    expect(usage.bytes).toBeGreaterThanOrEqual(8000);
  });

  it('starts and stops the periodic sweep without leaking a timer', () => {
    const stop = manager.startReaper(1);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('destroy', () => {
  it('removes one workspace immediately, for a cancelled job', async () => {
    await manager.create(jobId(30));
    await manager.destroy(jobId(30));
    expect(await readdir(root)).toEqual([]);
  });

  it('is safe to call for a job that has already gone', async () => {
    await expect(manager.destroy(jobId(31))).resolves.toBeUndefined();
  });
});

describe('resolveFile', () => {
  it('returns a path inside the workspace for a real output', async () => {
    const workspace = await manager.create(jobId(40));
    await writeFile(workspace.outputPath('clip.mp4'), Buffer.alloc(16));
    await expect(manager.resolveFile(jobId(40), 'clip.mp4')).resolves.toContain('clip.mp4');
  });

  it('refuses names that try to leave the output directory', async () => {
    await manager.create(jobId(41));
    for (const name of ['../manifest.json', '..', 'a/b.mp4', 'C:\\Windows\\win.ini', '']) {
      await expect(manager.resolveFile(jobId(41), name), name).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });

  it('refuses a job id that is not a job id', async () => {
    await expect(manager.resolveFile('../../etc', 'passwd')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('mimeTypeFor', () => {
  it('maps the containers SERA produces', () => {
    expect(mimeTypeFor('a.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('a.mp3')).toBe('audio/mpeg');
    expect(mimeTypeFor('a.zip')).toBe('application/zip');
    expect(mimeTypeFor('a.webp')).toBe('image/webp');
  });

  it('falls back rather than guessing', () => {
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
    expect(mimeTypeFor('noextension')).toBe('application/octet-stream');
  });
});
