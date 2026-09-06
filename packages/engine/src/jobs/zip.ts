import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { ZipFile } from 'yazl';
import { seraError } from '../errors.js';
import { assertSafeFilename } from '../util/filename.js';

/**
 * Bundles a job's outputs into one archive.
 *
 * Entry names are re-validated here even though they were sanitized when the files were
 * written. A ZIP is the one format where a crafted entry name (`../../autorun`) becomes
 * a path on someone else's machine when they extract it, so the check belongs at the
 * point the archive is built, not only at the point the file was named.
 */

export interface ZipEntry {
  /** Absolute path to the file on disk. */
  readonly path: string;
  /** Name inside the archive. Must be a bare filename. */
  readonly name: string;
}

export interface CreateZipRequest {
  readonly entries: readonly ZipEntry[];
  readonly destination: string;
  /** Reports 0-100 as entries are added. */
  readonly onProgress?: (percent: number, currentFile: number, totalFiles: number) => void;
  readonly signal?: AbortSignal;
}

export async function createZip(request: CreateZipRequest): Promise<{ sizeBytes: number }> {
  if (!request.entries.length) {
    throw seraError('INTERNAL', { detail: 'createZip called with no entries' });
  }

  const zip = new ZipFile();
  const output = createWriteStream(request.destination);
  const finished = once(output, 'close');
  zip.outputStream.pipe(output);

  const total = request.entries.length;
  const taken = new Set<string>();

  for (const [index, entry] of request.entries.entries()) {
    if (request.signal?.aborted) throw seraError('CANCELLED');

    const name = assertSafeFilename(entry.name);
    // Two items in one post can legitimately produce the same name; a ZIP with duplicate
    // entries extracts unpredictably, so collisions are resolved before they are written.
    const unique = dedupe(name, taken);

    const info = await stat(entry.path).catch(() => undefined);
    if (!info?.isFile()) {
      throw seraError('INTERNAL', { detail: `missing archive entry: ${name}` });
    }

    zip.addFile(entry.path, unique, {
      mtime: info.mtime,
      mode: 0o644,
      compress: shouldCompress(name),
    });
    request.onProgress?.(Math.round(((index + 1) / total) * 100), index + 1, total);
  }

  zip.end();
  await finished;

  const info = await stat(request.destination);
  return { sizeBytes: info.size };
}

/**
 * Media containers are already compressed; deflating them again costs CPU and saves
 * nothing, so they are stored and everything else is deflated.
 */
function shouldCompress(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const alreadyCompressed = new Set([
    'mp4',
    'webm',
    'mov',
    'mkv',
    'mp3',
    'm4a',
    'aac',
    'opus',
    'ogg',
    'flac',
    'jpg',
    'jpeg',
    'png',
    'webp',
    'avif',
    'gif',
  ]);
  return !alreadyCompressed.has(extension);
}

function dedupe(name: string, taken: Set<string>): string {
  const key = name.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  /* c8 ignore next 3 -- a job cannot contain 10k identically named files */
  const fallback = `${stem} (${Date.now()})${extension}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}
