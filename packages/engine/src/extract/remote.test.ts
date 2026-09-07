import { describe, expect, it } from 'vitest';
import { seraError, SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { ExtractionNodeRegistry, remoteBackend, remoteBackends } from './remote.js';

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function registry(): ExtractionNodeRegistry {
  // Short windows so the tests exercise expiry without waiting on the real ones.
  return new ExtractionNodeRegistry(silentLogger(), 200, 2000);
}

describe('ExtractionNodeRegistry', () => {
  it('hands a queued task to a node that is already waiting', async () => {
    const nodes = registry();
    // The node asks first and blocks — this is the heartbeat as well as the queue.
    const claim = nodes.claim('home', ['youtube'], 1, 1000);
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });

    const task = await claim;
    expect(task?.kind).toBe('resolve');
    expect(task?.providerId).toBe('youtube');

    nodes.completeResolve(task!.id, media);
    expect((await dispatched).title).toBe('A video');
  });

  it('hands over a task that was queued before the node asked', async () => {
    const nodes = registry();
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });
    const task = await nodes.claim('home', ['youtube'], 1, 1000);
    expect(task).toBeDefined();
    nodes.completeResolve(task!.id, media);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });

  it('only gives a node providers it said it would take', async () => {
    const nodes = registry();
    // Deliberately never answered, so the rejection when it ages out is expected.
    nodes
      .dispatch({ kind: 'resolve', url: 'https://x.com/a/status/1', providerId: 'twitter' })
      .catch(() => undefined);
    // A node that only does YouTube must not be handed an X task.
    expect(await nodes.claim('home', ['youtube'], 1, 120)).toBeUndefined();
    expect((await nodes.claim('home', ['twitter'], 1, 120))?.providerId).toBe('twitter');
  });

  it('returns nothing when the hold expires, which is how a node stays a heartbeat', async () => {
    const nodes = registry();
    expect(await nodes.claim('home', ['youtube'], 1, 100)).toBeUndefined();
    expect(nodes.hasHealthyNode()).toBe(true);
  });

  it('stops counting a node that has gone quiet', async () => {
    const nodes = registry();
    nodes.register('home', ['youtube'], 1);
    expect(nodes.hasHealthyNode()).toBe(true);
    expect(nodes.availableProviders()).toEqual(['youtube']);

    await wait(250);
    expect(nodes.hasHealthyNode()).toBe(false);
    expect(nodes.availableProviders()).toEqual([]);
    expect(nodes.status()[0]?.healthy).toBe(false);
  });

  it('passes a node failure back to the caller', async () => {
    const nodes = registry();
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });
    const task = await nodes.claim('home', ['youtube'], 1, 1000);
    nodes.fail(task!.id, seraError('PRIVATE_CONTENT', { detail: 'private on every network' }));

    const error = await dispatched.then(
      () => undefined,
      (caught: unknown) => SeraError.from(caught),
    );
    expect(error?.code).toBe('PRIVATE_CONTENT');
  });

  it('gives up rather than waiting forever for a node that never comes', async () => {
    const nodes = registry();
    const error = await nodes
      .dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' })
      .then(
        () => undefined,
        (caught: unknown) => SeraError.from(caught),
      );
    expect(error?.code).toBe('TIMEOUT');
  });

  it('cancels a task the caller abandoned, and tells a node that took it', async () => {
    const nodes = registry();
    const abort = new AbortController();
    const dispatched = nodes.dispatch(
      { kind: 'resolve', url: media.url, providerId: 'youtube' },
      { signal: abort.signal },
    );
    const task = await nodes.claim('home', ['youtube'], 1, 1000);
    expect(nodes.isCancelled(task!.id)).toBe(false);

    abort.abort();
    await expect(dispatched).rejects.toMatchObject({ code: 'CANCELLED' });
    // The node is mid-download and has to be able to find out.
    expect(nodes.isCancelled(task!.id)).toBe(true);
  });

  it('forwards progress to whoever is watching the job', async () => {
    const nodes = registry();
    const seen: number[] = [];
    const dispatched = nodes.dispatch(
      { kind: 'resolve', url: media.url, providerId: 'youtube' },
      { onProgress: (progress) => seen.push(progress.percent) },
    );
    const task = await nodes.claim('home', ['youtube'], 1, 1000);
    nodes.reportProgress(task!.id, { percent: 10, step: 'Downloading' });
    nodes.reportProgress(task!.id, { percent: 80, step: 'Merging' });
    nodes.completeResolve(task!.id, media);
    await dispatched;
    expect(seen).toEqual([10, 80]);
  });

  it('ignores a result for a task nobody is waiting for', () => {
    // A node reconnecting after a restart may finish work the API has forgotten.
    const nodes = registry();
    expect(nodes.completeResolve('never-existed', media)).toBe(false);
    expect(nodes.fail('never-existed', seraError('INTERNAL'))).toBe(false);
  });
});

describe('matching a task to a node', () => {
  it('does not hand a waiting node work it said it would not take', async () => {
    // The bug this pins: a node's provider list was checked when it found a task already
    // queued, and not when a task arrived while it was waiting. Since waiting is the
    // normal state — the request is held open as a heartbeat — the check that mattered
    // was the one that was missing, and a node told to do YouTube alone could be handed
    // Instagram and refuse it as an extractor bug.
    const nodes = registry();
    const waiting = nodes.claim('youtube-only', ['youtube'], 1, 400);

    nodes
      .dispatch({ kind: 'resolve', url: 'https://www.instagram.com/p/A/', providerId: 'instagram' })
      .catch(() => undefined);

    expect(await waiting).toBeUndefined();
  });

  it('wakes the node that wants the task, not the one that asked first', async () => {
    const nodes = registry();
    const youtube = nodes.claim('youtube-only', ['youtube'], 1, 600);
    const instagram = nodes.claim('instagram-only', ['instagram'], 1, 600);

    nodes
      .dispatch({ kind: 'resolve', url: 'https://www.instagram.com/p/A/', providerId: 'instagram' })
      .catch(() => undefined);

    expect((await instagram)?.providerId).toBe('instagram');
    expect(await youtube).toBeUndefined();
  });

  it('keeps a task on the kind of connection it was routed to', async () => {
    const nodes = registry();
    nodes
      .dispatch({
        kind: 'resolve',
        url: media.url,
        providerId: 'youtube',
        networkClass: 'residential',
      })
      .catch(() => undefined);

    // A second cloud node is a legitimate node, and it is not the answer to a refusal
    // that was about being in a datacentre in the first place.
    expect(await nodes.claim('cloud', ['youtube'], 1, 120, 'datacenter')).toBeUndefined();
    expect((await nodes.claim('home', ['youtube'], 1, 120, 'residential'))?.providerId).toBe(
      'youtube',
    );
  });

  it('counts work per node rather than in total', async () => {
    const nodes = registry();
    nodes
      .dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' })
      .catch(() => undefined);
    await nodes.claim('first', ['youtube'], 1, 200);

    nodes
      .dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' })
      .catch(() => undefined);
    // The busy node is at capacity; the idle one takes it. Counting every claimed task
    // against every node made the second one look busy too.
    expect(await nodes.claim('first', ['youtube'], 1, 120)).toBeUndefined();
    expect(await nodes.claim('second', ['youtube'], 1, 120)).toBeDefined();

    const status = new Map(nodes.status().map((node) => [node.id, node]));
    expect(status.get('first')?.inFlight).toBe(1);
    expect(status.get('second')?.inFlight).toBe(1);
  });
});

describe('remoteBackend', () => {
  it('is unhealthy until a node has actually connected', () => {
    const nodes = registry();
    const backend = remoteBackend(nodes);
    expect(backend.kind).toBe('remote');
    expect(backend.isHealthy()).toBe(false);
    expect(backend.providers).toEqual([]);

    nodes.register('home', ['youtube', 'instagram'], 1);
    expect(backend.isHealthy()).toBe(true);
    expect(backend.providers).toEqual(['youtube', 'instagram']);
  });

  it('is one backend per kind of connection, so the router can tell them apart', () => {
    const nodes = registry();
    expect(remoteBackends(nodes)).toEqual([]);

    nodes.register('home', ['youtube'], 1, 'residential');
    nodes.register('other-cloud', ['vimeo'], 1, 'datacenter');

    const backends = new Map(
      remoteBackends(nodes).map((backend) => [backend.networkClass, backend]),
    );
    expect([...backends.keys()].sort()).toEqual(['datacenter', 'residential']);
    expect(backends.get('residential')?.providers).toEqual(['youtube']);
    expect(backends.get('datacenter')?.providers).toEqual(['vimeo']);
  });
});
