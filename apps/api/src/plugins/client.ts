import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { SeraEngine } from '@sera/engine';

declare module 'fastify' {
  interface FastifyRequest {
    clientKey: string;
    clientKeys: readonly [string, string];
    canary: boolean;
  }
}

export function matchesToken(presented: unknown, configured: string): boolean {
  if (!configured || typeof presented !== 'string' || !presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
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

export function normalizeClientAddress(raw: string): string {
  let address = raw.trim();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) {
    address = address.slice(0, zoneIndex);
  }

  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (ipv4Mapped) {
    return ipv4Mapped[1]!;
  }

  if (!address.includes(':')) {
    return address;
  }

  const doubleColon = address.indexOf('::');
  let parts: string[];
  if (doubleColon !== -1) {
    const leftStr = address.slice(0, doubleColon);
    const rightStr = address.slice(doubleColon + 2);
    const left = leftStr ? leftStr.split(':') : [];
    const right = rightStr ? rightStr.split(':') : [];
    const missing = 8 - (left.length + right.length);
    const middle: string[] = [];
    for (let i = 0; i < missing; i += 1) middle.push('0');
    parts = [...left, ...middle, ...right];
  } else {
    parts = address.split(':');
  }

  const last = parts[parts.length - 1] ?? '';
  if (last.includes('.')) {
    const octets = last.split('.').map((o) => parseInt(o, 10));
    if (octets.length === 4 && octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      const hex1 = (((octets[0]! << 8) | octets[1]!) >>> 0).toString(16);
      const hex2 = (((octets[2]! << 8) | octets[3]!) >>> 0).toString(16);
      parts.splice(parts.length - 1, 1, hex1, hex2);
    }
  }

  const first4 = parts.slice(0, 4).map((p) => {
    const num = parseInt(p || '0', 16);
    return isNaN(num) ? '0' : num.toString(16);
  });
  if (
    parts.length === 8 &&
    parts.slice(0, 5).every((p) => parseInt(p || '0', 16) === 0) &&
    parseInt(parts[5] ?? '0', 16) === 0xffff
  ) {
    const w6 = parseInt(parts[6] ?? '0', 16);
    const w7 = parseInt(parts[7] ?? '0', 16);
    if (!Number.isNaN(w6) && !Number.isNaN(w7)) {
      return `${(w6 >>> 8) & 0xff}.${w6 & 0xff}.${(w7 >>> 8) & 0xff}.${w7 & 0xff}`;
    }
  }
  while (first4.length < 4) first4.push('0');
  return `${first4.join(':')}::/64`;
}

export function computeClientKey(
  address: string,
  secret: string | Buffer,
  now = Date.now(),
  rotationIntervalMs = 24 * 60 * 60_000,
): string {
  const epoch = Math.floor(now / rotationIntervalMs);
  return createHmac('sha256', secret)
    .update(`${address}:${epoch}`)
    .digest('base64url')
    .slice(0, 22);
}

export function computeClientKeys(
  address: string,
  secret: string | Buffer,
  now = Date.now(),
  rotationIntervalMs = 24 * 60 * 60_000,
): readonly [string, string] {
  return [
    computeClientKey(address, secret, now, rotationIntervalMs),
    computeClientKey(address, secret, Math.max(0, now - rotationIntervalMs), rotationIntervalMs),
  ];
}

function addressOf(request: FastifyRequest): string {
  return request.ip;
}

export const clientKeyPlugin = fp(function clientKeyPlugin(
  app: FastifyInstance,
  options: { engine: SeraEngine },
  done: (error?: Error) => void,
) {
  const { config } = options.engine;

  app.decorateRequest('clientKey', '');
  app.decorateRequest('clientKeys', undefined as unknown as readonly [string, string]);
  app.decorateRequest('canary', false);
  app.addHook('onRequest', (request, _reply, next) => {
    request.canary = isCanaryToken(request.headers['x-sera-canary'], config.canaryToken);
    const address = normalizeClientAddress(addressOf(request));
    const keys = computeClientKeys(address, config.secret);
    request.clientKey = keys[0];
    request.clientKeys = keys;
    next();
  });

  done();
});
