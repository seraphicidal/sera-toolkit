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

const resolvedPlanSchema = z.object({
  kind: z.enum(['video', 'audio', 'image', 'gif', 'carousel']),
  container: z.string().min(1).max(16),
  label: z.string().min(1).max(64),
  detail: z.string().max(500).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  audioBitrateKbps: z.number().positive().optional(),
  videoCodec: z.string().max(32).optional(),
  audioCodec: z.string().max(32).optional(),
  filesizeBytes: z.number().int().nonnegative().optional(),
  filesizeIsApproximate: z.boolean().optional(),
  requiresConversion: z.boolean(),
  recommended: z.boolean(),
  fetch: z.discriminatedUnion('via', [
    z.object({
      via: z.literal('ytdlp'),
      selector: z.string().min(1).max(500),
      merge: z.string().max(16).optional(),
      audio: z
        .object({
          format: z.string().min(1).max(16),
          quality: z.string().max(16).optional(),
        })
        .optional(),
      remux: z.string().max(16).optional(),
      extractorArgs: z.array(z.string().max(200)).max(20).optional(),
      target: z.string().url().max(2048).optional(),
      useExtractors: z.string().max(100).optional(),
    }),
    z.object({
      via: z.literal('direct'),
      url: z.string().url().max(2048),
    }),
  ]),
  convert: z.record(z.string(), z.unknown()).optional(),
});

const resolvedItemSchema = z.object({
  sourceId: z.string().max(200).optional(),
  index: z.number().int().nonnegative(),
  kind: z.enum(['video', 'audio', 'image', 'gif', 'carousel', 'unknown']),
  title: z.string().max(500).optional(),
  thumbnailUrl: z.string().url().max(2048).optional(),
  thumbnailFallbackUrl: z.string().url().max(2048).optional(),
  subtitles: z
    .array(
      z.object({
        lang: z.string().max(40),
        label: z.string().max(100),
        auto: z.boolean().optional(),
      }),
    )
    .optional(),
  tags: z
    .object({
      artist: z.string().max(200).optional(),
      album: z.string().max(200).optional(),
      track: z.string().max(200).optional(),
    })
    .optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional(),
  container: z.string().max(16).optional(),
  filesizeBytes: z.number().int().nonnegative().optional(),
  isLive: z.boolean().optional(),
  plans: z.array(resolvedPlanSchema).min(1),
});

const resolvedMediaSchema = z.object({
  provider: z.string().min(1).max(32),
  providerLabel: z.string().min(1).max(64),
  url: z.string().url().max(2048),
  type: z.enum(['single', 'collection', 'playlist', 'multi']),
  title: z.string().max(500),
  description: z.string().max(5000).optional(),
  author: z.string().max(200).optional(),
  authorUrl: z.string().url().max(2048).optional(),
  thumbnailUrl: z.string().url().max(2048).optional(),
  duration: z.number().nonnegative().optional(),
  createdAt: z.string().max(64).optional(),
  remoteBackend: z.string().max(64).optional(),
  items: z.array(resolvedItemSchema).min(1),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const resolvedBodySchema = z.object({
  media: resolvedMediaSchema,
});

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
  progress?: {
    percent: number;
    step: string;
    bytesDownloaded?: number;
    bytesTotal?: number;
  };
  claimedBy?: string;
  media?: unknown;
  files?: readonly { name: string; mimeType: string; path: string }[];
  error?: { code: string; message: string; detail?: string };
  readonly controller: AbortController;
  settledAt?: number;
  readonly listeners: Set<() => void>;
}

export function registerExtractionNodeRoutes(rootApp: FastifyInstance, engine: SeraEngine): void {
  const { config, logger, extractionNodes } = engine;
  if (!config.extractionNodes.enabled) return;

  const dispatched = new Map<string, Dispatched>();
  const DISPATCH_KEEP_MS = 60_000;
  const taskByteTrackers = new Map<string, { bytes: number }>();
  const taskInFlightFiles = new Map<string, Set<string>>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of dispatched) {
      if (entry.settledAt && now - entry.settledAt > DISPATCH_KEEP_MS) {
        dispatched.delete(id);
        taskByteTrackers.delete(id);
        taskInFlightFiles.delete(id);
      }
    }
  }, 30_000);
  sweep.unref();

  void rootApp.register(async (app) => {
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );

    const authenticateNode = (
      request: FastifyRequest,
      reply: FastifyReply,
    ): { nodeId: string; isLegacy?: boolean } | undefined => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!presented) {
        void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return undefined;
      }
      for (const [nodeId, token] of config.extractionNodes.tokens) {
        if (matchesToken(presented, token)) return { nodeId };
      }
      if (
        config.extractionNodes.legacyTokenUsed &&
        config.extractionNodes.token &&
        matchesToken(presented, config.extractionNodes.token)
      ) {
        return { nodeId: 'legacy', isLegacy: true };
      }
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return undefined;
    };

    const authenticateWorker = (request: FastifyRequest, reply: FastifyReply): boolean => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!presented) {
        void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return false;
      }
      if (
        config.extractionNodes.workerToken &&
        matchesToken(presented, config.extractionNodes.workerToken)
      ) {
        return true;
      }
      if (config.adminToken && matchesToken(presented, config.adminToken)) {
        return true;
      }
      if (
        config.extractionNodes.legacyTokenUsed &&
        config.extractionNodes.token &&
        matchesToken(presented, config.extractionNodes.token)
      ) {
        return true;
      }
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return false;
    };

    const validateTaskOwnership = (
      taskId: string,
      auth: { nodeId: string; isLegacy?: boolean },
      reply: FastifyReply,
    ): boolean => {
      const owner = extractionNodes.claimedBy(taskId);
      if (!owner) {
        void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return false;
      }
      if (!auth.isLegacy && auth.nodeId !== owner) {
        void reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
        return false;
      }
      return true;
    };

    app.post(
      '/internal/extraction/claim',
      { config: { rateLimit: false } },
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;

        const parsed = claimSchema.safeParse(request.body);
        if (!parsed.success) {
          throw seraError('INVALID_URL', {
            message: 'Malformed claim.',
            detail: 'node: bad claim body',
          });
        }

        const { nodeId, providers, capacity, networkClass, features } = parsed.data;
        if (!auth.isLegacy && auth.nodeId !== nodeId) {
          void reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
          return reply;
        }

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
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;
        if (!validateTaskOwnership(request.params.taskId, auth, reply)) return reply;

        const parsed = progressSchema.safeParse(request.body);
        if (parsed.success) extractionNodes.reportProgress(request.params.taskId, parsed.data);
        return reply.send({ cancelled: extractionNodes.isCancelled(request.params.taskId) });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/resolved',
      { config: { rateLimit: false }, bodyLimit: RESOLVED_BODY_LIMIT },
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;
        if (!validateTaskOwnership(request.params.taskId, auth, reply)) return reply;

        const parsed = resolvedBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw seraError('INVALID_URL', {
            message: 'Malformed resolved media.',
            detail: 'node: bad resolved body',
          });
        }

        const accepted = extractionNodes.completeResolve(
          request.params.taskId,
          parsed.data.media as Parameters<typeof extractionNodes.completeResolve>[1],
        );
        return reply.send({ accepted });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/failed',
      { config: { rateLimit: false } },
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;
        if (!validateTaskOwnership(request.params.taskId, auth, reply)) return reply;

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

        taskByteTrackers.delete(request.params.taskId);
        taskInFlightFiles.delete(request.params.taskId);
        const accepted = extractionNodes.fail(request.params.taskId, error);
        return reply.send({ accepted });
      },
    );

    app.post<{ Params: { taskId: string }; Querystring: { name?: string; mime?: string } }>(
      '/internal/extraction/:taskId/file',
      { config: { rateLimit: false } },
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;

        const { taskId } = request.params;
        if (!/^[a-f0-9]{16,64}$/.test(taskId)) {
          throw seraError('NOT_FOUND', { detail: 'node: malformed task id' });
        }
        if (!validateTaskOwnership(taskId, auth, reply)) return reply;
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
        let tracker = taskByteTrackers.get(taskId);
        if (!tracker) {
          tracker = { bytes: existingBytes };
          taskByteTrackers.set(taskId, tracker);
        }

        let inFlight = taskInFlightFiles.get(taskId);
        if (!inFlight) {
          inFlight = new Set<string>();
          taskInFlightFiles.set(taskId, inFlight);
        }
        for (const entry of existing) inFlight.add(entry.toLowerCase());

        const name = dedupeFilename(
          sanitizeUploadedFilename(request.query.name ?? 'media.bin'),
          inFlight,
        );
        inFlight.add(name.toLowerCase());
        const path = join(directory, name);

        let streamBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            if (extractionNodes.isCancelled(taskId)) {
              done(seraError('CANCELLED'));
              return;
            }
            tracker.bytes += chunk.length;
            streamBytes += chunk.length;
            if (tracker.bytes > config.maxFilesizeBytes) {
              done(seraError('TOO_LARGE', { detail: 'node: upload exceeds the size limit' }));
              return;
            }
            done(null, chunk);
          },
        });

        try {
          await pipeline(request.raw, limiter, createWriteStream(path), {
            signal: AbortSignal.timeout(config.jobTimeoutSeconds * 1000),
          });
        } catch (error) {
          tracker.bytes -= streamBytes;
          inFlight.delete(name.toLowerCase());
          await rm(path, { force: true }).catch(() => undefined);
          const remaining = await readdir(directory).catch(() => [] as string[]);
          if (remaining.length === 0) {
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
        if (!accepted) {
          tracker.bytes -= streamBytes;
          inFlight.delete(name.toLowerCase());
          await rm(path, { force: true }).catch(() => undefined);
          const remaining = await readdir(directory).catch(() => [] as string[]);
          if (remaining.length === 0) {
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        return reply.send({ accepted, sizeBytes: written.size });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/complete',
      { config: { rateLimit: false } },
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;
        if (!validateTaskOwnership(request.params.taskId, auth, reply)) return reply;
        taskByteTrackers.delete(request.params.taskId);
        taskInFlightFiles.delete(request.params.taskId);
        return reply.send({ accepted: extractionNodes.completeJob(request.params.taskId) });
      },
    );

    app.get('/internal/extraction/nodes', { config: { rateLimit: false } }, (request, reply) => {
      if (!authenticateWorker(request, reply)) return reply;
      return reply.send({ nodes: extractionNodes.status() });
    });

    app.post(
      '/internal/extraction/dispatch',
      { config: { rateLimit: false } },
      (request, reply) => {
        if (!authenticateWorker(request, reply)) return reply;

        const parsed = dispatchSchema.safeParse(request.body);
        if (!parsed.success) {
          throw seraError('INVALID_URL', {
            message: 'Malformed dispatch.',
            detail: 'node: bad dispatch body',
          });
        }

        const taskId = randomUUID().replace(/-/g, '');
        const entry: Dispatched = {
          state: 'pending',
          controller: new AbortController(),
          listeners: new Set(),
        };
        dispatched.set(taskId, entry);

        const notify = () => {
          for (const listener of entry.listeners) listener();
        };

        const task = parsed.data;
        const options = {
          onProgress: (progress: {
            percent: number;
            step: string;
            bytesDownloaded?: number;
            bytesTotal?: number;
          }) => {
            entry.progress = {
              percent: progress.percent,
              step: progress.step,
              ...(progress.bytesDownloaded !== undefined
                ? { bytesDownloaded: progress.bytesDownloaded }
                : {}),
              ...(progress.bytesTotal !== undefined ? { bytesTotal: progress.bytesTotal } : {}),
            };
            notify();
          },
          onClaimed: (nodeId: string) => {
            entry.claimedBy = nodeId;
            notify();
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
            notify();
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
            notify();
          },
        );

        return reply.send({ taskId });
      },
    );

    app.get<{
      Params: { taskId: string };
      Querystring: { wait?: string; seenStep?: string; seenPercent?: string };
    }>(
      '/internal/extraction/dispatch/:taskId',
      { config: { rateLimit: false } },
      async (request, reply) => {
        if (!authenticateWorker(request, reply)) return reply;

        const entry = dispatched.get(request.params.taskId);
        if (!entry) throw seraError('NOT_FOUND', { detail: 'node: no such dispatch' });

        const waitParam = Number.parseInt(request.query.wait ?? '0', 10);
        const waitMs =
          Number.isFinite(waitParam) && waitParam > 0 ? Math.min(20, waitParam) * 1000 : 0;

        if (waitMs > 0 && entry.state === 'pending') {
          const seenStep = request.query.seenStep;
          const seenPercent =
            request.query.seenPercent !== undefined
              ? Number.parseFloat(request.query.seenPercent)
              : undefined;

          const isUnchanged = () =>
            (seenStep === undefined && seenPercent === undefined && entry.progress === undefined) ||
            (entry.progress !== undefined &&
              (seenStep === undefined || entry.progress.step === seenStep) &&
              (seenPercent === undefined || entry.progress.percent === seenPercent));

          if (isUnchanged()) {
            await new Promise<void>((resolve) => {
              const listener = () => {
                if (!isUnchanged() || entry.state !== 'pending') {
                  cleanup();
                  resolve();
                }
              };
              const cleanup = () => {
                clearTimeout(timer);
                entry.listeners.delete(listener);
                request.signal.removeEventListener('abort', listener);
              };
              const timer = setTimeout(() => {
                cleanup();
                resolve();
              }, waitMs);
              entry.listeners.add(listener);
              request.signal.addEventListener('abort', listener);
            });
          }
        }

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
        if (!authenticateWorker(request, reply)) return reply;
        const entry = dispatched.get(request.params.taskId);
        entry?.controller.abort();
        if (entry) {
          for (const listener of entry.listeners) listener();
        }
        return reply.send({ cancelled: entry !== undefined });
      },
    );

    logger.info(
      { claimHoldMs: config.extractionNodes.claimHoldMs },
      'extraction node endpoints mounted',
    );
  });
}
