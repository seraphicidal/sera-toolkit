import type { FastifyInstance } from 'fastify';
import { resolveRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { header, safeFetch, seraError } from '@sera/engine';
import { clientAbortSignal } from '../plugins/disconnect.js';

/** Thumbnails are small; anything larger is not a preview image. */
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

export function registerMediaRoutes(app: FastifyInstance, engine: SeraEngine): void {
  /**
   * Resolve a link.
   *
   * This is the only endpoint the homepage needs. Everything platform-specific happens
   * behind it, and the response is the same shape whether the link was a YouTube video,
   * a five-image carousel, or a bare MP4 on someone's server.
   */
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
      // Clients that keep failing are cooled down before any extractor work is spent
      // on them. Checked ahead of parsing so a flood of malformed bodies costs nothing.
      engine.abuse.assertAllowed(request.clientKey);

      const body = resolveRequestSchema.parse(request.body);
      // A visitor who navigates away should not leave a probe running.
      const signal = clientAbortSignal(request, reply);

      try {
        const info = await engine.resolver.resolve(body.url, signal);
        engine.abuse.recordSuccess(request.clientKey);
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        // A client giving up mid-probe is not abuse, so it is not counted.
        if (!signal.aborted) engine.abuse.recordFailure(request.clientKey);
        throw error;
      }
    },
  );

  /**
   * Proxy a thumbnail.
   *
   * The browser never talks to the platform's CDN directly. That keeps the visitor's
   * address and headers away from the site they pasted a link from, and because the
   * token is signed, the endpoint cannot be repurposed as a general image proxy.
   */
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
    // Serving whatever the origin returned would let a signed token become an HTML
    // delivery vector; only real image types are passed through.
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
