import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { SeraEngine } from '@sera/engine';

declare module 'fastify' {
  interface FastifyRequest {
    clientKey: string;
    canary: boolean;
  }
}

export function matchesToken(presented: unknown, configured: string): boolean {
  if (!configured || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isCanaryToken(presented: unknown, configured: string): boolean {
  return matchesToken(presented, configured);
}

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
