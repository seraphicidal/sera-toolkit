import { Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { loadConfig, SeraEngine } from '@sera/engine';
import { buildServer } from './server.js';

/**
 * What the server writes about a request.
 *
 * Fastify logs every request it serves, URL included, unless told not to — and a URL here
 * can carry the link someone is downloading. Its own lines are switched off and replaced by
 * one that names the route, not the path. This watches the log at its most verbose level.
 */

const lines: Record<string, unknown>[] = [];
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-server-log-'));
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  const engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'trace',
      SERA_SECRET: 'server-log-secret',
      SERA_DATA_DIR: dataDir,
    }),
    logger: pino({ level: 'trace' }, sink),
  });
  app = await buildServer(engine);
});

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('request logging', () => {
  it("writes the route, never the path or query, and none of Fastify's own request lines", async () => {
    const marker = 'https%3A%2F%2Fprivate.example%2Fwatch%3Fv%3Dsecret';
    const response = await app.inject({ method: 'GET', url: `/api/info?u=${marker}` });
    expect(response.statusCode).toBe(200);

    const text = JSON.stringify(lines);
    expect(text).not.toContain('private.example');
    expect(text).not.toContain(marker);
    expect(lines.some((line) => line.msg === 'incoming request')).toBe(false);
    expect(lines.some((line) => line.msg === 'request completed')).toBe(false);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'request', route: '/api/info', method: 'GET', status: 200 }),
    );
  });
});
