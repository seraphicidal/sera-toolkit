import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, seraError, SeraEngine } from '@sera/engine';
import { buildServer } from '../server.js';

/**
 * The whole fallback, with the real node binary as a real child process.
 *
 * The in-process test beside this one proves the protocol. This proves the shipped
 * program: it spawns `apps/extractor/dist/index.js` the way an operator would, over a
 * real socket, against a real server whose own extraction is refused.
 *
 * It spawns `process.execPath` with a script path rather than a shell wrapper, which is
 * the fix for the `.cmd` shim that could not be spawned on Windows at all (`EINVAL`).
 * That failed for a reason worth keeping in mind: a spawn error is an extractor bug, not
 * a network one, so the router correctly declined to fall back and the fake never
 * exercised the path it was written for. The forcing function here is an injected probe
 * — the failure is produced where extraction actually happens, not by breaking the
 * process that runs it.
 */

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

/** The refusal a datacentre gets, produced where extraction happens. */
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
    // Not app.inject: a real connection, the way anything on the internet would arrive.
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

  it('takes a task the router hands it and answers over the wire', async () => {
    await until(() => engine.extractionNodes.status().find((n) => n.healthy), 30_000);

    // The node's own extraction is the real thing; only the server's is refused. So the
    // task it takes is answered by whatever its network can actually do, and for a URL
    // no network can resolve that is a failure — which is the point: the failure comes
    // back classified, over the real protocol, rather than the request hanging.
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
    // Either the node resolved it or it reported why. What must not happen is silence.
    if (outcome !== 'resolved') {
      expect(outcome).toHaveProperty('code');
    }
  }, 90_000);
});
