import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';

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
    const token = `oversized.${'Z'.repeat(45_000)}`;
    const { status, seen } = await everythingEmittedFor(token);

    expect(status).toBe(400);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain('ZZZZZZZZ');
    expect(JSON.parse(seen.split('\n')[0]!).error.message).toMatch(/40000|40,000|at most/);
  });

  it('does not echo a malformed infoId, which carries CDN URLs, into the response or the log', async () => {
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
    expect(seen).not.toContain('LEAK-IF-LOGGED');
    expect(seen).not.toContain('cdninstagram.com');
    expect(JSON.parse(seen.split('\n')[0]!).error.code).toBe('EXPIRED');
  });
});
