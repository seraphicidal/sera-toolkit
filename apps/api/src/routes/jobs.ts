import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createJobRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { contentDispositionValue, mimeTypeFor, seraError } from '@sera/engine';
import { clientAbortSignal } from '../plugins/disconnect.js';

/** Job ids are hex; rejecting anything else keeps malformed input away from the store. */
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
      engine.abuse.assertAllowed(request.clientKey);
      const body = createJobRequestSchema.parse(request.body);

      try {
        const job = await engine.jobs.create(body, request.clientKey);
        engine.abuse.recordSuccess(request.clientKey);
        return await reply.status(202).header('cache-control', 'no-store').send(job);
      } catch (error) {
        // Forged or expired handles are exactly the pattern worth cooling down.
        engine.abuse.recordFailure(request.clientKey);
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
    const cancelled = await engine.jobs.cancel(assertJobId(request.params.id));
    return reply.status(cancelled ? 200 : 409).send({ cancelled });
  });

  /**
   * Progress stream.
   *
   * Server-sent events rather than a socket: progress is one-way, SSE reconnects on its
   * own, and it survives the proxies people put in front of a self-hosted service. The
   * periodic `ping` keeps those proxies from closing an idle stream mid-download.
   */
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (request, reply) => {
    const id = assertJobId(request.params.id);
    const signal = clientAbortSignal(request, reply);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer, which would otherwise hold every event until the end.
      'x-accel-buffering': 'no',
    });
    // Reconnect delay for the browser's own EventSource retry.
    reply.raw.write('retry: 3000\n\n');

    try {
      for await (const event of engine.jobs.events(id, signal)) {
        if (signal.aborted) break;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stream failed';
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /** The primary result: the file, or the archive when there is more than one. */
  app.get<{ Params: { id: string } }>('/api/jobs/:id/download', async (request, reply) => {
    const id = assertJobId(request.params.id);
    const manifest = await engine.workspaces.readManifest(id);
    if (!manifest) throw seraError('NOT_FOUND', { message: 'That download has expired.' });
    return sendFile(engine, reply, id, manifest.primary);
  });

  /** One file from a multi-item job, so a carousel can be saved piece by piece. */
  app.get<{ Params: { id: string; name: string } }>(
    '/api/jobs/:id/files/:name',
    async (request, reply) => {
      const id = assertJobId(request.params.id);
      const manifest = await engine.workspaces.readManifest(id);
      if (!manifest) throw seraError('NOT_FOUND', { message: 'That download has expired.' });

      const name = decodeURIComponent(request.params.name);
      // The manifest is the allowlist: a name that is not in it is not served, whatever
      // it resolves to on disk.
      if (!manifest.files.some((file) => file.name === name)) throw seraError('NOT_FOUND');
      return sendFile(engine, reply, id, name);
    },
  );
}

async function sendFile(
  engine: SeraEngine,
  reply: FastifyReply,
  jobId: string,
  filename: string,
): Promise<FastifyReply> {
  const path = await engine.workspaces.resolveFile(jobId, filename);
  const info = await stat(path);

  return (
    reply
      .header('content-type', mimeTypeFor(filename))
      .header('content-length', info.size)
      .header('content-disposition', contentDispositionValue(filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      // The response is a download, never something a browser should render in place.
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(createReadStream(path))
  );
}
