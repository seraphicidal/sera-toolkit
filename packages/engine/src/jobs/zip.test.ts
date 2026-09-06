import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZip } from './zip.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sera-zip-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(2048, 1));
  await writeFile(join(dir, 'b.txt'), 'x'.repeat(4096));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Reads the entry names out of a ZIP's central directory. */
async function entryNames(path: string): Promise<string[]> {
  const buffer = await readFile(path);
  const names: string[] = [];
  // Central directory headers start with PK\x01\x02; the name follows a 46-byte header.
  for (let i = 0; i < buffer.length - 46; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(i + 28);
    names.push(buffer.subarray(i + 46, i + 46 + nameLength).toString('utf8'));
  }
  return names;
}

describe('createZip', () => {
  it('writes a real archive containing the requested entries', async () => {
    const destination = join(dir, 'out.zip');
    const { sizeBytes } = await createZip({
      entries: [
        { path: join(dir, 'a.mp4'), name: 'video.mp4' },
        { path: join(dir, 'b.txt'), name: 'notes.txt' },
      ],
      destination,
    });

    expect(sizeBytes).toBeGreaterThan(0);
    const buffer = await readFile(destination);
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await entryNames(destination)).sort()).toEqual(['notes.txt', 'video.mp4']);
  });

  it('refuses an entry name that would escape on extraction', async () => {
    // A ZIP is the one place a crafted name becomes a path on someone else's machine.
    for (const name of ['../escape.mp4', '..\\escape.mp4', '/etc/passwd', 'a/b.mp4', '..']) {
      await expect(
        createZip({
          entries: [{ path: join(dir, 'a.mp4'), name }],
          destination: join(dir, 'evil.zip'),
        }),
        name,
      ).rejects.toThrow();
    }
  });

  it('renames colliding entries instead of writing duplicates', async () => {
    const destination = join(dir, 'dupes.zip');
    await createZip({
      entries: [
        { path: join(dir, 'a.mp4'), name: 'same.mp4' },
        { path: join(dir, 'b.txt'), name: 'same.mp4' },
        { path: join(dir, 'a.mp4'), name: 'same.mp4' },
      ],
      destination,
    });

    const names = await entryNames(destination);
    expect(names).toEqual(['same.mp4', 'same (2).mp4', 'same (3).mp4']);
    expect(new Set(names).size).toBe(3);
  });

  it('reports progress once per entry', async () => {
    const seen: [number, number, number][] = [];
    await createZip({
      entries: [
        { path: join(dir, 'a.mp4'), name: '1.mp4' },
        { path: join(dir, 'b.txt'), name: '2.txt' },
      ],
      destination: join(dir, 'progress.zip'),
      onProgress: (percent, current, total) => seen.push([percent, current, total]),
    });

    expect(seen).toEqual([
      [50, 1, 2],
      [100, 2, 2],
    ]);
  });

  it('fails clearly when a source file is missing', async () => {
    await expect(
      createZip({
        entries: [{ path: join(dir, 'nope.mp4'), name: 'nope.mp4' }],
        destination: join(dir, 'missing.zip'),
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('refuses to build an empty archive', async () => {
    await expect(
      createZip({ entries: [], destination: join(dir, 'empty.zip') }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('stops when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createZip({
        entries: [{ path: join(dir, 'a.mp4'), name: 'a.mp4' }],
        destination: join(dir, 'cancelled.zip'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
