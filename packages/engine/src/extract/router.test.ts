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

/** A provider that behaves like YouTube unless a test says otherwise. */
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
    // The scarce backend is not touched when the free one succeeded.
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
    // The rule that keeps a home connection from being spent on nothing.
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
    // The visitor hears about the path this deployment is configured to take, not about
    // an internal fallback they never asked for.
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
    // The node dials out; it must not need a restart of the API to be usable.
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
    // The generic and direct-file providers claim whatever host nothing else wanted, so
    // their URL is the visitor's. A node exists to get past a platform that refuses
    // datacentres; it is not there to fetch arbitrary addresses from someone's house,
    // and a bot challenge on an arbitrary host must not turn it into one.
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
    // YouTube from Oracle is refused on every player client yt-dlp offers. Paying for
    // that refusal before asking a connected node is a delay with a known outcome.
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
    // SERA on a home connection has a primary that is not a datacentre. A measurement
    // taken on Oracle must not demote it.
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
    // A measurement is not a reason to invent a refusal SERA could have avoided.
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
    // The node going away is the deployment's problem, not the visitor's.
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
    // `fallbackUsed` asks whether the first choice failed, which is a different question
    // from where the work ran. A node can be the first choice — that is exactly what a
    // provider declaring no datacentre extraction asks for — and the download still has
    // to follow it, because a media URL signed for one address is refused from another.
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
