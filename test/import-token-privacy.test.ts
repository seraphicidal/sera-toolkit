import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';

/**
 * The resolution token carries signed Instagram CDN URLs, so it is a secret the way a media
 * URL is: usable by anyone holding it until it expires. It is only ever meant to travel in a
 * POST body. This checks the failure paths — an oversized or malformed `infoId` — never spill it
 * into a response a client sees or a line the server logs. The logger here has no redaction on
 * purpose: the claim is that nothing emits the token at all, not that redaction catches it.
 */

let engine: SeraEngine;
let app: FastifyInstance;
let dataDir: string;
const logged: string[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-tok-'));
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logged.push(chunk.toString());
      done();
    },
  });

  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      SERA_SECRET: 'token-privacy-secret',
      SERA_DATA_DIR: dataDir,
      SERA_RATE_LIMIT_JOBS_PER_MINUTE: '1000',
    }),
    logger: pino({ level: 'trace' }, sink),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

/** Every byte the server sent back or wrote down while handling one request. */
async function everythingEmittedFor(infoId: string): Promise<{ status: number; seen: string }> {
  logged.length = 0;
  const response = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { infoId, optionIds: ['anything'] },
  });
  const seen = [response.body, JSON.stringify(response.headers), logged.join('')].join('\n');
  return { status: response.statusCode, seen };
}

describe('a resolution token never leaks on the way out', () => {
  it('does not echo an oversized infoId into the response or the log', async () => {
    // Over MAX_INFO_TOKEN_LENGTH (40 KB) but under the 64 KB body limit, so it reaches the
    // schema and is refused there rather than by the transport.
    const token = `oversized.${'Z'.repeat(45_000)}`;
    const { status, seen } = await everythingEmittedFor(token);

    expect(status).toBe(400);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain('ZZZZZZZZ');
    // What a client is told is the size rule, not the value.
    expect(JSON.parse(seen.split('\n')[0]!).error.message).toMatch(/40000|40,000|at most/);
  });

  it('does not echo a malformed infoId, which carries CDN URLs, into the response or the log', async () => {
    // Well-formed length, wrong signature: it reaches verification and is refused as expired.
    // Shaped like a real import token so that, if anything logged its contents, the CDN host
    // inside would show up in the assertion below.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        u: 'https://www.instagram.com/p/DcOX3hWFiey/',
        p: 'instagram',
        o: 'visitor',
        m: [
          {
            s: '1',
            kind: 'image',
            url: 'https://scontent.cdninstagram.com/v/t51/LEAK-IF-LOGGED.jpg?oe=FFFFFFFF',
            container: 'jpg',
          },
        ],
        t: 'A post',
        e: 9_999_999_999,
      }),
      'utf8',
    ).toString('base64url');
    const token = `${forgedPayload}.deadbeefdeadbeefdeadbeefdeadbeef`;

    const { status, seen } = await everythingEmittedFor(token);

    expect(status).toBe(410);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain(forgedPayload);
    // The tell-tale from inside the signed payload, had anything decoded and logged it.
    expect(seen).not.toContain('LEAK-IF-LOGGED');
    expect(seen).not.toContain('cdninstagram.com');
    // The client is told it expired, in fixed words.
    expect(JSON.parse(seen.split('\n')[0]!).error.code).toBe('EXPIRED');
  });
});
