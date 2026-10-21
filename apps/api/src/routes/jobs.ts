import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createJobRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { contentDispositionValue, mimeTypeFor, seraError, SeraError } from '@sera/engine';
import { abuseGuardFor } from '../plugins/client.js';
import { clientAbortSignal } from '../plugins/disconnect.js';

const JOB_ID = /^[a-f0-9]{16,64}$/;

function assertJobId(id: string): string {
  if (!JOB_ID.test(id)) throw seraError('NOT_FOUND', { detail: 'malformed job id' });
  return id;
}

export function registerJobRoutes(app: FastifyInstance, engine: SeraEngine): void {
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

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = await engine.jobs.get(assertJobId(request.params.id));
    if (!job) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
    return reply.header('cache-control', 'no-store').send(job);
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const id = assertJobId(request.params.id);
    const deleted = await engine.jobs.delete(id);
    if (!deleted) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
    return reply.status(200).send({ cancelled: deleted, deleted: true, id });
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (request, reply) => {
    const id = assertJobId(request.params.id);
    const signal = clientAbortSignal(request, reply);

    const existingHeaders: Record<string, string | number | readonly string[]> = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) existingHeaders[key] = value;
    }
    reply.raw.writeHead(200, {
      ...existingHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    reply.raw.write('retry: 3000\n\n');

    try {
      for await (const event of engine.jobs.events(id, signal)) {
        if (signal.aborted) break;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const message =
        error instanceof SeraError ? error.message : 'Something went wrong on our side.';
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.route<{ Params: { id: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/jobs/:id/download',
    handler: async (request, reply) => {
      const id = assertJobId(request.params.id);
      const manifest = await engine.workspaces.readManifest(id);
      if (!manifest) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
      return sendFile(engine, request, reply, id, manifest.primary, !request.canary);
    },
  });

  app.route<{ Params: { id: string; name: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/jobs/:id/files/:name',
    handler: async (request, reply) => {
      const id = assertJobId(request.params.id);
      const manifest = await engine.workspaces.readManifest(id);
      if (!manifest) throw seraError('NOT_FOUND', { message: 'That download has expired.' });

      const name = request.params.name;
      if (!manifest.files.some((file) => file.name === name)) throw seraError('NOT_FOUND');
      return sendFile(engine, request, reply, id, name, !request.canary);
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

async function sendFile(
  engine: SeraEngine,
  request: FastifyRequest,
  reply: FastifyReply,
  jobId: string,
  filename: string,
  counted: boolean,
): Promise<FastifyReply> {
  const path = await engine.workspaces.resolveFile(jobId, filename);
  const info = await stat(path);
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

  if (hasRange) {
    const range = parseRange(rangeHeader, info.size);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${info.size}`).send();
    }
    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;
      if (counted) {
        reply.raw.once('finish', () => {
          void engine.jobs
            .get(jobId)
            .then((job) =>
              engine.usage.record({
                source: job?.provider ?? 'other',
                kind: 'bytes',
                bytes: chunkSize,
              }),
            )
            .catch(() => undefined);
        });
      }
      return reply
        .status(206)
        .header('content-range', `bytes ${start}-${end}/${info.size}`)
        .header('content-length', chunkSize)
        .send(createReadStream(path, { start, end }));
    }
  }

  if (counted) {
    reply.raw.once('finish', () => {
      void engine.jobs
        .get(jobId)
        .then((job) =>
          engine.usage.record({
            source: job?.provider ?? 'other',
            kind: 'bytes',
            bytes: info.size,
          }),
        )
        .catch(() => undefined);
    });
  }

  return reply.status(200).header('content-length', info.size).send(createReadStream(path));
}
