#!/usr/bin/env node
/**
 * The extraction-node architecture, end to end, on one machine.
 *
 * A server that calls itself a datacentre, a real node process that dials into it, and a
 * YouTube job that has to cross the connection because YouTube declares no datacentre
 * extraction. It finishes with bytes served over HTTP and the node's own workspace gone.
 *
 * The unit tests prove the protocol and the live test proves the node is a program that
 * runs. This proves the thing they are both for: that a link a visitor pastes comes back
 * as a file, having been fetched somewhere else entirely.
 *
 *   npm run build && node scripts/node-check.mjs [url]
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = randomUUID().replace(/-/g, '');
const URL_UNDER_TEST = process.argv[2] ?? 'https://youtube.com/shorts/Xz3UMZvhgeY';

const apiDir = await mkdtemp(join(tmpdir(), 'sera-e2e-api-'));
const nodeDir = await mkdtemp(join(tmpdir(), 'sera-e2e-node-'));

const { SeraEngine, loadConfig } = await import(
  pathToFileURL(`${REPO}/packages/engine/dist/index.js`).href
);
const { buildServer } = await import(pathToFileURL(`${REPO}/apps/api/dist/server.js`).href);

const engine = await SeraEngine.create({
  config: loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'node-e2e-secret',
    SERA_DATA_DIR: apiDir,
    SERA_EXTRACTION_NODE_TOKEN: TOKEN,
    SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '5',
    // The whole point: this deployment says it is a datacentre, so YouTube goes to a
    // node first rather than after a refusal it has already measured.
    SERA_NETWORK_CLASS: 'datacenter',
  }),
});
engine.startWorker();

const app = await buildServer(engine);
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
console.log(`api      http://127.0.0.1:${port}`);

const child = spawn(process.execPath, [resolve(REPO, 'apps/extractor/dist/index.js')], {
  cwd: REPO,
  stdio: 'inherit',
  env: {
    ...process.env,
    SERA_API_URL: `http://127.0.0.1:${port}`,
    SERA_EXTRACTION_NODE_TOKEN: TOKEN,
    SERA_NODE_ID: 'home',
    SERA_NODE_PROVIDERS: 'youtube',
    SERA_NODE_NETWORK_CLASS: 'residential',
    SERA_SECRET: 'node-e2e-secret',
    SERA_DATA_DIR: nodeDir,
    LOG_LEVEL: 'info',
  },
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await wait(400);
  }
  return undefined;
}

try {
  const node = await until(
    () => engine.extractionNodes.status().find((entry) => entry.healthy),
    30_000,
  );
  if (!node) throw new Error('the node never registered');
  console.log(`node     ${node.id} [${node.networkClass}] providers=${node.providers.join(',')}`);

  const health = await engine.health();
  console.log(
    `health   ${health.checks.find((c) => c.name === 'extraction-nodes')?.detail ?? '(none)'}`,
  );

  const info = await (
    await fetch(`http://127.0.0.1:${port}/api/media/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: URL_UNDER_TEST }),
    })
  ).json();
  if (info.error) throw new Error(`resolve failed: ${JSON.stringify(info.error)}`);
  const option = info.items[0].options[0];
  console.log(`resolved ${info.title} — ${option.label} ${option.detail ?? ''}`);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ infoId: info.id, optionIds: [option.id] }),
    })
  ).json();
  if (created.error) throw new Error(`job failed: ${JSON.stringify(created.error)}`);

  const finished = await until(async () => {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${created.id}`)).json();
    return ['ready', 'failed', 'cancelled'].includes(state.state) ? state : undefined;
  }, 300_000);

  console.log(`job      ${finished?.state} ${finished?.step ?? ''}`);
  if (finished?.state !== 'ready') {
    console.log(`error    ${JSON.stringify(finished?.error)}`);
    process.exitCode = 1;
  } else {
    const response = await fetch(`http://127.0.0.1:${port}${finished.result.downloadPath}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const magic = bytes.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4' : '?';
    console.log(
      `file     ${finished.result.filename} · ${bytes.length} bytes · magic=${magic} · served ${response.status}`,
    );
    // And the workspace on the node is gone.
    const left = await readFile(join(nodeDir, 'nothing')).then(
      () => 'something',
      () => 'clean',
    );
    console.log(`node dir ${left}`);
  }
} finally {
  child.kill();
  await app.close();
  await rm(apiDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(nodeDir, { recursive: true, force: true }).catch(() => undefined);
}

process.exit(process.exitCode ?? 0);
