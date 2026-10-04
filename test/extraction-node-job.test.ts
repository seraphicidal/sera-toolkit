import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job, MediaInfo } from '@sera/contracts/types';
import {
  JobRunner,
  loadConfig,
  MediaResolver,
  ProviderRegistry,
  seraError,
  SeraEngine,
  silentLogger,
  WorkspaceManager,
  type ResolvedMedia,
} from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { ExtractionNode } from '../apps/extractor/src/node.js';
import { ensureFixtures, ffmpegPath, ffprobePath } from './helpers/fixtures.js';
import { MediaServer } from './helpers/media-server.js';

/**
 * A multi-file job, the whole way through a node.
 *
 * The protocol test talks to the routes by hand and the live test runs the built node, but
 * neither sends a job with more than one file — and that is the shape that broke: the node
 * zipped its own output, uploaded the ZIP and every loose file, and the server zipped all of
 * it again. Here the node is the real `ExtractionNode` with the real runner, over a real
 * socket. Only its resolution is fixed, to a two-video playlist served from loopback, so the
 * downloads happen without the internet.
 */

const TOKEN = 'node-job-token-0123456789abcdef';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLsera0000000000000000000000000000';

let origin: MediaServer;
let app: FastifyInstance;
let engine: SeraEngine;
let node: ExtractionNode;
let running: Promise<void>;
let apiDir: string;
let nodeDir: string;

/** What the node's own network makes of the playlist: two videos, one file each. */
function playlist(): ResolvedMedia {
  const video = (index: number, path: string) => ({
    index,
    kind: 'video' as const,
    title: `Part ${String(index + 1)}`,
    plans: [
      {
        kind: 'video' as const,
        container: 'mp4' as const,
        label: 'Original',
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct' as const, url: origin.url(path) },
      },
    ],
  });
  return {
    provider: 'youtube',
    providerLabel: 'YouTube',
    url: PLAYLIST,
    type: 'playlist',
    title: 'Two parts',
    items: [video(0, '/one.mp4'), video(1, '/two.mp4')],
  };
}

beforeAll(async () => {
  const fixtures = await ensureFixtures();
  apiDir = await mkdtemp(join(tmpdir(), 'sera-node-job-api-'));
  nodeDir = await mkdtemp(join(tmpdir(), 'sera-node-job-node-'));

  origin = new MediaServer({
    '/one.mp4': { file: fixtures.video, contentType: 'video/mp4' },
    '/two.mp4': { file: fixtures.video, contentType: 'video/mp4' },
  });
  await origin.start();

  const tools = { SERA_FFMPEG_PATH: ffmpegPath, SERA_FFPROBE_PATH: ffprobePath };

  // The server: every extraction of its own is refused the way a datacentre is, which is
  // the only condition under which it hands a job to a node.
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'node-job-secret',
      SERA_DATA_DIR: apiDir,
      SERA_EXTRACTION_NODE_TOKEN: TOKEN,
      SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
      ...tools,
    }),
    probe: () =>
      Promise.reject(
        seraError('SOURCE_BLOCKED', { detail: "Sign in to confirm you're not a bot" }),
      ),
  });
  app = await buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  engine.startWorker(1);
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  // The node, assembled the way its entry point assembles it.
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_DATA_DIR: nodeDir,
    // The origin is on loopback, which the address guard blocks by design.
    SERA_ALLOW_PRIVATE_ADDRESSES: 'true',
    ...tools,
  });
  const logger = silentLogger();
  const registry = new ProviderRegistry(undefined, config);
  const resolver = new MediaResolver({ config, logger, registry });
  vi.spyOn(resolver, 'resolveCanonical').mockImplementation(() => Promise.resolve(playlist()));
  const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
  const runner = new JobRunner({ config, logger, resolver, workspaces });

  node = new ExtractionNode(
    {
      apiUrl: `http://127.0.0.1:${String(port)}`,
      token: TOKEN,
      nodeId: 'job-test-node',
      networkClass: 'residential',
      providers: ['youtube'],
    },
    logger,
    config,
    registry,
    resolver,
    runner,
    workspaces,
  );
  running = node.run();
});

afterAll(async () => {
  // The node first: its claim is held open by the server, and a server closing under a
  // held claim waits for it. Stopped, the node finishes the claim it has and exits.
  node?.stop();
  await running?.catch(() => undefined);
  await app?.close();
  await engine?.close();
  await origin?.stop();
  await rm(apiDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(nodeDir, { recursive: true, force: true }).catch(() => undefined);
});

/** Reads the entry names out of a ZIP's central directory. */
function entryNames(buffer: Buffer): string[] {
  const names: string[] = [];
  // Central directory headers start with PK\x01\x02; the name follows a 46-byte header.
  for (let i = 0; i < buffer.length - 46; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(i + 28);
    names.push(buffer.subarray(i + 46, i + 46 + nameLength).toString('utf8'));
  }
  return names;
}

async function waitForNode(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!engine.extractionNodes.status().some((entry) => entry.healthy)) {
    if (Date.now() > deadline) throw new Error('the node never registered');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runJob(payload: Record<string, unknown>): Promise<Job> {
  const created = await app.inject({ method: 'POST', url: '/api/jobs', payload });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<Job>();

  const deadline = Date.now() + 90_000;
  for (;;) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<Job>();
    if (['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('a multi-file job on an extraction node', () => {
  it('comes back as one flat archive, packaged once, by the server', async () => {
    await waitForNode();

    const resolved = await app.inject({
      method: 'POST',
      url: '/api/media/info',
      payload: { url: PLAYLIST },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const info = resolved.json<MediaInfo>();
    expect(info.items).toHaveLength(2);

    const optionIds = info.items.map((item) => item.options[0]!.id);
    const job = await runJob({ infoId: info.id, optionIds });
    expect(job.state, JSON.stringify(job.error)).toBe('ready');

    // The listing is the two videos — no archive among the files.
    const result = job.result!;
    expect(result.isArchive).toBe(true);
    expect(result.files?.map((file) => file.name)).toHaveLength(2);
    expect(result.files?.every((file) => file.name.endsWith('.mp4'))).toBe(true);

    // And the archive holds exactly those two, not a ZIP inside a ZIP.
    const download = await app.inject({ method: 'GET', url: result.downloadPath });
    expect(download.statusCode).toBe(200);
    const names = entryNames(download.rawPayload);
    expect(names.sort()).toEqual(result.files!.map((file) => file.name).sort());
    expect(names.some((name) => name.endsWith('.zip'))).toBe(false);
  });
});
