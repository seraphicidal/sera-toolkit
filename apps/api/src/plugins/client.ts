import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { SeraEngine } from '@sera/engine';

/**
 * Derives a stable, non-reversible key for one client.
 *
 * Rate limiting and per-client concurrency both need to tell callers apart, and the
 * obvious way to do that is to key on the IP address. Storing addresses would make the
 * service's logs a record of who downloaded what, so the address is HMAC'd with the
 * server secret and only the digest is kept. It is stable for as long as the process
 * runs and meaningless outside it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Opaque per-client identifier. Safe to log. */
    clientKey: string;
  }
}

function addressOf(request: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = first?.split(',')[0]?.trim();
    if (candidate) return candidate;
  }
  return request.ip;
}

export const clientKeyPlugin = fp(function clientKeyPlugin(
  app: FastifyInstance,
  options: { engine: SeraEngine },
  done: (error?: Error) => void,
) {
  const { config } = options.engine;

  app.decorateRequest('clientKey', '');
  app.addHook('onRequest', (request, _reply, next) => {
    const address = addressOf(request, config.trustProxy);
    request.clientKey = createHmac('sha256', config.secret)
      .update(address)
      .digest('base64url')
      .slice(0, 22);
    next();
  });

  done();
});
