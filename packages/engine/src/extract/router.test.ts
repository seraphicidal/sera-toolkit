import type { ProviderCapabilities } from '@sera/contracts/types';
import { describe, expect, it } from 'vitest';
import { seraError, SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import { declare } from '../providers/capabilities.js';
import type { ResolvedMedia } from '../providers/types.js';
import { ExtractionRouter, type ExtractionBackend, type NetworkClass } from './router.js';

const media: ResolvedMedia = {
  provider: 'youtube',
  providerLabel: 'YouTube',
  url: 'https://www.youtube.com/watch?v=x',
  type: 'single',
  title: 'A video',
  items: [
    {
      index: 0,
      kind: 'video',
      plans: [
        {
          kind: 'video',
          container: 'mp4',
          label: '1080p',
          requiresConversion: false,
          recommended: true,
          fetch: { via: 'ytdlp', selector: 'best' },
        },
      ],
    },
  ],
};

function backend(
  id: string,
  behaviour: {
    healthy?: boolean;
    providers?: string[];
    result?: 'ok' | SeraError;
    networkClass?: NetworkClass;
  },
): ExtractionBackend & { calls: number } {
  const local = id === 'oracle';
  const impl = {
    id,
    kind: local ? ('local' as const) : ('remote' as const),
    networkClass: behaviour.networkClass ?? (local ? 'datacenter' : 'residential'),
    providers: behaviour.providers ?? [],
    calls: 0,
    isHealthy: () => behaviour.healthy !== false,
    resolve: () => {
      impl.calls += 1;
      if (behaviour.result === 'ok' || behaviour.result === undefined)
        return Promise.resolve(media);
      return Promise.reject(behaviour.result);
    },
  };
  return impl;
}

const caps =
  (differences: Partial<ProviderCapabilities> = {}) =>
  () =>
    declare(differences);

const url = new URL('https://www.youtube.com/watch?v=x');

describe('ExtractionRouter', () => {
  it('uses the primary and stops there when it works', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps(),
    });

    const outcome = await router.resolve(url, 'youtube');
    expect(outcome.backend).toBe('oracle');
    expect(outcome.fallbackUsed).toBe(false);
    expect(home.calls).toBe(0);
  });

  it('falls back when the network is the problem', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps(),
    });

    const outcome = await router.resolve(url, 'youtube');
    expect(outcome.backend).toBe('residential');
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.firstFailure).toBe('DATACENTER_BLOCKED');
  });

  it('does not fall back for an answer that is the same everywhere', async () => {
    for (const code of ['PRIVATE_CONTENT', 'MEDIA_UNAVAILABLE', 'UNSUPPORTED_SOURCE'] as const) {
      const primary = backend('oracle', { result: seraError(code) });
      const home = backend('residential', { result: 'ok' });
      const router = new ExtractionRouter({
        primary,
        logger: silentLogger(),
        fallbacks: () => [home],
        capabilitiesOf: caps(),
      });

      const error = await router.resolve(url, 'youtube').then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );
      expect(error?.code, code).toBe(code);
      expect(home.calls, code).toBe(0);
    }
  });

  it('skips a backend that is unhealthy or does not take this provider', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const down = backend('down', { healthy: false, result: 'ok' });
    const wrongProvider = backend('images-only', { providers: ['instagram'], result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [down, wrongProvider],
      capabilitiesOf: caps(),
    });

    await expect(router.resolve(url, 'youtube')).rejects.toMatchObject({
      code: 'SOURCE_BLOCKED',
    });
    expect(down.calls).toBe(0);
    expect(wrongProvider.calls).toBe(0);
  });

  it('reports the first failure when every backend refuses', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const home = backend('residential', { result: seraError('NETWORK_ERROR') });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps(),
    });

    await expect(router.resolve(url, 'youtube')).rejects.toMatchObject({
      code: 'SOURCE_BLOCKED',
    });
    expect(home.calls).toBe(1);
  });

  it('picks up a backend that connected after start-up', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const late = backend('residential', { result: 'ok' });
    const connected: ExtractionBackend[] = [];
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => connected,
      capabilitiesOf: caps(),
    });

    await expect(router.resolve(url, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    connected.push(late);
    expect((await router.resolve(url, 'youtube')).backend).toBe('residential');
  });

  it('describes what is available for the health endpoint', () => {
    const router = new ExtractionRouter({
      primary: backend('oracle', {}),
      logger: silentLogger(),
      fallbacks: () => [backend('residential', { healthy: false, providers: ['youtube'] })],
      capabilitiesOf: caps(),
    });
    expect(router.describe()).toEqual([
      { id: 'oracle', kind: 'local', networkClass: 'datacenter', healthy: true, providers: [] },
      {
        id: 'residential',
        kind: 'remote',
        networkClass: 'residential',
        healthy: false,
        providers: ['youtube'],
      },
    ]);
  });
});

describe('the capability matrix decides where work may go', () => {
  it('never sends a provider that declares no residential fallback', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ residentialFallback: false }),
    });

    await expect(router.resolve(url, 'generic')).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(home.calls).toBe(0);
  });

  it('treats a provider it has never heard of as local-only', async () => {
    const primary = backend('oracle', { result: seraError('SOURCE_BLOCKED') });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: () => undefined,
    });

    await expect(router.resolve(url, 'unknown')).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(home.calls).toBe(0);
  });

  it('asks the node first when the datacentre has already been measured as refused', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    const outcome = await router.resolve(url, 'youtube');
    expect(outcome.backend).toBe('residential');
    expect(primary.calls).toBe(0);
  });

  it('does not reorder when the operator has not said what their network is', async () => {
    const primary = backend('oracle', { result: 'ok', networkClass: 'unknown' });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    expect((await router.resolve(url, 'youtube')).backend).toBe('oracle');
    expect(home.calls).toBe(0);
  });

  it('still tries the datacentre when no node is connected', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    expect((await router.resolve(url, 'youtube')).backend).toBe('oracle');
  });

  it('comes home when a node drops mid-request', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: seraError('NETWORK_ERROR') });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    const outcome = await router.resolve(url, 'youtube');
    expect(outcome.backend).toBe('oracle');
    expect(home.calls).toBe(1);
  });

  it('says a node answered even when the node was the first choice', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    const outcome = await router.resolve(url, 'youtube');
    expect(outcome.backend).toBe('residential');
    expect(outcome.remote).toBe(true);
    expect(outcome.fallbackUsed).toBe(false);
  });

  it('says the local backend answered when it did', async () => {
    const router = new ExtractionRouter({
      primary: backend('oracle', { result: 'ok' }),
      logger: silentLogger(),
      fallbacks: () => [backend('residential', { result: 'ok' })],
      capabilitiesOf: caps(),
    });
    expect((await router.resolve(url, 'youtube')).remote).toBe(false);
  });

  it('does not come home when the node reported something an address cannot fix', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: seraError('PRIVATE_CONTENT') });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
      capabilitiesOf: caps({ cloudExtraction: false }),
    });

    await expect(router.resolve(url, 'youtube')).rejects.toMatchObject({
      code: 'PRIVATE_CONTENT',
    });
    expect(primary.calls).toBe(0);
  });
});

describe('a post only an account can read', () => {
  const instagram = new URL('https://www.instagram.com/p/DcOX3hWFiey/');
  const needsAccount = () =>
    seraError('PROVIDER_AUTH_REQUIRED', { detail: 'instagram: no video in post' });

  function route(
    signedIn: ExtractionBackend | undefined,
    lastResort?: () => Promise<ResolvedMedia>,
  ) {
    return new ExtractionRouter({
      primary: backend('oracle', { result: needsAccount() }),
      logger: silentLogger(),
      fallbacks: () => [],
      capabilitiesOf: caps(),
      authenticated: () => signedIn,
      ...(lastResort ? { lastResort } : {}),
    });
  }

  it('goes to a node holding an account, before the lesser cover image', async () => {
    const node = backend('instagram-session', { result: 'ok' });
    let covers = 0;
    const outcome = await route(node, () => {
      covers += 1;
      return Promise.resolve(media);
    }).resolve(instagram, 'instagram');

    expect(node.calls).toBe(1);
    expect(covers).toBe(0);
    expect(outcome).toMatchObject({ backend: 'instagram-session', remote: true });
  });

  it('gives the node’s own answer when that is final, such as a private account', async () => {
    const node = backend('instagram-session', { result: seraError('PRIVATE_CONTENT') });
    await expect(route(node).resolve(instagram, 'instagram')).rejects.toMatchObject({
      code: 'PRIVATE_CONTENT',
    });
  });

  it('keeps the original answer when the node fails for some other reason', async () => {
    const node = backend('instagram-session', { result: seraError('NETWORK_ERROR') });
    await expect(route(node).resolve(instagram, 'instagram')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
  });

  it('is asked however the extractor described the photo post', async () => {
    for (const described of [
      seraError('UNSUPPORTED_SOURCE', { detail: 'There is no video in this post' }),
      seraError('MEDIA_UNAVAILABLE', { detail: 'ERROR: [Instagram] x: No video formats found!' }),
    ]) {
      const node = backend('instagram-session', { result: 'ok' });
      const router = new ExtractionRouter({
        primary: backend('oracle', { result: described }),
        logger: silentLogger(),
        fallbacks: () => [],
        capabilitiesOf: caps(),
        authenticated: () => node,
      });
      await expect(router.resolve(instagram, 'instagram')).resolves.toMatchObject({
        backend: 'instagram-session',
      });
    }
  });

  it('is not asked when no such node is connected, or for a final answer', async () => {
    const offline = backend('instagram-session', { healthy: false });
    await expect(route(offline).resolve(instagram, 'instagram')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED',
    });
    expect(offline.calls).toBe(0);

    const node = backend('instagram-session', { result: 'ok' });
    const router = new ExtractionRouter({
      primary: backend('oracle', { result: seraError('PRIVATE_CONTENT') }),
      logger: silentLogger(),
      fallbacks: () => [],
      capabilitiesOf: caps(),
      authenticated: () => node,
    });
    await expect(router.resolve(instagram, 'instagram')).rejects.toMatchObject({
      code: 'PRIVATE_CONTENT',
    });
    expect(node.calls).toBe(0);
  });
});
