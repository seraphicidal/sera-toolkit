import type { FastifyInstance } from 'fastify';
import { importRequestSchema, resolveRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { header, safeFetch, seraError, SeraError } from '@sera/engine';
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

export function registerMediaRoutes(app: FastifyInstance, engine: SeraEngine): void {
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
        void engine.usage.record({ source: info.provider, kind: 'resolve', ok: true });
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        abuse.recordFailure(error instanceof SeraError ? error.code : undefined);
        void engine.usage.record({
          source: 'instagram',
          kind: 'resolve',
          ok: false,
          code: SeraError.from(error).code,
        });
        throw error;
      }
    },
  );

  app.get<{ Params: { token: string } }>('/api/thumb/:token', async (request, reply) => {
    const source = engine.resolver.verifyThumbnailToken(request.params.token);

    const response = await safeFetch(new URL(source), {
      dispatcher: engine.resolver.dispatcher,
      timeoutMs: 10_000,
      maxBytes: MAX_THUMBNAIL_BYTES,
    });

    if (response.status >= 400) throw seraError('NOT_FOUND');

    const contentType =
      (header(response.headers, 'content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!IMAGE_TYPES.has(contentType))
      throw seraError('NOT_FOUND', { detail: `thumb type ${contentType}` });

    return reply
      .header('content-type', contentType)
      .header('cache-control', 'public, max-age=3600, immutable')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(response.body);
  });
}
