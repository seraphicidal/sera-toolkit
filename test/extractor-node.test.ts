import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JobRunner,
  loadConfig,
  MediaResolver,
  ProviderRegistry,
  silentLogger,
  WorkspaceManager,
} from '@sera/engine';
import { ExtractionNode } from '../apps/extractor/src/node.js';

function createNode(): ExtractionNode {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'test-secret',
  });
  const logger = silentLogger();
  const registry = new ProviderRegistry();
  const resolver = new MediaResolver({ config, logger, registry });
  const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
  const runner = new JobRunner({ config, logger, resolver, workspaces });
  return new ExtractionNode(
    {
      apiUrl: 'http://127.0.0.1:4000',
      token: 'node-token',
      nodeId: 'pc-test',
      networkClass: 'residential',
      providers: ['*'],
    },
    logger,
    config,
    registry,
    resolver,
    runner,
    workspaces,
  );
}

describe('ExtractionNode.upload', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (dirs.length) {
      await rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('does not retry non-retryable 4xx responses or accepted=false payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-node-upload-'));
    dirs.push(dir);
    const filePath = join(dir, 'clip.mp4');
    await writeFile(filePath, Buffer.from('0123456789'));

    const node = createNode() as unknown as {
      upload(
        taskId: string,
        name: string,
        mimeType: string,
        path: string,
        abort: AbortController,
      ): Promise<void>;
    };

    const fetch413 = vi.fn(async () => new Response('too large', { status: 413 }));
    vi.stubGlobal('fetch', fetch413);
    await expect(
      node.upload('task-1', 'clip.mp4', 'video/mp4', filePath, new AbortController()),
    ).rejects.toThrow(/returned 413/);
    expect(fetch413).toHaveBeenCalledTimes(1);

    const fetchRejected = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchRejected);
    await expect(
      node.upload('task-1', 'clip.mp4', 'video/mp4', filePath, new AbortController()),
    ).rejects.toThrow(/did not accept/);
    expect(fetchRejected).toHaveBeenCalledTimes(1);
  });

  it('uses body416.receivedBytes when x-sera-received-bytes is missing and preserves it without clobbering via HEAD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sera-node-416-'));
    dirs.push(dir);
    const filePath = join(dir, 'clip.mp4');
    await writeFile(filePath, Buffer.from('0123456789'));

    const node = createNode() as unknown as {
      upload(
        taskId: string,
        name: string,
        mimeType: string,
        path: string,
        abort: AbortController,
      ): Promise<void>;
    };

    const calls: { method: string; url: string; contentRange: string | null }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({ method, url, contentRange: headers.get('content-range') });

      if (calls.length === 1) {
        return new Response(JSON.stringify({ receivedBytes: 4 }), {
          status: 416,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accepted: true, sizeBytes: 10 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await node.upload('task-2', 'clip.mp4', 'video/mp4', filePath, new AbortController());
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(calls[1]?.url).toContain('offset=4');
    expect(calls[1]?.contentRange).toBe('bytes 4-9/10');
  });
});
