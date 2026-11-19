import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  claimSchema,
  dispatchSchema,
  failedSchema,
  progressSchema,
  resolvedBodySchema,
  type ErrorCode,
} from '@sera/contracts';
import {
  buildFilename,
  MESSAGES,
  sanitizeExtension,
  sanitizeStem,
  seraError,
  SeraError,
  type SeraEngine,
} from '@sera/engine';
import { z } from 'zod';
import { matchesToken } from '../plugins/client.js';
import {
  authenticateExtractionNode,
  createExtractionUpdatesService,
  extractionInternalRateLimit,
  type ExtractionUpdatesService,
  type NodeAuthIdentity,
} from './extraction-updates.js';

const fileUploadQuerySchema = z.object({
  name: z.string().max(240).optional(),
  mime: z.string().max(120).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const fileStatusQuerySchema = z.object({
  name: z.string().max(240).optional(),
});

const dispatchPollQuerySchema = z.object({
  wait: z.string().max(16).optional(),
  seenStep: z.string().max(120).optional(),
  seenPercent: z.string().max(32).optional(),
});

const RESOLVED_BODY_LIMIT = 4 * 1024 * 1024;
const UPLOAD_LEASE_RENEW_INTERVAL_MS = 5_000;

interface ParsedContentRange {
  readonly start: number;
  readonly end?: number;
  readonly total?: number;
}

function parseContentRange(
  rawHeader: string | undefined,
): ParsedContentRange | 'invalid' | undefined {
  if (rawHeader === undefined) return undefined;
  const match = /^bytes\s+(\d+)-(\d+|\*)\/(\d+|\*)$/i.exec(rawHeader.trim());
  if (!match?.[1] || !match[2] || !match[3]) return 'invalid';
  const start = Number.parseInt(match[1], 10);
  const end = match[2] === '*' ? undefined : Number.parseInt(match[2], 10);
  const total = match[3] === '*' ? undefined : Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(start) || start < 0) return 'invalid';
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) return 'invalid';
  if (total !== undefined) {
    if (!Number.isSafeInteger(total) || total <= 0) return 'invalid';
    if (start >= total) return 'invalid';
    if (end !== undefined && end >= total) return 'invalid';
  }
  return {
    start,
    ...(end !== undefined ? { end } : {}),
    ...(total !== undefined ? { total } : {}),
  };
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

interface FileUploadEntry {
  readonly name: string;
  readonly path: string;
  sizeBytes: number;
  complete: boolean;
  generation: number;
  activeAbort?: AbortController;
  donePromise?: Promise<void>;
}

interface TaskUploadState {
  readonly files: Map<string, FileUploadEntry>;
  updatedAt: number;
  init?: Promise<void>;
}

function totalTaskBytes(state: TaskUploadState): number {
  let total = 0;
  for (const file of state.files.values()) {
    total += file.sizeBytes;
  }
  return total;
}

async function cleanupEmptyTaskDir(directory: string): Promise<void> {
  const remaining = await readdir(directory).catch(() => [] as string[]);
  if (remaining.length === 0) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerExtractionNodeRoutes(
  rootApp: FastifyInstance,
  engine: SeraEngine,
  updates: ExtractionUpdatesService = createExtractionUpdatesService(engine),
): void {
  const { config, logger, extractionNodes } = engine;
  if (!config.extractionNodes.enabled) return;

  const dispatched = new Map<string, Dispatched>();
  const DISPATCH_KEEP_MS = 60_000;
  const TASK_UPLOAD_IDLE_MS = 15 * 60_000;
  const taskUploads = new Map<string, TaskUploadState>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of dispatched) {
      if (entry.settledAt && now - entry.settledAt > DISPATCH_KEEP_MS) {
        dispatched.delete(id);
        taskUploads.delete(id);
        void rm(join(config.dataDir, `remote-${id}`), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    for (const [id, upload] of taskUploads) {
      if (now - upload.updatedAt > TASK_UPLOAD_IDLE_MS) {
        for (const file of upload.files.values()) {
          file.activeAbort?.abort();
        }
        taskUploads.delete(id);
        void rm(join(config.dataDir, `remote-${id}`), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }, 30_000);
  sweep.unref();
  rootApp.addHook('onClose', async () => {
    clearInterval(sweep);
  });

  void rootApp.register(async (app) => {
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );

    const authenticateNode = (
      request: FastifyRequest,
      reply: FastifyReply,
    ): NodeAuthIdentity | undefined => authenticateExtractionNode(request, reply, engine);

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
      if (
        !config.extractionNodes.workerToken &&
        config.extractionNodes.legacyTokenUsed &&
        config.extractionNodes.token &&
        matchesToken(presented, config.extractionNodes.token)
      ) {
        return true;
      }
      void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return false;
    };

    const internalRateLimit = extractionInternalRateLimit(engine);

    const validateTaskOwnership = (
      taskId: string,
      auth: NodeAuthIdentity,
      reply: FastifyReply,
    ): boolean => {
      if (!/^[a-f0-9]{16,64}$/.test(taskId)) {
        void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return false;
      }
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

    const getOrInitUploadState = async (
      taskId: string,
      directory: string,
    ): Promise<TaskUploadState> => {
      let uploadState = taskUploads.get(taskId);
      if (!uploadState) {
        const created: TaskUploadState = {
          files: new Map<string, FileUploadEntry>(),
          updatedAt: Date.now(),
        };
        created.init = (async () => {
          try {
            await mkdir(directory, { recursive: true });
            const existing = await readdir(directory).catch(() => [] as string[]);
            for (const entryName of existing) {
              const entryPath = join(directory, entryName);
              const sizeBytes = await stat(entryPath).then(
                (info) => (info.isFile() ? info.size : 0),
                () => 0,
              );
              created.files.set(entryName.toLowerCase(), {
                name: entryName,
                path: entryPath,
                sizeBytes,
                complete: false,
                generation: 0,
              });
            }
          } catch (error) {
            if (taskUploads.get(taskId) === created) taskUploads.delete(taskId);
            throw error;
          }
        })();
        taskUploads.set(taskId, created);
        uploadState = created;
      }
      uploadState.updatedAt = Date.now();
      await uploadState.init;
      uploadState.updatedAt = Date.now();
      return uploadState;
    };

    app.post('/internal/extraction/claim', internalRateLimit, async (request, reply) => {
      const auth = authenticateNode(request, reply);
      if (!auth) return reply;

      const parsed = claimSchema.safeParse(request.body);
      if (!parsed.success) {
        throw seraError('INVALID_URL', {
          message: 'Malformed claim.',
          detail: 'node: bad claim body',
        });
      }

      const {
        nodeId,
        providers,
        capacity,
        networkClass,
        features,
        transport,
        appVersion,
        ytdlpVersion,
        ffmpegVersion,
      } = parsed.data;
      if (!auth.isLegacy && auth.nodeId !== nodeId) {
        void reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
        return reply;
      }

      const [task, manifestHash] = await Promise.all([
        extractionNodes.claim(
          nodeId,
          providers,
          capacity,
          config.extractionNodes.claimHoldMs,
          networkClass,
          features,
          {
            ...(transport ? { transport } : {}),
            ...(appVersion ? { appVersion } : {}),
            ...(ytdlpVersion ? { ytdlpVersion } : {}),
            ...(ffmpegVersion ? { ffmpegVersion } : {}),
          },
        ),
        updates.currentManifestHash(),
      ]);
      void reply.header('x-sera-manifest-hash', manifestHash);
      if (!task) return reply.status(204).send();
      return reply.send(task);
    });

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/progress',
      internalRateLimit,
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
      { ...internalRateLimit, bodyLimit: RESOLVED_BODY_LIMIT },
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
      internalRateLimit,
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

        await rm(join(config.dataDir, `remote-${request.params.taskId}`), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        taskUploads.delete(request.params.taskId);
        const accepted = extractionNodes.fail(request.params.taskId, error);
        return reply.send({ accepted });
      },
    );

    app.get<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/file',
      internalRateLimit,
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;

        const { taskId } = request.params;
        if (!validateTaskOwnership(taskId, auth, reply)) return reply;

        const query = fileStatusQuerySchema.parse(request.query);
        const name = sanitizeUploadedFilename(query.name ?? 'media.bin');
        const directory = join(config.dataDir, `remote-${taskId}`);
        const uploadState = taskUploads.get(taskId);
        const entry = uploadState?.files.get(name.toLowerCase());
        const diskInfo = await stat(join(directory, name)).catch(() => undefined);
        const exists = Boolean(diskInfo?.isFile());
        const sizeBytes = diskInfo?.isFile() ? diskInfo.size : 0;
        const complete = Boolean(exists && entry?.complete);
        return reply.send({ exists, complete, sizeBytes });
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/file',
      internalRateLimit,
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;

        const query = fileUploadQuerySchema.parse(request.query);
        const rawContentType = (request.headers['content-type'] ?? '')
          .split(';')[0]
          ?.trim()
          .toLowerCase();
        if (rawContentType && rawContentType !== 'application/octet-stream') {
          return reply.status(415).send({
            error: { code: 'INVALID_URL', message: 'Expected application/octet-stream.' },
          });
        }

        const rawContentRange = request.headers['content-range'];
        const contentRange = parseContentRange(
          typeof rawContentRange === 'string' ? rawContentRange : undefined,
        );
        if (contentRange === 'invalid') {
          throw seraError('INVALID_URL', {
            message: 'Malformed Content-Range.',
            detail: 'node: invalid Content-Range header',
          });
        }
        if (
          query.offset !== undefined &&
          contentRange !== undefined &&
          query.offset !== contentRange.start
        ) {
          throw seraError('INVALID_URL', {
            message: 'Conflicting upload offset.',
            detail: 'node: offset query disagrees with Content-Range',
          });
        }
        if (contentRange?.total !== undefined && contentRange.total > config.maxFilesizeBytes) {
          throw seraError('TOO_LARGE', { detail: 'node: upload exceeds the size limit' });
        }

        const startOffset = contentRange?.start ?? query.offset ?? 0;

        const { taskId } = request.params;
        if (!/^[a-f0-9]{16,64}$/.test(taskId)) {
          throw seraError('NOT_FOUND', { detail: 'node: malformed task id' });
        }
        if (!validateTaskOwnership(taskId, auth, reply)) return reply;
        if (extractionNodes.isCancelled(taskId)) {
          return reply.status(409).send({ accepted: false, cancelled: true });
        }

        const directory = join(config.dataDir, `remote-${taskId}`);
        const uploadState = await getOrInitUploadState(taskId, directory);

        const name = sanitizeUploadedFilename(query.name ?? 'media.bin');
        const key = name.toLowerCase();
        const path = join(directory, name);

        let existing = uploadState.files.get(key);
        if (!existing && uploadState.files.size >= config.maxItemsPerJob * 2) {
          throw seraError('TOO_LARGE', { detail: 'node: too many uploaded files' });
        }

        while (existing?.activeAbort) {
          existing.activeAbort.abort();
          await existing.donePromise?.catch(() => undefined);
          existing = uploadState.files.get(key);
        }

        if (extractionNodes.isCancelled(taskId)) {
          return reply.status(409).send({ accepted: false, cancelled: true });
        }

        const myGeneration = (existing?.generation ?? 0) + 1;
        const uploadAbort = new AbortController();
        let resolveDone!: () => void;
        const donePromise = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });

        const entry: FileUploadEntry = existing ?? {
          name,
          path,
          sizeBytes: 0,
          complete: false,
          generation: myGeneration,
        };
        entry.generation = myGeneration;
        entry.complete = false;
        entry.activeAbort = uploadAbort;
        entry.donePromise = donePromise;
        uploadState.files.set(key, entry);

        try {
          const diskSize = await stat(path).then(
            (info) => (info.isFile() ? info.size : 0),
            () => 0,
          );
          if (startOffset > diskSize) {
            entry.sizeBytes = diskSize;
            return await reply
              .status(416)
              .header('x-sera-received-bytes', String(diskSize))
              .send({
                error: { code: 'INVALID_URL', message: 'Upload offset exceeds received bytes.' },
                receivedBytes: diskSize,
              });
          }
          if (startOffset > 0 && startOffset < diskSize) {
            await truncate(path, startOffset);
          }

          entry.sizeBytes = startOffset;
          if (totalTaskBytes(uploadState) > config.maxFilesizeBytes) {
            throw seraError('TOO_LARGE', { detail: 'node: upload exceeds the size limit' });
          }

          let lastLeaseRenewAt = Date.now();
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              if (extractionNodes.isCancelled(taskId) || entry.generation !== myGeneration) {
                done(seraError('CANCELLED'));
                return;
              }
              entry.sizeBytes += chunk.length;
              uploadState.updatedAt = Date.now();
              const now = uploadState.updatedAt;
              if (now - lastLeaseRenewAt >= UPLOAD_LEASE_RENEW_INTERVAL_MS) {
                lastLeaseRenewAt = now;
                extractionNodes.renewLease(taskId);
              }
              if (totalTaskBytes(uploadState) > config.maxFilesizeBytes) {
                done(seraError('TOO_LARGE', { detail: 'node: upload exceeds the size limit' }));
                return;
              }
              done(null, chunk);
            },
          });

          const writeStream =
            startOffset === 0
              ? createWriteStream(path, { flags: 'w' })
              : createWriteStream(path, { flags: 'a' });

          try {
            await pipeline(request.raw, limiter, writeStream, {
              signal: AbortSignal.any([
                AbortSignal.timeout(config.jobTimeoutSeconds * 1000),
                uploadAbort.signal,
              ]),
            });
          } catch (error) {
            if (entry.generation !== myGeneration) {
              return await reply.status(409).send({ accepted: false, superseded: true });
            }
            if (error instanceof SeraError && error.code === 'CANCELLED') {
              uploadState.files.delete(key);
              await rm(path, { force: true }).catch(() => undefined);
              await cleanupEmptyTaskDir(directory);
              return await reply.status(409).send({ accepted: false, cancelled: true });
            }
            if (error instanceof SeraError && error.code === 'TOO_LARGE') {
              uploadState.files.delete(key);
              await rm(path, { force: true }).catch(() => undefined);
              await cleanupEmptyTaskDir(directory);
              throw error;
            }
            if (error instanceof SeraError) throw error;
            entry.sizeBytes = await stat(path).then(
              (info) => (info.isFile() ? info.size : 0),
              () => 0,
            );
            entry.complete = false;
            throw seraError('NETWORK_ERROR', {
              detail: `node: upload failed: ${error instanceof Error ? error.message : 'unknown'}`,
            });
          }

          if (entry.generation !== myGeneration) {
            return await reply.status(409).send({ accepted: false, superseded: true });
          }

          const written = await stat(path);
          entry.sizeBytes = written.size;

          const isPartialRange =
            contentRange?.total !== undefined && written.size < contentRange.total;
          if (isPartialRange) {
            return await reply.send({ accepted: true, complete: false, sizeBytes: written.size });
          }

          const accepted = extractionNodes.acceptFile(taskId, {
            name,
            mimeType: query.mime ?? 'application/octet-stream',
            path,
          });
          if (!accepted) {
            uploadState.files.delete(key);
            await rm(path, { force: true }).catch(() => undefined);
            await cleanupEmptyTaskDir(directory);
          } else {
            entry.complete = true;
          }
          return await reply.send({ accepted, sizeBytes: written.size });
        } finally {
          if (entry.generation === myGeneration) {
            entry.activeAbort = undefined;
            entry.donePromise = undefined;
          }
          resolveDone();
        }
      },
    );

    app.post<{ Params: { taskId: string } }>(
      '/internal/extraction/:taskId/complete',
      internalRateLimit,
      async (request, reply) => {
        const auth = authenticateNode(request, reply);
        if (!auth) return reply;
        if (!validateTaskOwnership(request.params.taskId, auth, reply)) return reply;
        taskUploads.delete(request.params.taskId);
        return reply.send({ accepted: extractionNodes.completeJob(request.params.taskId) });
      },
    );

    app.get('/internal/extraction/nodes', internalRateLimit, (request, reply) => {
      if (!authenticateWorker(request, reply)) return reply;
      return reply.send({ nodes: extractionNodes.status() });
    });

    app.post('/internal/extraction/dispatch', internalRateLimit, (request, reply) => {
      if (!authenticateWorker(request, reply)) return reply;
      if (dispatched.size >= 5_000) {
        throw seraError('QUEUE_FULL', { detail: 'node: dispatch queue full' });
      }

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
    });

    app.get<{ Params: { taskId: string } }>(
      '/internal/extraction/dispatch/:taskId',
      internalRateLimit,
      async (request, reply) => {
        if (!authenticateWorker(request, reply)) return reply;

        const entry = dispatched.get(request.params.taskId);
        if (!entry) throw seraError('NOT_FOUND', { detail: 'node: no such dispatch' });

        const query = dispatchPollQuerySchema.parse(request.query);
        const waitParam = Number.parseInt(query.wait ?? '0', 10);
        const waitMs =
          Number.isFinite(waitParam) && waitParam > 0 ? Math.min(20, waitParam) * 1000 : 0;

        if (waitMs > 0 && entry.state === 'pending') {
          const seenStep = query.seenStep;
          const rawPercent =
            query.seenPercent !== undefined ? Number.parseFloat(query.seenPercent) : undefined;
          const seenPercent =
            rawPercent !== undefined && Number.isFinite(rawPercent) ? rawPercent : undefined;

          const isUnchanged = () =>
            entry.progress === undefined
              ? seenStep === undefined && seenPercent === undefined
              : (seenStep !== undefined || seenPercent !== undefined) &&
                (seenStep === undefined || entry.progress.step === seenStep) &&
                (seenPercent === undefined || entry.progress.percent === seenPercent);

          if (isUnchanged()) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const settle = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
              };
              const listener = () => {
                if (!isUnchanged() || entry.state !== 'pending') {
                  settle();
                }
              };
              const onAbort = () => {
                settle();
              };
              const cleanup = () => {
                clearTimeout(timer);
                entry.listeners.delete(listener);
                request.signal.removeEventListener('abort', onAbort);
              };
              const timer = setTimeout(settle, waitMs);
              if (request.signal.aborted) {
                settle();
                return;
              }
              entry.listeners.add(listener);
              request.signal.addEventListener('abort', onAbort, { once: true });
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
      internalRateLimit,
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
