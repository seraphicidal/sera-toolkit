import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, seraError, SeraEngine, SeraError } from '@sera/engine';
import { buildServer } from '../server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolvePath(here, '../../../..');
const nodeEntry = join(repoRoot, 'apps/extractor/dist/index.js');

const TOKEN = 'live-node-token-0123456789abcdef';

let app: FastifyInstance;
let engine: SeraEngine;
let child: ChildProcess | undefined;
let apiDir: string;
let nodeDir: string;
let port: number;

const blocked = () =>
  Promise.reject(seraError('SOURCE_BLOCKED', { detail: "Sign in to confirm you're not a bot" }));

beforeAll(async () => {
  apiDir = await mkdtemp(join(tmpdir(), 'sera-live-api-'));
  nodeDir = await mkdtemp(join(tmpdir(), 'sera-live-node-'));

  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'live-integration-secret',
      SERA_DATA_DIR: apiDir,
      SERA_EXTRACTION_NODE_TOKEN: TOKEN,
      SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '2',
    }),
    probe: blocked,
  });

  app = await buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  child = spawn(process.execPath, [nodeEntry], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      SERA_API_URL: `http://127.0.0.1:${String(port)}`,
      SERA_EXTRACTION_NODE_TOKEN: TOKEN,
      SERA_NODE_ID: 'live-test-node',
      SERA_NODE_PROVIDERS: 'youtube',
      SERA_SECRET: 'live-integration-secret',
      SERA_DATA_DIR: nodeDir,
      LOG_LEVEL: 'silent',
    },
  });
}, 60_000);

afterAll(async () => {
  child?.kill();
  await app?.close();
  await rm(apiDir, { recursive: true, force: true });
  await rm(nodeDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(
  attempt: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== undefined) return value;
    await wait(250);
  }
  return undefined;
}

describe('the shipped extraction node, as a child process', () => {
  it('dials in on its own and is offered as a backend', async () => {
    const status = await until(
      () => engine.extractionNodes.status().find((node) => node.healthy),
      30_000,
    );

    expect(status, 'the node never registered').toBeDefined();
    expect(status!.id).toBe('live-test-node');
    expect(status!.providers).toEqual(['youtube']);
    expect(status!.capacity).toBe(1);
  }, 40_000);

  it('reports itself through /health, where an operator would look', async () => {
    const report = await engine.health();
    const check = report.checks.find((entry) => entry.name === 'extraction-nodes');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('live-test-node');
  });

  it('is refused without the token, from a real socket', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/internal/extraction/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'impostor', providers: [], capacity: 1 }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.' },
    });
  });

  it('refuses an address that is not the provider it was told, even from us', async () => {
    await until(() => engine.extractionNodes.status().find((node) => node.healthy), 30_000);

    const refusals: [string, string][] = [
      ['http://127.0.0.1:1/', 'BLOCKED_ADDRESS'],
      ['https://example.com/watch?v=x', 'UNSUPPORTED_SOURCE'],
    ];

    for (const [url, code] of refusals) {
      const outcome = await engine.extractionNodes
        .dispatch({ kind: 'resolve', url, providerId: 'youtube' })
        .then(
          () => 'resolved' as const,
          (error: unknown) => SeraError.from(error),
        );

      expect(outcome, url).not.toBe('resolved');
      expect((outcome as SeraError).code, url).toBe(code);
    }
  }, 90_000);

  it('takes a task the router hands it and answers over the wire', async () => {
    await until(() => engine.extractionNodes.status().find((n) => n.healthy), 30_000);

    const outcome = await engine.extractionNodes
      .dispatch({
        kind: 'resolve',
        url: 'https://www.youtube.com/watch?v=000000000000000',
        providerId: 'youtube',
      })
      .then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );

    expect(outcome).not.toBe(undefined);
    if (outcome !== 'resolved') {
      expect(outcome).toHaveProperty('code');
    }
  }, 90_000);
});
