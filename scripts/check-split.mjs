#!/usr/bin/env node
/**
 * The topology the deployment actually runs: API and worker in separate processes.
 *
 * A node holds one connection to one process. Every other check here runs both halves in
 * one, which is why this failure was invisible until it reached production — twice. The
 * API logged the node connecting and the worker, a container away, logged
 * `fallbackAvailable: false` and failed the download with the datacentre block.
 *
 * So this stands up the real API with the real node dialled into it, then asks the
 * question a *separate* process asks: is there a node, and will it do a job for me. The
 * client under test is the same `RemoteOverHttp` the worker uses.
 *
 *   npm run build && node scripts/check-split.mjs
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = randomUUID().replace(/-/g, '');
const URL_UNDER_TEST = process.argv[2] ?? 'https://youtube.com/shorts/Xz3UMZvhgeY';

const load = (path) => import(pathToFileURL(`${REPO}${path}`).href);
const { SeraEngine, loadConfig, RemoteOverHttp, createLogger } = await load(
  'packages/engine/dist/index.js',
);
const { buildServer } = await load('apps/api/dist/server.js');

const apiDir = await mkdtemp(join(tmpdir(), 'sera-split-api-'));
const nodeDir = await mkdtemp(join(tmpdir(), 'sera-split-node-'));

let pass = 0;
let fail = 0;
const note = (ok, name, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
};

const engine = await SeraEngine.create({
  config: loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'split-secret',
    SERA_DATA_DIR: apiDir,
    SERA_EXTRACTION_NODE_TOKEN: TOKEN,
    SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '5',
  }),
});

const app = await buildServer(engine);
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
const apiUrl = `http://127.0.0.1:${String(port)}`;
console.log(`\n  api on ${apiUrl}\n`);

const child = spawn(process.execPath, [resolve(REPO, 'apps/extractor/dist/index.js')], {
  cwd: REPO,
  stdio: 'ignore',
  env: {
    ...process.env,
    SERA_API_URL: apiUrl,
    SERA_EXTRACTION_NODE_TOKEN: TOKEN,
    SERA_NODE_ID: 'split-check',
    SERA_NODE_PROVIDERS: 'youtube',
    SERA_NODE_NETWORK_CLASS: 'residential',
    SERA_SECRET: 'split-secret',
    SERA_DATA_DIR: nodeDir,
    LOG_LEVEL: 'silent',
  },
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

try {
  // The node dials in, exactly as it would against the deployment.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !engine.extractionNodes.status().some((n) => n.healthy)) {
    await wait(400);
  }
  note(
    engine.extractionNodes.status().some((node) => node.healthy),
    'the node reaches the API',
    engine.extractionNodes.status()[0]?.id ?? '(none)',
  );

  /* ---- and now the part the worker does, from outside that process ---- */
  // Cold, the way a worker container is when its first job arrives: nobody has asked
  // this client anything yet. A cache that only refreshes on being asked answers the
  // first question with "no nodes" — which is the first job after a boot, and the first
  // job after a node connects to a worker that has been idle.
  const asWorker = new RemoteOverHttp(apiUrl, TOKEN, createLogger({ level: 'silent' }), 2000, 500);
  await wait(1000);

  note(asWorker.hasHealthyNode(), 'a cold separate process sees the node', 'this is what broke');
  note(
    asWorker.availableProviders().includes('youtube'),
    'and knows what it will take',
    asWorker.availableProviders().join(',') || '(nothing)',
  );
  note(
    asWorker.networkClasses().includes('residential'),
    'and on which kind of connection',
    asWorker.networkClasses().join(',') || '(none)',
  );

  const resolved = await asWorker
    .dispatch({ kind: 'resolve', url: URL_UNDER_TEST, providerId: 'youtube' })
    .catch((error) => ({ error }));
  note(
    !resolved.error && resolved.items?.length > 0,
    'it can have the node resolve a link',
    resolved.error
      ? String(resolved.error.message).slice(0, 60)
      : (resolved.title ?? '').slice(0, 45),
  );

  if (!resolved.error) {
    const planKey = `${resolved.items[0].plans[0].kind}/${resolved.items[0].plans[0].container}/${resolved.items[0].plans[0].label}`;
    const files = await asWorker
      .dispatchJob(
        { kind: 'job', url: resolved.url, providerId: 'youtube', planKeys: [planKey] },
        { onProgress: () => undefined },
      )
      .catch((error) => ({ error }));

    if (files.error) {
      note(false, 'and have it do the whole job', String(files.error.message).slice(0, 60));
    } else {
      const info = await stat(files[0].path).catch(() => undefined);
      note(
        Boolean(info?.size),
        'and have it do the whole job',
        `${files[0].name} · ${info?.size ?? 0} bytes on the shared volume`,
      );
    }
  }
} finally {
  child.kill();
  await app.close();
  await rm(apiDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(nodeDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
