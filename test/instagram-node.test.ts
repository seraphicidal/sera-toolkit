import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MediaInfo, ServiceInfo } from '@sera/contracts/types';
import { loadConfig, seraError, SeraEngine, type ResolvedMedia } from '@sera/engine';
import { buildServer } from '../apps/api/src/server.js';
import { nodeFeatures, nodeProviders } from '../apps/extractor/src/node.js';

const TOKEN = 'instagram-node-token-0123456789';
const POST = 'https://www.instagram.com/p/DcOX3hWFiey/';

const slide = (index: number) => ({
  index,
  kind: 'image' as const,
  title: `Slide ${String(index + 1)}`,
  width: 1440,
  height: 1800,
  plans: [
    {
      kind: 'image' as const,
      container: 'jpg' as const,
      label: 'Original',
      width: 1440,
      height: 1800,
      requiresConversion: false,
      recommended: true,
      fetch: {
        via: 'direct' as const,
        url: `https://scontent-vie1-1.cdninstagram.com/v/t51/${String(index)}.jpg`,
      },
    },
  ],
});

const carousel: ResolvedMedia = {
  provider: 'instagram',
  providerLabel: 'Instagram',
  url: POST,
  type: 'collection',
  title: 'Two photos',
  author: 'someone',
  items: [slide(0), slide(1)],
};

let app: FastifyInstance;
let engine: SeraEngine;
let dataDir: string;
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-instagram-node-'));
  engine = await SeraEngine.create({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERA_SECRET: 'instagram-node-secret',
      SERA_DATA_DIR: dataDir,
      SERA_EXTRACTION_NODE_TOKEN: TOKEN,
      SERA_EXTRACTION_CLAIM_HOLD_SECONDS: '1',
    }),
    probe: () =>
      Promise.reject(seraError('UNSUPPORTED_SOURCE', { detail: 'There is no video in this post' })),
  });
  app = await buildServer(engine);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

const claim = (nodeId: string, features: readonly string[]) =>
  app.inject({
    method: 'POST',
    url: '/internal/extraction/claim',
    headers: auth,
    payload: { nodeId, providers: ['youtube', 'instagram'], capacity: 1, features },
  });

const instagramInfo = async () =>
  (await app.inject({ method: 'GET', url: '/api/info' }))
    .json<ServiceInfo>()
    .providers.find((provider) => provider.id === 'instagram')!;

describe('without a node holding a session', () => {
  it('says in /api/info that photo posts need an account', async () => {
    const info = await instagramInfo();
    expect(info.capabilities?.image).toBe(false);
    expect(info.capabilities?.authRequiredFor).toEqual(['photo posts', 'carousels']);
  });
});

describe('with one', () => {
  it('reads the post there, and only a node that declared the session is asked', async () => {
    engine.extractionNodes.register('laptop', ['youtube', 'instagram'], 1, 'residential', [
      'trim',
      'subtitles',
    ]);
    engine.extractionNodes.register('phone', ['youtube', 'instagram'], 1, 'residential', [
      'trim',
      'subtitles',
      'instagram-session',
    ]);

    const info = await instagramInfo();
    expect(info.capabilities?.image).toBe(true);
    expect(info.capabilities?.carousel).toBe(true);
    expect(info.capabilities?.authRequiredFor).toBeUndefined();

    const visitor = app.inject({ method: 'POST', url: '/api/media/info', payload: { url: POST } });

    expect((await claim('laptop', ['trim', 'subtitles'])).statusCode).toBe(204);

    let task: { id: string; providerId: string; requires?: string[] } | undefined;
    for (let attempt = 0; attempt < 8 && !task; attempt += 1) {
      const response = await claim('phone', ['trim', 'subtitles', 'instagram-session']);
      if (response.statusCode === 200) task = response.json();
    }
    expect(task, 'the phone was never handed the post').toBeDefined();
    expect(task!.providerId).toBe('instagram');
    expect(task!.requires).toEqual(['instagram-session']);
    expect(JSON.stringify(task)).not.toMatch(/session.?id/i);

    await app.inject({
      method: 'POST',
      url: `/internal/extraction/${task!.id}/resolved`,
      headers: auth,
      payload: { media: carousel },
    });

    const answered = await visitor;
    expect(answered.statusCode, answered.body).toBe(200);
    const media = answered.json<MediaInfo>();
    expect(media.items).toHaveLength(2);
    expect(media.items.every((item) => item.width === 1440)).toBe(true);
  });
});

describe('a node', () => {
  it('declares the session, and takes Instagram, only when its operator gave it one', () => {
    const without = { instagram: { configured: false } } as Parameters<typeof nodeFeatures>[0];
    const withSession = { instagram: { configured: true } } as Parameters<typeof nodeFeatures>[0];

    expect(nodeFeatures(without)).toEqual(['trim', 'subtitles']);
    expect(nodeFeatures(withSession)).toEqual(['trim', 'subtitles', 'instagram-session']);

    expect(nodeProviders(['youtube'], without)).toEqual(['youtube']);
    expect(nodeProviders(['youtube'], withSession)).toEqual(['youtube', 'instagram']);
    expect(nodeProviders([], withSession)).toEqual([]);
  });
});
