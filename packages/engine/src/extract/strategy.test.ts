import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { seraError, SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import type { ProviderContext, ResolvedMedia } from '../providers/types.js';
import { runStrategies, type ExtractionStrategy } from './strategy.js';

/**
 * The ladder, and the four rules that keep it from being a retry loop.
 *
 * A fallback chain that tries everything on every failure is worse than no chain: it
 * spends a visitor's time and somebody's bandwidth arriving at an answer the first
 * attempt already gave, and replaces a precise message with a vague one.
 */

const media: ResolvedMedia = {
  provider: 'test',
  providerLabel: 'Test',
  url: 'https://example.com/a',
  type: 'single',
  title: 'A thing',
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

function contextFor(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    config: loadConfig({
      NODE_ENV: 'test',
      SERA_SECRET: 'strategy-secret',
      SERA_DATA_DIR: '.data/test',
    }),
    logger: silentLogger(),
    probe: () => Promise.reject(new Error('not used')),
    fetchText: () => Promise.reject(new Error('not used')),
    head: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

/** A rung that records that it ran, and then does what it was told. */
function rung(
  id: string,
  behaviour: { result?: 'ok' | SeraError } & Partial<ExtractionStrategy>,
): ExtractionStrategy & { calls: number } {
  const impl = {
    id,
    label: id,
    calls: 0,
    ...(behaviour.answers ? { answers: behaviour.answers } : {}),
    ...(behaviour.degraded !== undefined ? { degraded: behaviour.degraded } : {}),
    ...(behaviour.available ? { available: behaviour.available } : {}),
    run: () => {
      impl.calls += 1;
      return behaviour.result === undefined || behaviour.result === 'ok'
        ? Promise.resolve(media)
        : Promise.reject(behaviour.result);
    },
  };
  return impl;
}

const url = new URL('https://example.com/a');
const run = (
  ladder: readonly ExtractionStrategy[],
  context = contextFor(),
  includeDegraded = false,
) =>
  runStrategies(ladder, url, context, {
    provider: 'test',
    logger: silentLogger(),
    includeDegraded,
  });

describe('the extraction ladder', () => {
  it('stops at the first rung that answers', async () => {
    const first = rung('a', { result: 'ok' });
    const second = rung('b', { result: 'ok' });

    const outcome = await run([first, second]);
    expect(outcome.strategy).toBe('a');
    expect(outcome.attempts).toEqual([]);
    expect(second.calls).toBe(0);
  });

  it('carries on when a rung fails in a way another could answer', async () => {
    const first = rung('a', { result: seraError('PROVIDER_UNAVAILABLE') });
    const second = rung('b', { result: 'ok' });

    const outcome = await run([first, second]);
    expect(outcome.strategy).toBe('b');
    expect(outcome.attempts.map((entry) => entry.strategy)).toEqual(['a']);
  });

  it('ends immediately on a failure no rung could answer', async () => {
    // The rule that makes this a ladder rather than a loop. A private post is private
    // from every route, and asking four more times replaces a precise answer with a
    // vague one — which is worse than slow.
    for (const code of ['PRIVATE_CONTENT', 'MEDIA_UNAVAILABLE', 'GEO_RESTRICTED'] as const) {
      const first = rung('a', { result: seraError(code) });
      const second = rung('b', { result: 'ok' });

      const error = await run([first, second]).then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );
      expect(error?.code, code).toBe(code);
      expect(second.calls, code).toBe(0);
    }
  });

  it('skips a rung that is not an answer to what went wrong', async () => {
    // Asking YouTube as a different player client answers "that client's list did not
    // have the format". It answers nothing about a bot challenge, and on a datacentre
    // where every client is challenged, running it would spend a round trip to learn
    // what the first one said — and delay the node that actually fixes it.
    const first = rung('a', { result: seraError('SOURCE_BLOCKED') });
    const narrow = rung('b', { result: 'ok', answers: ['FORMAT_UNAVAILABLE'] });

    await expect(run([first, narrow])).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(narrow.calls).toBe(0);
  });

  it('runs a narrow rung when its failure is the one that happened', async () => {
    const first = rung('a', {
      result: seraError('PROVIDER_UNAVAILABLE', { detail: 'Requested format is not available' }),
    });
    const narrow = rung('b', { result: 'ok', answers: ['FORMAT_UNAVAILABLE'] });

    expect((await run([first, narrow])).strategy).toBe('b');
    expect(narrow.calls).toBe(1);
  });

  it('never tries the same rung twice', async () => {
    const only = rung('a', { result: seraError('NETWORK_ERROR') });
    await expect(run([only])).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(only.calls).toBe(1);
  });

  it('leaves a lesser representation alone unless it is asked for', async () => {
    // A degraded rung that ran here would pre-empt the extraction node that could have
    // returned the whole post. Last has to mean last globally, so only the router's
    // final attempt turns these on.
    const first = rung('a', { result: seraError('SOURCE_BLOCKED') });
    const cover = rung('cover', { result: 'ok', degraded: true });

    await expect(run([first, cover])).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(cover.calls).toBe(0);

    const outcome = await run(
      [rung('a', { result: seraError('SOURCE_BLOCKED') }), cover],
      contextFor(),
      true,
    );
    expect(outcome.strategy).toBe('cover');
  });

  it('does not run a rung whose credential this installation lacks', async () => {
    const session = rung('session', { result: 'ok', available: () => false });
    const first = rung('a', { result: seraError('PROVIDER_UNAVAILABLE') });

    await expect(run([first, session])).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(session.calls).toBe(0);
  });

  it('says so rather than throwing something shapeless when nothing can run', async () => {
    const session = rung('session', { result: 'ok', available: () => false });
    await expect(run([session])).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
  });

  it('reports the first failure, and records the ladder behind it', async () => {
    // The visitor hears about the route the provider considers its own. The rest is in
    // `detail`, which is the operator's half and never reaches a browser by itself.
    const outcome = await run([
      rung('a', { result: seraError('PROVIDER_UNAVAILABLE', { detail: 'first thing' }) }),
      rung('b', { result: seraError('NETWORK_ERROR') }),
    ]).then(
      () => undefined,
      (error: unknown) => SeraError.from(error),
    );

    expect(outcome?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(outcome?.detail).toContain('first thing');
    expect(outcome?.detail).toContain('a=EXTRACTOR_BUG');
    expect(outcome?.detail).toContain('b=NETWORK_ERROR');
  });

  it('prefers a definitive answer found later over the first one', async () => {
    // "It was unsupported here, and private over there" — private is the truer sentence,
    // and it is the one that tells the visitor not to try again.
    const outcome = await run([
      rung('a', { result: seraError('PROVIDER_UNAVAILABLE') }),
      rung('b', { result: seraError('PRIVATE_CONTENT') }),
    ]).then(
      () => undefined,
      (error: unknown) => SeraError.from(error),
    );

    expect(outcome?.code).toBe('PRIVATE_CONTENT');
  });
});
