import { describe, expect, it } from 'vitest';
import { seraError, SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { ExtractionRouter, type ExtractionBackend } from './router.js';

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
  behaviour: { healthy?: boolean; providers?: string[]; result?: 'ok' | SeraError },
): ExtractionBackend & { calls: number } {
  const impl = {
    id,
    kind: id === 'oracle' ? ('local' as const) : ('remote' as const),
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

const url = new URL('https://www.youtube.com/watch?v=x');

describe('ExtractionRouter', () => {
  it('uses the primary and stops there when it works', async () => {
    const primary = backend('oracle', { result: 'ok' });
    const home = backend('residential', { result: 'ok' });
    const router = new ExtractionRouter({
      primary,
      logger: silentLogger(),
      fallbacks: () => [home],
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
    });
    expect(router.describe()).toEqual([
      { id: 'oracle', kind: 'local', healthy: true, providers: [] },
      { id: 'residential', kind: 'remote', healthy: false, providers: ['youtube'] },
    ]);
  });
});
