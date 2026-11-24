import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createJobRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { contentDispositionValue, mimeTypeFor, seraError, SeraError } from '@sera/engine';
import { abuseGuardFor } from '../plugins/client.js';
import { clientAbortSignal } from '../plugins/disconnect.js';

const JOB_ID = /^[a-f0-9]{16,64}$/;
const MAX_SSE_STREAMS_GLOBAL = 200;
const MAX_SSE_STREAMS_PER_CLIENT = 8;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;

function assertJobId(id: string): string {
  if (!JOB_ID.test(id)) throw seraError('NOT_FOUND', { detail: 'malformed job id' });
  return id;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function registerJobRoutes(app: FastifyInstance, engine: SeraEngine): void {
  let activeSseGlobal = 0;
  const activeSseByClient = new Map<string, number>();
  app.post(
    '/api/jobs',
    {
      config: {
        rateLimit: { max: engine.config.rateLimitJobsPerMinute, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const abuse = abuseGuardFor(engine, request);
      abuse.assertAllowed();
      const body = createJobRequestSchema.parse(request.body);

      try {
        const job = await engine.jobs.create(body, request.clientKey, {
          uncounted: request.canary,
        });
        abuse.recordSuccess();
        return await reply.status(202).header('cache-control', 'no-store').send(job);
      } catch (error) {
        abuse.recordFailure(error instanceof SeraError ? error.code : undefined);
        throw error;
      }
    },
  );

  const jobStatusRateLimit = {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
      },
    },
  };

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
    jobStatusRateLimit,
    async (request, reply) => {
      const job = await engine.jobs.get(assertJobId(request.params.id), request.clientKeys);
      if (!job) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      return reply.header('cache-control', 'no-store').send(job);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/jobs/:id',
    jobStatusRateLimit,
    async (request, reply) => {
      const id = assertJobId(request.params.id);
      const deleted = await engine.jobs.delete(id, request.clientKeys);
      if (!deleted) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({ cancelled: deleted, deleted: true, id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id/events',
    jobStatusRateLimit,
    async (request, reply) => {
      const id = assertJobId(request.params.id);
      const existingJob = await engine.jobs.get(id, request.clientKeys);
      if (!existingJob) throw seraError('NOT_FOUND', { message: 'That download has expired.' });

      if (activeSseGlobal >= MAX_SSE_STREAMS_GLOBAL) {
        throw seraError('QUEUE_FULL', {
          message: 'Too many live status connections right now. Try again in a moment.',
        });
      }
      const clientStreams = activeSseByClient.get(request.clientKey) ?? 0;
      if (!request.canary && clientStreams >= MAX_SSE_STREAMS_PER_CLIENT) {
        throw seraError('RATE_LIMITED', {
          message: 'Too many live status connections. Close a tab or wait a moment.',
        });
      }

      activeSseGlobal += 1;
      if (!request.canary) {
        activeSseByClient.set(request.clientKey, clientStreams + 1);
      }
      let releasedSse = false;
      const releaseSse = (): void => {
        if (releasedSse) return;
        releasedSse = true;
        activeSseGlobal = Math.max(0, activeSseGlobal - 1);
        if (!request.canary) {
          const current = activeSseByClient.get(request.clientKey) ?? 0;
          if (current <= 1) {
            activeSseByClient.delete(request.clientKey);
          } else {
            activeSseByClient.set(request.clientKey, current - 1);
          }
        }
      };

      const signal = clientAbortSignal(request, reply);
      let congested = false;
      const onDrain = (): void => {
        congested = false;
      };

      try {
        if (typeof request.raw.setTimeout === 'function') {
          request.raw.setTimeout(0);
        }
        const existingHeaders: Record<string, string | number | readonly string[]> = {};
        for (const [key, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) existingHeaders[key] = value;
        }
        reply.hijack();
        reply.raw.on('error', () => {
          if (!reply.raw.destroyed) reply.raw.destroy();
        });
        reply.raw.writeHead(200, {
          ...existingHeaders,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=63072000; includeSubDomains',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        });
        const writeSse = (payload: string, droppable: boolean): void => {
          if (signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) return;
          if (droppable && congested) return;
          if (reply.raw.writableLength > MAX_SSE_BUFFER_BYTES) {
            reply.raw.destroy();
            return;
          }
          const ok = reply.raw.write(payload);
          if (!ok && !congested) {
            congested = true;
            reply.raw.once('drain', onDrain);
          }
        };

        writeSse('retry: 3000\n\n', false);

        for await (const event of engine.jobs.events(id, signal, request.clientKeys)) {
          if (signal.aborted || reply.raw.destroyed) break;
          if (event.type === 'ping') {
            writeSse(': ping\n\n', true);
          } else {
            writeSse(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              event.type === 'progress',
            );
          }
        }
      } catch (error) {
        if (!signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
          const message =
            error instanceof SeraError ? error.message : 'Something went wrong on our side.';
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`);
        }
      } finally {
        reply.raw.removeListener('drain', onDrain);
        releaseSse();
        if (signal.aborted && !reply.raw.destroyed) {
          reply.raw.destroy();
        } else if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end();
        }
      }
      return;
    },
  );

  app.route<{ Params: { id: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/jobs/:id/download',
    ...jobStatusRateLimit,
    handler: async (request, reply) => {
      const id = assertJobId(request.params.id);
      const job = await engine.jobs.get(id, request.clientKeys);
      if (!job) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      return serveJobFile(
        engine,
        request,
        reply,
        id,
        !request.canary,
        job.provider,
        (m) => m.primary,
      );
    },
  });

  app.route<{ Params: { id: string; name: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/jobs/:id/files/:name',
    ...jobStatusRateLimit,
    handler: async (request, reply) => {
      const id = assertJobId(request.params.id);
      const job = await engine.jobs.get(id, request.clientKeys);
      if (!job) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      const name = request.params.name;
      return serveJobFile(engine, request, reply, id, !request.canary, job.provider, (manifest) =>
        manifest.files.some((file) => file.name === name) ? name : undefined,
      );
    },
  });
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (size === 0) return 'unsatisfiable';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const startStr = match[1];
  const endStr = match[2];
  if (!startStr && !endStr) return undefined;
  if (!startStr) {
    if (!endStr) return undefined;
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = parseInt(startStr, 10);
  if (isNaN(start) || start < 0 || start >= size) return 'unsatisfiable';
  if (!endStr) {
    return { start, end: size - 1 };
  }
  const end = parseInt(endStr, 10);
  if (isNaN(end) || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

function matchesIfRange(ifRange: string | undefined, etag: string, lastModified: string): boolean {
  if (!ifRange) return true;
  const trimmed = ifRange.trim();
  if (trimmed === etag || trimmed === etag.replace(/^W\//, '')) return true;
  const ifDate = Date.parse(trimmed);
  const lmDate = Date.parse(lastModified);
  return !isNaN(ifDate) && !isNaN(lmDate) && ifDate === lmDate;
}

async function serveJobFile(
  engine: SeraEngine,
  request: FastifyRequest,
  reply: FastifyReply,
  jobId: string,
  counted: boolean,
  provider: string,
  selectFilename: (
    manifest: NonNullable<Awaited<ReturnType<SeraEngine['workspaces']['readManifest']>>>,
  ) => string | undefined,
): Promise<FastifyReply> {
  let leaseReleased = false;
  const rawRelease = engine.workspaces.acquireDownload(jobId);
  const releaseLease = (): void => {
    if (leaseReleased) return;
    leaseReleased = true;
    rawRelease();
  };
  let streamHandedOff = false;

  try {
    const manifest = await engine.workspaces.readManifest(jobId);
    if (!manifest) {
      await engine.jobs.markExpired(jobId);
      throw seraError('NOT_FOUND', { message: 'That download has expired.' });
    }
    const filename = selectFilename(manifest);
    if (!filename) throw seraError('NOT_FOUND');

    let path: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      path = await engine.workspaces.resolveFile(jobId, filename);
      info = await stat(path);
    } catch (error) {
      if (isEnoentError(error) || (error instanceof SeraError && error.code === 'NOT_FOUND')) {
        await engine.jobs.markExpired(jobId);
        throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      }
      throw error;
    }

    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const lastModified = info.mtime.toUTCString();

    reply
      .header('content-type', mimeTypeFor(filename))
      .header('content-disposition', contentDispositionValue(filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('last-modified', lastModified);

    if (request.method === 'HEAD') {
      return reply.header('content-length', info.size).status(200).send();
    }

    const rangeHeader = request.headers.range;
    const rawIfRange = request.headers['if-range'];
    const ifRange = Array.isArray(rawIfRange) ? rawIfRange[0] : rawIfRange;
    const hasRange = typeof rangeHeader === 'string' && matchesIfRange(ifRange, etag, lastModified);

    const wireDownloadStream = (
      stream: ReturnType<typeof createReadStream>,
      expectedBytes: number,
    ) => {
      streamHandedOff = true;
      let recorded = false;
      const finalize = () => {
        releaseLease();
        if (!counted || recorded) return;
        recorded = true;
        const bytes = Math.min(expectedBytes, stream.bytesRead);
        if (bytes <= 0) return;
        void engine.usage
          .record({
            source: provider || 'other',
            kind: 'bytes',
            bytes,
          })
          .catch(() => undefined);
      };
      stream.once('close', finalize);
      stream.once('error', releaseLease);
      reply.raw.once('close', finalize);
      reply.raw.once('finish', finalize);
      return stream;
    };

    if (hasRange) {
      const range = parseRange(rangeHeader, info.size);
      if (range === 'unsatisfiable') {
        return reply.status(416).header('content-range', `bytes */${info.size}`).send();
      }
      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;
        return reply
          .status(206)
          .header('content-range', `bytes ${start}-${end}/${info.size}`)
          .header('content-length', chunkSize)
          .send(wireDownloadStream(createReadStream(path, { start, end }), chunkSize));
      }
    }

    return reply
      .status(200)
      .header('content-length', info.size)
      .send(wireDownloadStream(createReadStream(path), info.size));
  } finally {
    if (!streamHandedOff) releaseLease();
  }
}
