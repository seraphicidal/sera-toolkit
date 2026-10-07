import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { seraError } from '../errors.js';

const SEPARATOR = '.';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(secret: Buffer, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export interface SignedPayload {
  readonly e: number;
}

export function signToken<T extends object>(
  payload: T,
  secret: Buffer,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const body: T & SignedPayload = {
    ...payload,
    e: Math.floor(now / 1000) + ttlSeconds,
  };
  const encoded = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${encoded}${SEPARATOR}${b64url(hmac(secret, encoded))}`;
}

export function readToken<T extends object>(token: string, secret: Buffer): T & SignedPayload {
  const index = token.indexOf(SEPARATOR);
  if (index <= 0 || index === token.length - 1) {
    throw seraError('EXPIRED', { detail: 'malformed token' });
  }
  const encoded = token.slice(0, index);
  const provided = Buffer.from(token.slice(index + 1), 'base64url');
  const expected = hmac(secret, encoded);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw seraError('EXPIRED', { detail: 'bad token signature' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (cause) {
    throw seraError('EXPIRED', { detail: 'unparseable token payload', cause });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw seraError('EXPIRED', { detail: 'non-object token payload' });
  }

  const payload = parsed as T & SignedPayload;
  if (typeof payload.e !== 'number') {
    throw seraError('EXPIRED', { detail: 'token past its expiry' });
  }
  return payload;
}

export function verifyToken<T extends object>(
  token: string,
  secret: Buffer,
  now = Date.now(),
): T & SignedPayload {
  const payload = readToken<T>(token, secret);
  if (payload.e * 1000 < now) {
    throw seraError('EXPIRED', { detail: 'token past its expiry' });
  }
  return payload;
}

export function newJobId(): string {
  return randomUUID().replace(/-/g, '');
}
