import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorCode } from '@sera/contracts/types';
import {
  buildFilename,
  dedupeFilename,
  MESSAGES,
  sanitizeExtension,
  sanitizeStem,
  seraError,
  SeraError,
  type SeraEngine,
} from '@sera/engine';
import { z } from 'zod';
import { matchesToken } from '../plugins/client.js';

const claimSchema = z.object({
  nodeId: z.string().min(1).max(64),
  providers: z.array(z.string().min(1).max(32)).max(50),
  capacity: z.coerce.number().int().min(1).max(8).default(1),
  networkClass: z.enum(['datacenter', 'residential', 'unknown']).default('residential'),
  features: z.array(z.string().min(1).max(32)).max(20).default([]),
});

const dispatchSchema = z.object({
  kind: z.enum(['resolve', 'job']),
  url: z.string().url().max(2048),
  providerId: z.string().min(1).max(32),
  planKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
  items: z
    .array(
      z.object({
        index: z.number().int().min(0).max(1000),
        sourceId: z.string().min(1).max(200).optional(),
      }),
    )
    .max(100)
    .optional(),
  filename: z.string().max(200).optional(),
  networkClass: z.enum(['datacenter', 'residential', 'unknown']).optional(),
  trim: z.object({ start: z.number().min(0), end: z.number().positive().optional() }).optional(),
  requires: z
    .array(z.enum(['trim', 'subtitles', 'items', 'instagram-session']))
    .max(5)
    .optional(),
  avoid: z.array(z.string().min(1).max(64)).max(20).optional(),
  subtitles: z
    .object({
      lang: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
      auto: z.boolean(),
      format: z.enum(['srt', 'vtt', 'embed']),
      only: z.boolean(),
    })
    .optional(),
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

const RESOLVED_BODY_LIMIT = 4 * 1024 * 1024;

function limitTo(maxBytes: number, isCancelled: () => boolean): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (isCancelled()) {
        done(seraError('CANCELLED'));
        return;
      }
      seen += chunk.length;
      if (seen > maxBytes) {
        done(seraError('TOO_LARGE', { detail: 'node: upload exceeds the size limit' }));
        return;
      }
      done(null, chunk);
    },
  });
}

function isValidResolvedMedia(media: unknown): boolean {
  if (!media || typeof media !== 'object') return false;
  const record = media as {
    url?: unknown;
    provider?: unknown;
    title?: unknown;
    items?: unknown;
  };
  if (
    typeof record.url !== 'string' ||
    typeof record.provider !== 'string' ||
    typeof record.title !== 'string' ||
    !Array.isArray(record.items)
  ) {
    return false;
  }
  return record.items.every(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      Array.isArray((item as { plans?: unknown }).plans),
  );
}

function sanitizeUploadedFilename(requested: string): string {
  const dot = requested.lastIndexOf('.');
  const rawStem = dot > 0 ? requested.slice(0, dot) : requested;
  const ext = sanitizeExtension(dot > 0 ? requested.slice(dot + 1) : 'bin');
  if (ext === 'srt' || ext === 'vtt') {
    const subMatch = /^(.+)\.([A-Za-z0-9][A-Za-z0-9_-]{0,39})$/.exec(rawStem);
    if (subMatch?.[1] && subMatch[2]) {
      return `${sanitizeStem(subMatch[1])}.${subMatch[2]}.${ext}`;
    }
  }
  return buildFilename(rawStem, ext);
}

interface Dispatched {
  state: 'pending' | 'done' | 'failed';
  progress?: { percent: number; step: string };
  claimedBy?: string;
  media?: unknown;
  files?: readonly { name: string; mimeType: string; path: string }[];
  error?: { code: string; message: string; detail?: string };
  readonly controller: AbortController;
  settledAt?: number;
}

export function registerExtractionNodeRoutes(rootApp: FastifyInstance, engine: SeraEngine): void {
  const { config, logger, extractionNodes } = engine;
  if (!config.extractionNodes.enabled) return;

  const dispatched = new Map<string, Dispatched>();
  const DISPATCH_KEEP_MS = 60_000;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of dispatched) {
      if (entry.settledAt && now - entry.settledAt > DISPATCH_KEEP_MS) dispatched.delete(id);
    }
  }, 30_000);
  sweep.unref();

  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins are async by contract
  void rootApp.register(async (app) => {
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );

    const authenticate = (request: FastifyRequest, reply: FastifyReply): boolean => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (matchesToken(presented, config.extractionNodes.token)) return true;
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return false;
    };

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

        const { nodeId, providers, capacity, networkClass, features } = parsed.data;
        const task = await extractionNodes.claim(
          nodeId,
          providers,
          capacity,
          config.extractionNodes.claimHoldMs,
          networkClass,
          features,
        );
        if (!task) return reply.status(204).send();
        return reply.send(task);
      },
    );

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

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/resolved',
      { config: { rateLimit: false }, bodyLimit: RESOLVED_BODY_LIMIT },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const body = request.body as { media?: unknown };
        const media = body?.media;
        if (!isValidResolvedMedia(media)) {
          throw seraError('INTERNAL', { detail: 'node: resolved body had no media' });
        }

        const accepted = extractionNodes.completeResolve(
          request.params.taskId,
          media as Parameters<typeof extractionNodes.completeResolve>[1],
        );
        return reply.send({ accepted });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/failed',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        const parsed = failedSchema.safeParse(request.body);
        const rawCode = parsed.success ? parsed.data.code : '';
        const code: ErrorCode = Object.prototype.hasOwnProperty.call(MESSAGES, rawCode)
          ? (rawCode as ErrorCode)
          : 'PROVIDER_UNAVAILABLE';
        const error = parsed.success
          ? seraError(code, {
              ...(parsed.data.message ? { message: parsed.data.message } : {}),
              ...(parsed.data.detail ? { detail: `node: ${parsed.data.detail}` } : {}),
            })
          : seraError('PROVIDER_UNAVAILABLE', { detail: 'node: malformed failure report' });

        const accepted = extractionNodes.fail(request.params.taskId, error);
        return reply.send({ accepted });
      },
    );

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
          return reply.status(409).send({ accepted: false, cancelled: true });
        }

        const directory = join(config.dataDir, `remote-${taskId}`);
        await mkdir(directory, { recursive: true });
        const existing = await readdir(directory).catch(() => [] as string[]);
        if (existing.length >= config.maxItemsPerJob * 2) {
          throw seraError('TOO_LARGE', { detail: 'node: too many uploaded files' });
        }
        let existingBytes = 0;
        for (const entry of existing) {
          existingBytes += await stat(join(directory, entry)).then(
            (info) => info.size,
            () => 0,
          );
        }
        const remainingBytes = Math.max(0, config.maxFilesizeBytes - existingBytes);
        const taken = new Set(existing.map((entry) => entry.toLowerCase()));
        const name = dedupeFilename(
          sanitizeUploadedFilename(request.query.name ?? 'media.bin'),
          taken,
        );
        const path = join(directory, name);

        try {
          await pipeline(
            request.raw,
            limitTo(remainingBytes, () => extractionNodes.isCancelled(taskId)),
            createWriteStream(path),
            { signal: AbortSignal.timeout(config.jobTimeoutSeconds * 1000) },
          );
        } catch (error) {
          await rm(path, { force: true }).catch(() => undefined);
          if (existing.length === 0) {
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          }
          if (error instanceof SeraError && error.code === 'CANCELLED') {
            return reply.status(409).send({ accepted: false, cancelled: true });
          }
          if (error instanceof SeraError) throw error;
          throw seraError('NETWORK_ERROR', {
            detail: `node: upload failed: ${error instanceof Error ? error.message : 'unknown'}`,
          });
        }

        const written = await stat(path);

        const accepted = extractionNodes.acceptFile(taskId, {
          name,
          mimeType: request.query.mime ?? 'application/octet-stream',
          path,
        });
        if (!accepted) await rm(directory, { recursive: true, force: true });
        return reply.send({ accepted, sizeBytes: written.size });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/complete',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        return reply.send({ accepted: extractionNodes.completeJob(request.params.taskId) });
      },
    );

    app.get('/internal/extraction/nodes', { config: { rateLimit: false } }, (request, reply) => {
      if (!authenticate(request, reply)) return reply;
      return reply.send({ nodes: extractionNodes.status() });
    });

    app.post(
      '/internal/extraction/dispatch',
      { config: { rateLimit: false } },
      (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const parsed = dispatchSchema.safeParse(request.body);
        if (!parsed.success) {
          throw seraError('INVALID_URL', {
            message: 'Malformed dispatch.',
            detail: 'node: bad dispatch body',
          });
        }

        const taskId = randomUUID().replace(/-/g, '');
        const entry: Dispatched = { state: 'pending', controller: new AbortController() };
        dispatched.set(taskId, entry);

        const task = parsed.data;
        const options = {
          onProgress: (progress: { percent: number; step: string }) => {
            entry.progress = { percent: progress.percent, step: progress.step };
          },
          onClaimed: (nodeId: string) => {
            entry.claimedBy = nodeId;
          },
          signal: entry.controller.signal,
        };

        const running =
          task.kind === 'job'
            ? extractionNodes.dispatchJob(task, options).then((files) => {
                entry.files = files;
              })
            : extractionNodes.dispatch(task, options).then((media) => {
                entry.media = media;
              });

        void running.then(
          () => {
            entry.state = 'done';
            entry.settledAt = Date.now();
          },
          (error: unknown) => {
            const failure = SeraError.from(error);
            entry.state = 'failed';
            entry.error = {
              code: failure.code,
              message: failure.message,
              ...(failure.detail ? { detail: failure.detail } : {}),
            };
            entry.settledAt = Date.now();
          },
        );

        return reply.send({ taskId });
      },
    );

    app.get<{ Params: { taskId: string } }>(
      '/internal/extraction/dispatch/:taskId',
      { config: { rateLimit: false } },
      (request, reply) => {
        if (!authenticate(request, reply)) return reply;

        const entry = dispatched.get(request.params.taskId);
        if (!entry) throw seraError('NOT_FOUND', { detail: 'node: no such dispatch' });

        return reply.send({
          state: entry.state,
          ...(entry.progress ? { progress: entry.progress } : {}),
          ...(entry.claimedBy ? { claimedBy: entry.claimedBy } : {}),
          ...(entry.media ? { media: entry.media } : {}),
          ...(entry.files ? { files: entry.files } : {}),
          ...(entry.error ? { error: entry.error } : {}),
        });
      },
    );

    app.delete<{ Params: { taskId: string } }>(
      '/internal/extraction/dispatch/:taskId',
      { config: { rateLimit: false } },
      (request, reply) => {
        if (!authenticate(request, reply)) return reply;
        const entry = dispatched.get(request.params.taskId);
        entry?.controller.abort();
        return reply.send({ cancelled: entry !== undefined });
      },
    );

    logger.info(
      { claimHoldMs: config.extractionNodes.claimHoldMs },
      'extraction node endpoints mounted',
    );
  });
}
