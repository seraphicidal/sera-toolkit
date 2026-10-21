import type { FastifyInstance } from 'fastify';
import { importRequestSchema, resolveRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { header, hostMatchesAny, safeFetch, seraError, SeraError } from '@sera/engine';
import { abuseGuardFor } from '../plugins/client.js';
import { clientAbortSignal } from '../plugins/disconnect.js';

const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

const MAX_IMPORT_BODY_BYTES = 512 * 1024;

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

interface CachedThumbnail {
  readonly body: Buffer;
  readonly contentType: string;
  readonly expiresAt: number;
  readonly sizeBytes: number;
}

export class ThumbnailCache {
  private readonly entries = new Map<string, CachedThumbnail>();
  private readonly inFlight = new Map<string, Promise<{ body: Buffer; contentType: string }>>();
  private currentBytes = 0;

  constructor(
    private readonly maxEntries = 200,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  get(url: string, now = Date.now()): CachedThumbnail | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(url);
      this.currentBytes -= entry.sizeBytes;
      return undefined;
    }
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry;
  }

  set(url: string, body: Buffer, contentType: string, now = Date.now()): void {
    const existing = this.entries.get(url);
    if (existing) {
      this.entries.delete(url);
      this.currentBytes -= existing.sizeBytes;
    }
    const sizeBytes = body.byteLength;
    if (sizeBytes > this.maxBytes) return;
    this.entries.set(url, {
      body,
      contentType,
      sizeBytes,
      expiresAt: now + this.ttlMs,
    });
    this.currentBytes += sizeBytes;
    this.evict(now);
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.currentBytes -= entry.sizeBytes;
      }
    }
    while (this.entries.size > this.maxEntries || this.currentBytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      if (entry) this.currentBytes -= entry.sizeBytes;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.currentBytes;
  }

  getInFlight(url: string): Promise<{ body: Buffer; contentType: string }> | undefined {
    return this.inFlight.get(url);
  }

  setInFlight(url: string, promise: Promise<{ body: Buffer; contentType: string }>): void {
    this.inFlight.set(url, promise);
  }

  deleteInFlight(url: string): void {
    this.inFlight.delete(url);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.currentBytes = 0;
  }
}

export function registerMediaRoutes(app: FastifyInstance, engine: SeraEngine): void {
  const thumbnailCache = new ThumbnailCache();
  app.post(
    '/api/media/info',
    {
      config: {
        rateLimit: {
          max: engine.config.rateLimitResolvePerMinute,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const abuse = abuseGuardFor(engine, request);
      abuse.assertAllowed();

      const body = resolveRequestSchema.parse(request.body);
      const signal = clientAbortSignal(request, reply);

      try {
        const info = await engine.resolver.resolve(body.url, signal, request.id);
        abuse.recordSuccess();
        if (!request.canary)
          void engine.usage.record({ source: info.provider, kind: 'resolve', ok: true });
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        if (!signal.aborted) {
          abuse.recordFailure(error instanceof SeraError ? error.code : undefined);
          if (!request.canary) {
            void engine.usage.record({
              source: engine.resolver.sourceOf(body.url),
              kind: 'resolve',
              ok: false,
              code: SeraError.from(error).code,
            });
          }
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/media/import',
    {
      bodyLimit: MAX_IMPORT_BODY_BYTES,
      config: {
        rateLimit: {
          max: engine.config.rateLimitResolvePerMinute,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const abuse = abuseGuardFor(engine, request);
      abuse.assertAllowed();
      const body = importRequestSchema.parse(request.body);

      try {
        const info = engine.resolver.importSubmitted(body, request.id);
        abuse.recordSuccess();
        if (!request.canary) {
          void engine.usage.record({ source: info.provider, kind: 'resolve', ok: true });
        }
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        abuse.recordFailure(error instanceof SeraError ? error.code : undefined);
        if (!request.canary) {
          void engine.usage.record({
            source: 'instagram',
            kind: 'resolve',
            ok: false,
            code: SeraError.from(error).code,
          });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { token: string } }>(
    '/api/thumb/:token',
    {
      config: {
        rateLimit: {
          max: engine.config.rateLimitThumbnailsPerMinute,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const source = engine.resolver.verifyThumbnailToken(request.params.token);
      let target: URL;
      try {
        target = new URL(source);
      } catch {
        throw seraError('NOT_FOUND');
      }

      const cached = thumbnailCache.get(source);
      if (cached) {
        return reply
          .header('content-type', cached.contentType)
          .header('cache-control', 'public, max-age=3600, immutable')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('x-content-type-options', 'nosniff')
          .send(cached.body);
      }

      const active = thumbnailCache.getInFlight(source);
      const data = active
        ? await active
        : await (() => {
            const promise = (async () => {
              try {
                const response = await safeFetch(target, {
                  dispatcher: engine.resolver.dispatcher,
                  timeoutMs: 10_000,
                  maxBytes: MAX_THUMBNAIL_BYTES,
                  signal: clientAbortSignal(request, reply),
                  allowUrl: (url) => !hostMatchesAny(url.hostname, engine.config.blockedHosts),
                });

                if (response.status >= 400) throw seraError('NOT_FOUND');

                const contentType =
                  (header(response.headers, 'content-type') ?? '')
                    .split(';')[0]
                    ?.trim()
                    .toLowerCase() ?? '';
                if (!IMAGE_TYPES.has(contentType))
                  throw seraError('NOT_FOUND', { detail: `thumb type ${contentType}` });

                thumbnailCache.set(source, response.body, contentType);
                return { body: response.body, contentType };
              } finally {
                thumbnailCache.deleteInFlight(source);
              }
            })();
            thumbnailCache.setInFlight(source, promise);
            return promise;
          })();

      return reply
        .header('content-type', data.contentType)
        .header('cache-control', 'public, max-age=3600, immutable')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('x-content-type-options', 'nosniff')
        .send(data.body);
    },
  );
}
