import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildFilename, seraError, SeraError, type SeraEngine } from '@sera/engine';
import { z } from 'zod';

/**
 * The endpoints an extraction node on another network talks to.
 *
 * A node is a machine SERA's operator controls, on a connection the platforms do not
 * refuse. It dials out, asks for work, does it, and reports back. Nothing listens on the
 * node and nothing routable reaches it, which is what keeps a residential machine from
 * becoming an open proxy no matter what happens to the credential.
 *
 * These are not public API. They are mounted only when a token is configured, they are
 * excluded from the client rate limiter (a node polling every 25 seconds is not a
 * visitor), and every one of them requires the token.
 */

const claimSchema = z.object({
  nodeId: z.string().min(1).max(64),
  providers: z.array(z.string().min(1).max(32)).max(50),
  capacity: z.coerce.number().int().min(1).max(8).default(1),
  // A node says what kind of connection it is on. The default is the reason nodes
  // exist; an operator running a second cloud node says so and is routed accordingly.
  networkClass: z.enum(['datacenter', 'residential', 'unknown']).default('residential'),
});

const progressSchema = z.object({
  percent: z.coerce.number().min(0).max(100),
  step: z.string().min(1).max(120),
  bytesDownloaded: z.coerce.number().int().min(0).optional(),
  bytesTotal: z.coerce.number().int().min(0).optional(),
});

const failedSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(500).optional(),
  detail: z.string().max(2000).optional(),
});

/** Compared in constant time: a token check that leaks timing is a token check. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerExtractionNodeRoutes(rootApp: FastifyInstance, engine: SeraEngine): void {
  const { config, logger, extractionNodes } = engine;
  if (!config.extractionNodes.enabled) return;

  // Encapsulated, so the raw-body parser these need does not change how the public API
  // treats a request body.
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins are async by contract
  void rootApp.register(async (app) => {
    app.addContentTypeParser(
      'application/octet-stream',
      // Handed through untouched: an uploaded file is streamed to disk, never buffered.
      (_request, payload, done) => done(null, payload),
    );

    /** Every route here is token-gated; nothing below runs without it. */
    const authenticate = (request: FastifyRequest, reply: FastifyReply): boolean => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (presented && tokenMatches(presented, config.extractionNodes.token)) return true;
      // No detail: an unauthenticated caller learns only that it was refused.
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return false;
    };

    /**
     * Asks for work, and waits.
     *
     * The wait is deliberate: it is the heartbeat as well as the queue. A node that is
     * asking is a node that is alive, so nothing separate has to ping, and a task reaches
     * a waiting node immediately rather than on the next poll.
     */
    app.post(
      '/internal/extraction/claim',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const parsed = claimSchema.safeParse(request.body);
        if (!parsed.success) {
          throw seraError('INVALID_URL', {
            message: 'Malformed claim.',
            detail: 'node: bad claim body',
          });
        }

        const { nodeId, providers, capacity, networkClass } = parsed.data;
        const task = await extractionNodes.claim(
          nodeId,
          providers,
          capacity,
          config.extractionNodes.claimHoldMs,
          networkClass,
        );
        if (!task) return reply.status(204).send();
        return reply.send(task);
      },
    );

    /**
     * Progress, and the answer to the only question a node needs to ask back: has the
     * visitor gone away? A node that cannot find out keeps a home connection busy
     * downloading something nobody is waiting for.
     */
    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/progress',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        const parsed = progressSchema.safeParse(request.body);
        if (parsed.success) extractionNodes.reportProgress(request.params.taskId, parsed.data);
        return reply.send({ cancelled: extractionNodes.isCancelled(request.params.taskId) });
      },
    );

    /** A finished resolution, in the same shape the local providers produce. */
    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/resolved',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const body = request.body as { media?: unknown };
        const media = body?.media;
        if (
          !media ||
          typeof media !== 'object' ||
          !Array.isArray((media as { items?: unknown }).items)
        ) {
          throw seraError('INTERNAL', { detail: 'node: resolved body had no media' });
        }

        const accepted = extractionNodes.completeResolve(
          request.params.taskId,
          media as Parameters<typeof extractionNodes.completeResolve>[1],
        );
        // A node reconnecting after a restart may finish work nobody is waiting for.
        return reply.send({ accepted });
      },
    );

    /** A failure, carrying the class the node saw rather than a generic one. */
    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/failed',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        const parsed = failedSchema.safeParse(request.body);
        const error = parsed.success
          ? new SeraError(
              parsed.data.code as Parameters<typeof seraError>[0],
              parsed.data.message ?? 'The extraction node could not complete this.',
              { ...(parsed.data.detail ? { detail: `node: ${parsed.data.detail}` } : {}) },
            )
          : seraError('PROVIDER_UNAVAILABLE', { detail: 'node: malformed failure report' });

        const accepted = extractionNodes.fail(request.params.taskId, error);
        return reply.send({ accepted });
      },
    );

    /**
     * One finished file, streamed straight to disk.
     *
     * Bytes go to a directory named for the task and nothing else touches it, so a node
     * cannot write over a job's workspace or anything a visitor can reach. The name is
     * sanitized with the same function the download path uses — a node is trusted to do
     * extraction, not to pick paths.
     */
    app.post<{ Params: { taskId: string }; Querystring: { name?: string; mime?: string } }>(
      '/internal/extraction/:taskId/file',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const { taskId } = request.params;
        if (!/^[a-f0-9]{16,64}$/.test(taskId)) {
          throw seraError('NOT_FOUND', { detail: 'node: malformed task id' });
        }
        if (extractionNodes.isCancelled(taskId)) {
          // Nobody is waiting for this any more; do not spend disk on it.
          return reply.status(409).send({ accepted: false, cancelled: true });
        }

        // The same sanitizer the download path uses: a node is trusted to extract, not
        // to choose where bytes land.
        const requested = request.query.name ?? 'media.bin';
        const dot = requested.lastIndexOf('.');
        const name = buildFilename(
          dot > 0 ? requested.slice(0, dot) : requested,
          dot > 0 ? requested.slice(dot + 1) : 'bin',
        );
        const directory = join(config.dataDir, 'remote', taskId);
        await mkdir(directory, { recursive: true });
        const path = join(directory, name);

        try {
          await pipeline(request.raw, createWriteStream(path));
        } catch (error) {
          await rm(path, { force: true });
          throw seraError('NETWORK_ERROR', {
            detail: `node: upload failed: ${error instanceof Error ? error.message : 'unknown'}`,
          });
        }

        const written = await stat(path);
        if (written.size > config.maxFilesizeBytes) {
          await rm(path, { force: true });
          throw seraError('TOO_LARGE', { detail: 'node: uploaded file exceeds the limit' });
        }

        const accepted = extractionNodes.acceptFile(taskId, {
          name,
          mimeType: request.query.mime ?? 'application/octet-stream',
          path,
        });
        if (!accepted) await rm(directory, { recursive: true, force: true });
        return reply.send({ accepted, sizeBytes: written.size });
      },
    );

    /** Every file is in; settle the job with them, in the order they arrived. */
    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/complete',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        return reply.send({ accepted: extractionNodes.completeJob(request.params.taskId) });
      },
    );

    logger.info(
      { claimHoldMs: config.extractionNodes.claimHoldMs },
      'extraction node endpoints mounted',
    );
  });
}
