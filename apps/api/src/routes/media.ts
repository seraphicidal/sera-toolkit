import type { FastifyInstance } from 'fastify';
import { importRequestSchema, resolveRequestSchema } from '@sera/contracts';
import type { SeraEngine } from '@sera/engine';
import { header, safeFetch, seraError, SeraError } from '@sera/engine';
import { clientAbortSignal } from '../plugins/disconnect.js';

/** Thumbnails are small; anything larger is not a preview image. */
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling for a post a visitor's browser sends. Trimmed the way the bookmarklet trims it, a
 * post is a few kilobytes a slide; this is a full carousel with room to spare, and far short
 * of a body worth sending to exhaust memory. Anything larger is refused before it is parsed.
 */
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
        const info = await engine.resolver.resolve(body.url, signal, request.id);
        engine.abuse.recordSuccess(request.clientKey);
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        // A client giving up mid-probe is not abuse, and neither is a private or
        // deleted post; only the codes that suggest probing count.
        if (!signal.aborted) {
          engine.abuse.recordFailure(
            request.clientKey,
            error instanceof SeraError ? error.code : undefined,
          );
        }
        throw error;
      }
    },
  );

  /**
   * Accept a post the visitor's own browser read.
   *
   * How Instagram photographs reach a server that holds no Instagram session. The visitor's
   * browser, signed in already, reads the one post it is showing and hands it to the /import
   * page, which sends it here, same-origin. What arrives is untrusted and treated that way:
   * the resolver admits only media on Instagram's CDN and signs what it admitted.
   */
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
      engine.abuse.assertAllowed(request.clientKey);
      const body = importRequestSchema.parse(request.body);

      try {
        const info = engine.resolver.importSubmitted(body, request.id);
        engine.abuse.recordSuccess(request.clientKey);
        return await reply.header('cache-control', 'no-store').send(info);
      } catch (error) {
        // Media named off Instagram's hosts counts: nothing Instagram serves produces that,
        // so it is someone finding out what this endpoint will fetch.
        engine.abuse.recordFailure(
          request.clientKey,
          error instanceof SeraError ? error.code : undefined,
        );
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
