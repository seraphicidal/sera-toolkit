import { createWriteStream } from 'node:fs';
import { lstat, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { ZipFile } from 'yazl';
import { seraError, SeraError } from '../errors.js';
import { assertSafeFilename, dedupeFilename } from '../util/filename.js';

export interface ZipEntry {
  readonly path: string;
  readonly name: string;
}

export interface CreateZipRequest {
  readonly entries: readonly ZipEntry[];
  readonly destination: string;
  readonly maxOutputBytes?: number;
  readonly onProgress?: (percent: number, currentFile: number, totalFiles: number) => void;
  readonly signal?: AbortSignal;
}

const PROGRESS_INTERVAL_MS = 150;

export async function createZip(request: CreateZipRequest): Promise<{ sizeBytes: number }> {
  if (!request.entries.length) {
    throw seraError('INTERNAL', { detail: 'createZip called with no entries' });
  }
  if (request.signal?.aborted) throw seraError('CANCELLED');

  const totalFiles = request.entries.length;
  const taken = new Set<string>();
  const prepared: {
    readonly path: string;
    readonly name: string;
    readonly mtime: Date;
    readonly size: number;
  }[] = [];
  let totalInputBytes = 0;

  for (const entry of request.entries) {
    if (request.signal?.aborted) throw seraError('CANCELLED');
    const name = assertSafeFilename(entry.name);
    const unique = dedupeFilename(name, taken);
    const info = await lstat(entry.path).catch(() => undefined);
    if (!info?.isFile()) {
      throw seraError('INTERNAL', { detail: `missing archive entry: ${name}` });
    }
    prepared.push({ path: entry.path, name: unique, mtime: info.mtime, size: info.size });
    totalInputBytes += info.size;
  }

  const zip = new ZipFile();
  const output = createWriteStream(request.destination);
  const finished = once(output, 'close');
  finished.catch(() => undefined);

  let writtenBytes = 0;
  let lastProgressAt = 0;
  let lastReportedPercent = -1;
  let streamFailure: Error | undefined;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      if (request.maxOutputBytes !== undefined && writtenBytes > request.maxOutputBytes) {
        const err = seraError('TOO_LARGE', {
          message: 'The output exceeds the maximum allowed size.',
          hint: 'Try a lower quality or fewer items.',
          detail: `zip archive exceeded ${request.maxOutputBytes} bytes`,
        });
        streamFailure = err;
        callback(err);
        return;
      }
      const now = Date.now();
      if (
        request.onProgress &&
        totalInputBytes > 0 &&
        now - lastProgressAt >= PROGRESS_INTERVAL_MS
      ) {
        lastProgressAt = now;
        const pct = Math.min(99, Math.max(0, Math.round((writtenBytes / totalInputBytes) * 100)));
        if (pct > lastReportedPercent) {
          lastReportedPercent = pct;
          const approxFile = Math.min(totalFiles, Math.max(1, Math.ceil((pct / 100) * totalFiles)));
          request.onProgress(pct, approxFile, totalFiles);
        }
      }
      callback(null, chunk);
    },
  });

  const failOutput = (err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    streamFailure ??= error;
    output.destroy(error);
  };

  zip.outputStream.on('error', failOutput);
  meter.on('error', failOutput);
  zip.outputStream.pipe(meter).pipe(output);

  const onAbort = (): void => {
    const err = seraError('CANCELLED');
    streamFailure ??= err;
    output.destroy(err);
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (const entry of prepared) {
      if (request.signal?.aborted) throw seraError('CANCELLED');
      if (output.destroyed || output.errored || streamFailure) {
        throw (
          streamFailure ??
          output.errored ??
          seraError('CONVERSION_FAILED', { detail: 'zip output closed early' })
        );
      }
      zip.addFile(entry.path, entry.name, {
        mtime: entry.mtime,
        mode: 0o644,
        compress: shouldCompress(entry.name),
      });
    }

    zip.end();
    await finished;
    if (streamFailure) throw streamFailure;
  } catch (error) {
    zip.outputStream.unpipe(meter);
    meter.unpipe(output);
    const stream = zip.outputStream as unknown as { destroy?: () => void };
    if (typeof stream.destroy === 'function') {
      stream.destroy();
    }
    meter.destroy();
    output.destroy();
    await finished.catch(() => undefined);
    await rm(request.destination, { force: true }).catch(() => undefined);
    if (streamFailure instanceof SeraError) throw streamFailure;
    if (request.signal?.aborted) throw seraError('CANCELLED', { cause: error });
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
  }

  request.onProgress?.(100, totalFiles, totalFiles);
  const info = await stat(request.destination);
  return { sizeBytes: info.size };
}

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
