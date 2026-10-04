import { createHmac, timingSafeEqual } from 'node:crypto';
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
    /**
     * The server's own canary (deploy/canary.sh), proven by `x-sera-canary`. Exempt from
     * rate limits and abuse strikes, and left out of usage counts: it is the deployment
     * checking itself, not a visitor.
     */
    canary: boolean;
  }
}

/** Whether a presented canary token is the configured one, in constant time. */
export function isCanaryToken(presented: unknown, configured: string): boolean {
  if (!configured || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The abuse guard as a route should use it: the canary never earns a strike or a
 * cooldown, so a source that is genuinely down cannot lock the canary out of noticing
 * when it comes back.
 */
export function abuseGuardFor(engine: SeraEngine, request: FastifyRequest) {
  const { abuse } = engine;
  const key = request.clientKey;
  if (request.canary) {
    return {
      assertAllowed: () => undefined,
      recordSuccess: () => undefined,
      recordFailure: () => undefined,
    };
  }
  return {
    assertAllowed: () => abuse.assertAllowed(key),
    recordSuccess: () => abuse.recordSuccess(key),
    recordFailure: (code?: Parameters<typeof abuse.recordFailure>[1]) =>
      abuse.recordFailure(key, code),
  };
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
  app.decorateRequest('canary', false);
  app.addHook('onRequest', (request, _reply, next) => {
    request.canary = isCanaryToken(request.headers['x-sera-canary'], config.canaryToken);
    const address = addressOf(request, config.trustProxy);
    request.clientKey = createHmac('sha256', config.secret)
      .update(address)
      .digest('base64url')
      .slice(0, 22);
    next();
  });

  done();
});
