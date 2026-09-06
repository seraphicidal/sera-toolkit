import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SeraError } from '../errors.js';
import { newJobId, signToken, verifyToken } from './tokens.js';

const secret = randomBytes(32);
const other = randomBytes(32);

interface Payload {
  u: string;
  p: string;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return error instanceof SeraError ? error.code : 'THREW';
  }
}

describe('signToken / verifyToken', () => {
  it('round-trips a payload', () => {
    const token = signToken<Payload>({ u: 'https://e.com/x', p: 'youtube' }, secret, 3600);
    const payload = verifyToken<Payload>(token, secret);
    expect(payload.u).toBe('https://e.com/x');
    expect(payload.p).toBe('youtube');
    expect(typeof payload.e).toBe('number');
  });

  it('refuses a token signed with a different secret', () => {
    const token = signToken<Payload>({ u: 'x', p: 'y' }, other, 3600);
    expect(codeOf(() => verifyToken(token, secret))).toBe('EXPIRED');
  });

  it('refuses a token whose payload was edited', () => {
    // The whole point: a client must not be able to redirect the pipeline at a URL the
    // resolver never approved.
    const token = signToken<Payload>({ u: 'https://good.example/x', p: 'youtube' }, secret, 3600);
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ u: 'http://169.254.169.254/', p: 'youtube', e: 9999999999 }),
      'utf8',
    ).toString('base64url');

    expect(codeOf(() => verifyToken(`${forged}.${signature!}`, secret))).toBe('EXPIRED');
    expect(codeOf(() => verifyToken(`${body!}.${signature!.slice(0, -2)}AA`, secret))).toBe(
      'EXPIRED',
    );
  });

  it('refuses a token past its expiry', () => {
    const token = signToken<Payload>({ u: 'x', p: 'y' }, secret, 60, Date.now());
    expect(codeOf(() => verifyToken(token, secret, Date.now() + 61_000))).toBe('EXPIRED');
    expect(codeOf(() => verifyToken(token, secret, Date.now() + 59_000))).toBe('OK');
  });

  it('refuses malformed input without throwing something unexpected', () => {
    for (const value of ['', '.', 'abc', 'abc.', '.abc', 'not-a-token', 'a.b.c']) {
      expect(
        codeOf(() => verifyToken(value, secret)),
        value,
      ).toBe('EXPIRED');
    }
  });

  it('does not parse the payload of an unsigned token', () => {
    // Signature first, so hostile JSON never reaches JSON.parse.
    const body = Buffer.from('{"u":', 'utf8').toString('base64url');
    expect(codeOf(() => verifyToken(`${body}.AAAA`, secret))).toBe('EXPIRED');
  });
});

describe('newJobId', () => {
  it('produces unguessable lowercase hex ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newJobId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/);
  });
});
