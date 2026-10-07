import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Dispatcher } from 'undici';
import { seraError, SeraError } from '../errors.js';
import { discard, header, safeOpen } from '../security/http.js';

export interface DirectDownloadRequest {
  readonly url: string;
  readonly destination: string;
  readonly dispatcher: Dispatcher;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly allowUrl?: (url: URL) => boolean;
  readonly onProgress?: (progress: {
    bytesDownloaded: number;
    bytesTotal?: number;
    speedBytesPerSecond?: number;
    etaSeconds?: number;
  }) => void;
}

export interface DirectDownloadResult {
  readonly bytes: number;
  readonly contentType?: string;
  readonly url: string;
}

const PROGRESS_INTERVAL_MS = 250;

export async function downloadDirect(
  request: DirectDownloadRequest,
): Promise<DirectDownloadResult> {
  const opened = await safeOpen(new URL(request.url), {
    dispatcher: request.dispatcher,
    timeoutMs: request.timeoutMs,
    ...(request.allowUrl ? { allowUrl: request.allowUrl } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (opened.status >= 400) {
    discard(opened.body);
    throw seraError(opened.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
      detail: `GET ${opened.status}`,
    });
  }

  const declared = Number(header(opened.headers, 'content-length'));
  const bytesTotal = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (bytesTotal && bytesTotal > request.maxBytes) {
    discard(opened.body);
    throw seraError('TOO_LARGE', { detail: `content-length ${bytesTotal} > ${request.maxBytes}` });
  }

  let received = 0;
  const startedAt = Date.now();
  let lastReport = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > request.maxBytes) {
        callback(seraError('TOO_LARGE', { detail: `body exceeded ${request.maxBytes} bytes` }));
        return;
      }
      const now = Date.now();
      if (request.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        const elapsed = (now - startedAt) / 1000;
        const speed = elapsed > 0 ? received / elapsed : undefined;
        request.onProgress({
          bytesDownloaded: received,
          ...(bytesTotal ? { bytesTotal } : {}),
          ...(speed ? { speedBytesPerSecond: speed } : {}),
          ...(speed && bytesTotal && speed > 0
            ? { etaSeconds: Math.max(0, (bytesTotal - received) / speed) }
            : {}),
        });
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(opened.body, meter, createWriteStream(request.destination), {
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (cause) {
    await rm(request.destination, { force: true }).catch(() => undefined);
    if (cause instanceof SeraError) throw cause;
    if (cause instanceof Error && cause.name === 'AbortError')
      throw seraError('CANCELLED', { cause });
    throw seraError('NETWORK_ERROR', { cause, detail: 'stream to disk failed' });
  }

  if (received === 0) {
    await rm(request.destination, { force: true }).catch(() => undefined);
    throw seraError('MEDIA_UNAVAILABLE', { detail: 'server returned an empty file' });
  }

  request.onProgress?.({ bytesDownloaded: received, ...(bytesTotal ? { bytesTotal } : {}) });

  const contentType = header(opened.headers, 'content-type');
  return { bytes: received, ...(contentType ? { contentType } : {}), url: opened.url };
}
