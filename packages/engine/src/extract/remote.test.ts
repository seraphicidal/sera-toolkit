import { describe, expect, it } from 'vitest';
import { seraError, SeraError } from '../errors.js';
import { silentLogger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import {
  ExtractionNodeRegistry,
  remoteBackend,
  remoteBackends,
  requiredFeatures,
  sessionBackend,
} from './remote.js';

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
  return new ExtractionNodeRegistry(silentLogger(), 200, 2000);
}

describe('ExtractionNodeRegistry', () => {
  it('hands a queued task to a node that is already waiting', async () => {
    const nodes = registry();
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
    nodes
      .dispatch({ kind: 'resolve', url: 'https://x.com/a/status/1', providerId: 'twitter' })
      .catch(() => undefined);
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
    const nodes = registry();
    expect(nodes.completeResolve('never-existed', media)).toBe(false);
    expect(nodes.fail('never-existed', seraError('INTERNAL'))).toBe(false);
  });
});

describe('matching a task to a node', () => {
  it('does not hand a waiting node work it said it would not take', async () => {
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
    expect(await nodes.claim('first', ['youtube'], 1, 120)).toBeUndefined();
    expect(await nodes.claim('second', ['youtube'], 1, 120)).toBeDefined();

    const status = new Map(nodes.status().map((node) => [node.id, node]));
    expect(status.get('first')?.inFlight).toBe(1);
    expect(status.get('second')?.inFlight).toBe(1);
  });
});

describe('a task that needs more than a download', () => {
  const job = (extra: object) => ({
    kind: 'job' as const,
    url: media.url,
    providerId: 'youtube',
    planKeys: ['video/mp4/1080p'],
    ...extra,
  });

  it('is not handed to a node that never said it understands it', async () => {
    const nodes = registry();
    nodes.dispatchJob(job({ trim: { start: 10, end: 20 } })).catch(() => undefined);
    expect(await nodes.claim('old', ['youtube'], 1, 120)).toBeUndefined();
    expect(
      await nodes.claim('old', ['youtube'], 1, 120, 'residential', ['subtitles']),
    ).toBeUndefined();
    const task = await nodes.claim('new', ['youtube'], 1, 120, 'residential', [
      'trim',
      'subtitles',
    ]);
    expect(task?.trim).toEqual({ start: 10, end: 20 });
  });

  it('wakes the node that understands it, not the one that asked first', async () => {
    const nodes = registry();
    const old = nodes.claim('old', ['youtube'], 1, 200);
    const current = nodes.claim('new', ['youtube'], 1, 1000, 'residential', ['trim', 'subtitles']);
    nodes
      .dispatchJob(job({ subtitles: { lang: 'en', auto: false, format: 'embed', only: false } }))
      .catch(() => undefined);
    expect((await current)?.subtitles?.lang).toBe('en');
    expect(await old).toBeUndefined();
  });

  it('is refused at once when the connected nodes cannot do it', async () => {
    const nodes = registry();
    await nodes.claim('old', ['youtube'], 1, 50);
    const started = Date.now();
    await expect(nodes.dispatchJob(job({ trim: { start: 10 } }))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringMatching(/^Trimming cannot be done/),
    });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('leaves a plain job to any node, old or new', async () => {
    const nodes = registry();
    nodes.dispatchJob(job({})).catch(() => undefined);
    expect(await nodes.claim('old', ['youtube'], 1, 120)).toBeDefined();
  });

  it('keeps a job that picks some slides from a node that would pair keys with items in order', async () => {
    const nodes = registry();
    nodes.dispatchJob(job({ items: [{ index: 8, sourceId: 's9' }] })).catch(() => undefined);
    expect(await nodes.claim('old', ['youtube'], 1, 120, 'residential', ['trim'])).toBeUndefined();
    const task = await nodes.claim('new', ['youtube'], 1, 120, 'residential', ['items']);
    expect(task?.items).toEqual([{ index: 8, sourceId: 's9' }]);
  });

  it('names what a task needs', () => {
    expect(requiredFeatures({})).toEqual([]);
    expect(requiredFeatures({ items: [{ index: 0 }, { index: 1 }] })).toEqual(['items']);
    expect(requiredFeatures({ items: [{ index: 0 }, { index: 2 }] })).toEqual(['items']);
    expect(
      requiredFeatures({
        trim: { start: 1 },
        subtitles: { lang: 'en', auto: true, format: 'srt', only: true },
      }),
    ).toEqual(['trim', 'subtitles']);
  });
});

describe('a post only a node holding an account can read', () => {
  const account = ['instagram-session'] as const;
  const post = new URL('https://www.instagram.com/p/DdybLuqCXSN/');

  it('goes to another such node when the first fails, and not back to the first', async () => {
    const nodes = registry();
    nodes.register('phone', ['instagram'], 1, 'residential', [...account]);
    nodes.register('laptop', ['instagram'], 1, 'residential', [...account]);
    const resolving = sessionBackend(nodes, 'instagram-session').resolve(post, 'instagram');

    const first = await nodes.claim('phone', ['instagram'], 1, 500, 'residential', [...account]);
    expect(first?.requires).toEqual(['instagram-session']);
    nodes.fail(first!.id, seraError('PROVIDER_AUTH_REQUIRED'));
    await wait(10);

    expect(
      await nodes.claim('phone', ['instagram'], 1, 120, 'residential', [...account]),
    ).toBeUndefined();
    const second = await nodes.claim('laptop', ['instagram'], 1, 500, 'residential', [...account]);
    expect(second?.avoid).toEqual(['phone']);
    nodes.completeResolve(second!.id, { ...media, provider: 'instagram' });
    await expect(resolving).resolves.toMatchObject({ provider: 'instagram' });
  });

  it('gives up when no other node holds an account, or the answer is final', async () => {
    const nodes = registry();
    nodes.register('phone', ['instagram'], 1, 'residential', [...account]);
    const alone = sessionBackend(nodes, 'instagram-session').resolve(post, 'instagram');
    const task = await nodes.claim('phone', ['instagram'], 1, 500, 'residential', [...account]);
    nodes.fail(task!.id, seraError('PROVIDER_AUTH_REQUIRED'));
    await expect(alone).rejects.toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED' });

    nodes.register('laptop', ['instagram'], 1, 'residential', [...account]);
    const privatePost = sessionBackend(nodes, 'instagram-session').resolve(post, 'instagram');
    const claimed = await nodes.claim('phone', ['instagram'], 1, 500, 'residential', [...account]);
    nodes.fail(claimed!.id, seraError('PRIVATE_CONTENT'));
    await expect(privatePost).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
  });
});

describe('a node that goes silent on a task it claimed', () => {
  const leased = () => new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 200);

  it('loses the task to another node, which completes it', async () => {
    const nodes = leased();
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });

    const lost = await nodes.claim('laptop', ['youtube'], 1, 200);
    expect(lost).toBeDefined();

    const retaken = await nodes.claim('phone', ['youtube'], 1, 1000);
    expect(retaken?.url).toBe(lost!.url);
    expect(retaken?.id).not.toBe(lost!.id);

    expect(nodes.completeResolve(retaken!.id, media)).toBe(true);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });

  it("frees the silent node's capacity instead of holding it for the task timeout", async () => {
    const nodes = leased();
    nodes
      .dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' })
      .catch(() => undefined);
    await nodes.claim('laptop', ['youtube'], 1, 200);
    expect(nodes.status().find((node) => node.id === 'laptop')?.inFlight).toBe(1);

    await wait(300);
    expect(nodes.status().find((node) => node.id === 'laptop')?.inFlight).toBe(0);
    expect(await nodes.claim('laptop', ['youtube'], 1, 200)).toBeDefined();
  });

  it('ignores everything the silent node sends once the task has moved on', async () => {
    const nodes = leased();
    const progress: number[] = [];
    const dispatched = nodes.dispatchJob(
      { kind: 'job', url: media.url, providerId: 'youtube', planKeys: ['a', 'b'] },
      { onProgress: (update) => progress.push(update.percent) },
    );

    const lost = await nodes.claim('laptop', ['youtube'], 1, 200);
    const retaken = await nodes.claim('phone', ['youtube'], 1, 1000);
    expect(retaken).toBeDefined();

    nodes.reportProgress(lost!.id, { percent: 90, step: 'late' });
    expect(nodes.isCancelled(lost!.id)).toBe(true);
    expect(
      nodes.acceptFile(lost!.id, { name: 'stale.mp4', mimeType: 'video/mp4', path: '/x' }),
    ).toBe(false);
    expect(nodes.fail(lost!.id, seraError('NETWORK_ERROR'))).toBe(false);
    expect(nodes.completeJob(lost!.id)).toBe(false);

    expect(nodes.isCancelled(retaken!.id)).toBe(false);
    nodes.reportProgress(retaken!.id, { percent: 50, step: 'Downloading' });
    nodes.acceptFile(retaken!.id, { name: 'one.mp4', mimeType: 'video/mp4', path: '/one' });
    nodes.acceptFile(retaken!.id, { name: 'two.mp4', mimeType: 'video/mp4', path: '/two' });
    expect(nodes.completeJob(retaken!.id)).toBe(true);

    const files = await dispatched;
    expect(files.map((file) => file.name)).toEqual(['one.mp4', 'two.mp4']);
    expect(progress).toEqual([50]);
  });

  it('drops files the silent node uploaded before it went quiet', async () => {
    const nodes = leased();
    const dispatched = nodes.dispatchJob({
      kind: 'job',
      url: media.url,
      providerId: 'youtube',
      planKeys: ['a', 'b'],
    });

    const lost = await nodes.claim('laptop', ['youtube'], 1, 200);
    nodes.acceptFile(lost!.id, { name: 'half.mp4', mimeType: 'video/mp4', path: '/half' });

    const retaken = await nodes.claim('phone', ['youtube'], 1, 1000);
    nodes.acceptFile(retaken!.id, { name: 'whole.mp4', mimeType: 'video/mp4', path: '/whole' });
    nodes.completeJob(retaken!.id);

    expect((await dispatched).map((file) => file.name)).toEqual(['whole.mp4']);
  });

  it('keeps the task with a node that keeps reporting', async () => {
    const nodes = leased();
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });
    const task = await nodes.claim('laptop', ['youtube'], 1, 200);

    for (let i = 0; i < 9; i += 1) {
      await wait(40);
      nodes.reportProgress(task!.id, { percent: 0, step: 'Working' });
    }
    expect(await nodes.claim('phone', ['youtube'], 1, 100)).toBeUndefined();

    expect(nodes.completeResolve(task!.id, media)).toBe(true);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });

  it('still lets the caller cancel a task that has been offered again', async () => {
    const nodes = leased();
    const controller = new AbortController();
    const dispatched = nodes.dispatch(
      { kind: 'resolve', url: media.url, providerId: 'youtube' },
      { signal: controller.signal },
    );
    await nodes.claim('laptop', ['youtube'], 1, 200);
    await wait(250);

    controller.abort();
    await expect(dispatched).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await nodes.claim('phone', ['youtube'], 1, 100)).toBeUndefined();
  });

  it('tombstones timed-out task IDs and avoids the silent node when another healthy node exists', async () => {
    const nodes = leased();
    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });
    nodes.register('desktop', ['youtube'], 1);

    const first = await nodes.claim('laptop', ['youtube'], 1, 200);
    expect(first).toBeDefined();
    await wait(250);

    expect(nodes.isCancelled(first!.id)).toBe(true);
    expect(await nodes.claim('laptop', ['youtube'], 1, 50)).toBeUndefined();

    const second = await nodes.claim('desktop', ['youtube'], 1, 100);
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.avoid).toContain('laptop');

    expect(nodes.completeResolve(second!.id, media)).toBe(true);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
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

describe('registry task inspection, cleanup hooks, and fail-fast', () => {
  it('exposes getTask, fires onTaskId and onTaskCleanup, and rejects mismatched completeResolve', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 150);
    const seenIds: string[] = [];
    const cleanedIds: string[] = [];
    const unsubscribe = nodes.onTaskCleanup((id) => cleanedIds.push(id));

    const pending = nodes.dispatch(
      { kind: 'resolve', url: media.url, providerId: 'youtube' },
      { onTaskId: (id) => seenIds.push(id) },
    );
    const first = await nodes.claim('node-a', ['youtube'], 1, 500);
    expect(first).toBeDefined();
    expect(seenIds).toEqual([first!.id]);
    expect(nodes.getTask(first!.id)?.providerId).toBe('youtube');
    expect(nodes.completeResolve(first!.id, { ...media, provider: 'twitter' })).toBe(false);

    const second = await nodes.claim('node-b', ['youtube'], 1, 1000);
    expect(second).toBeDefined();
    expect(cleanedIds).toContain(first!.id);
    expect(seenIds).toEqual([first!.id, second!.id]);

    nodes.fail(second!.id, seraError('NETWORK_ERROR'));
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(cleanedIds).toContain(second!.id);
    unsubscribe();
  });

  it('fails dispatchJob fast when all registered nodes have gone stale', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 50, 5000);
    nodes.register('offline-node', ['youtube'], 1);
    await wait(80);
    const started = Date.now();
    await expect(
      nodes.dispatchJob({
        kind: 'job',
        url: media.url,
        providerId: 'youtube',
        planKeys: ['video/mp4/1080p'],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('primary over backup scheduling and failover', () => {
  it('ranks primary strictly above backup even when backup called claim first, and higher priority wins within role', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 500);
    const phoneBackup = nodes.claim('phone', ['*'], 1, 800, 'residential', [], {
      role: 'backup',
      priority: 100,
    });
    const pcStandard = nodes.claim('pc-2', ['*'], 1, 800, 'residential', [], {
      role: 'primary',
      priority: 0,
    });
    const pcFast = nodes.claim('pc-1', ['*'], 1, 800, 'residential', [], {
      role: 'primary',
      priority: 10,
    });

    const first = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'generic' });
    const firstTask = await pcFast;
    expect(firstTask?.providerId).toBe('generic');
    nodes.completeResolve(firstTask!.id, { ...media, provider: 'generic' });
    await expect(first).resolves.toMatchObject({ provider: 'generic' });

    const second = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'direct' });
    const secondTask = await pcStandard;
    expect(secondTask?.providerId).toBe('direct');
    nodes.completeResolve(secondTask!.id, { ...media, provider: 'direct' });
    await expect(second).resolves.toMatchObject({ provider: 'direct' });

    expect(await phoneBackup).toBeUndefined();
  });

  it('prevents backup from stealing tasks during a primary poll gap', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 500);
    nodes.register('pc', ['*'], 1, 'residential', ['trim'], { role: 'primary' });

    const phoneWaiting = nodes.claim('phone', ['*'], 1, 350, 'residential', ['trim'], {
      role: 'backup',
    });

    const dispatched = nodes.dispatch({
      kind: 'resolve',
      url: 'https://example.com/article',
      providerId: 'generic',
    });

    await wait(80);
    const pcTask = await nodes.claim('pc', ['*'], 1, 500, 'residential', ['trim'], {
      role: 'primary',
    });
    expect(pcTask).toBeDefined();
    expect(pcTask!.providerId).toBe('generic');

    nodes.completeResolve(pcTask!.id, { ...media, provider: 'generic' });
    await expect(dispatched).resolves.toMatchObject({ provider: 'generic' });
    expect(await phoneWaiting).toBeUndefined();
  });

  it('prevents an incoming backup claim from stealing a queued task during the primary grace window', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 400);
    nodes.register('pc', ['*'], 1, 'residential', [], { role: 'primary' });

    const dispatched = nodes.dispatch({
      kind: 'resolve',
      url: media.url,
      providerId: 'youtube',
    });

    const phoneClaim = nodes.claim('phone', ['*'], 1, 250, 'residential', [], { role: 'backup' });
    await wait(60);

    const pcTask = await nodes.claim('pc', ['*'], 1, 500, 'residential', [], { role: 'primary' });
    expect(pcTask?.providerId).toBe('youtube');
    nodes.completeResolve(pcTask!.id, media);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
    expect(await phoneClaim).toBeUndefined();
  });

  it('hands off to backup after primary grace window expires when primary does not return', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 120);
    nodes.register('pc', ['*'], 1, 'residential', [], { role: 'primary' });

    const phoneWaiting = nodes.claim('phone', ['*'], 1, 1000, 'residential', [], {
      role: 'backup',
    });
    const started = Date.now();
    const dispatched = nodes.dispatch({
      kind: 'resolve',
      url: media.url,
      providerId: 'youtube',
    });

    const task = await phoneWaiting;
    const elapsed = Date.now() - started;
    expect(task).toBeDefined();
    expect(elapsed).toBeGreaterThanOrEqual(90);

    nodes.completeResolve(task!.id, media);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });

  it('dispatches immediately to backup without grace delay when primary is offline or stale', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 60, 5000, 1000, 5000, 5000);
    nodes.register('pc', ['*'], 1, 'residential', [], { role: 'primary' });
    await wait(80);

    const phoneWaiting = nodes.claim('phone', ['*'], 1, 1000, 'residential', [], {
      role: 'backup',
    });
    const started = Date.now();
    const dispatched = nodes.dispatch({
      kind: 'resolve',
      url: media.url,
      providerId: 'youtube',
    });

    const task = await phoneWaiting;
    expect(task).toBeDefined();
    expect(Date.now() - started).toBeLessThan(200);

    nodes.completeResolve(task!.id, media);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });

  it('fails over from primary to backup immediately via remoteBackend when primary fails with a transient error', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 5000);
    nodes.register('pc', ['*'], 1, 'residential', [], { role: 'primary' });
    nodes.register('phone', ['*'], 1, 'residential', [], { role: 'backup' });

    const backend = remoteBackend(nodes, 'residential');
    const resolving = backend.resolve(new URL(media.url), 'youtube');

    const pcTask = await nodes.claim('pc', ['*'], 1, 500, 'residential', [], { role: 'primary' });
    expect(pcTask).toBeDefined();

    const phoneWaiting = nodes.claim('phone', ['*'], 1, 1000, 'residential', [], {
      role: 'backup',
    });
    const failAt = Date.now();
    nodes.fail(pcTask!.id, seraError('NETWORK_ERROR', { detail: 'pc upstream drop' }));

    const phoneTask = await phoneWaiting;
    expect(phoneTask).toBeDefined();
    expect(phoneTask!.avoid).toEqual(['pc']);
    expect(Date.now() - failAt).toBeLessThan(250);

    nodes.completeResolve(phoneTask!.id, media);
    await expect(resolving).resolves.toMatchObject({ title: 'A video' });
  });

  it('does not fail over to backup when primary returns a definitive error', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 500);
    nodes.register('pc', ['*'], 1, 'residential', [], { role: 'primary' });
    const phoneWaiting = nodes.claim('phone', ['*'], 1, 200, 'residential', [], {
      role: 'backup',
    });

    const resolving = remoteBackend(nodes, 'residential').resolve(new URL(media.url), 'youtube');
    const pcTask = await nodes.claim('pc', ['*'], 1, 500, 'residential', [], { role: 'primary' });
    nodes.fail(pcTask!.id, seraError('PRIVATE_CONTENT'));

    await expect(resolving).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
    expect(await phoneWaiting).toBeUndefined();
  });

  it('preserves wildcard provider availability when mixed with restricted nodes and infers mobile role when omitted', () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000);
    nodes.register('pc', ['*'], 1, 'residential', []);
    nodes.register('old-android', ['youtube'], 1, 'residential', [], {
      transport: 'cellular',
      appVersion: '1.1.0',
    });
    nodes.register('explicit-primary-phone', ['youtube'], 1, 'residential', [], {
      transport: 'wifi',
      appVersion: '1.2.0',
      role: 'primary',
    });

    expect(nodes.availableProviders('residential')).toEqual(['*']);
    const byId = new Map(nodes.status().map((n) => [n.id, n]));
    expect(byId.get('pc')?.role).toBe('primary');
    expect(byId.get('old-android')?.role).toBe('backup');
    expect(byId.get('explicit-primary-phone')?.role).toBe('primary');
  });

  it('re-arms unclaimedTimer when a live node crashes and fails once stale instead of hanging until taskTimeout', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 90, 10_000, 1000, 30, 0);
    nodes.register('crashing-pc', ['youtube'], 1, 'residential', [], { role: 'primary' });

    const started = Date.now();
    await expect(
      nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1500);
  });

  it('removes a waiting claim immediately when its AbortSignal aborts so dead waiters never claim tasks', async () => {
    const nodes = new ExtractionNodeRegistry(silentLogger(), 5000, 5000, 1000, 5000, 0);
    const deadAbort = new AbortController();
    const deadClaim = nodes.claim(
      'dead-node',
      ['youtube'],
      1,
      5000,
      'residential',
      [],
      { role: 'primary' },
      deadAbort.signal,
    );
    const liveClaim = nodes.claim('live-node', ['youtube'], 1, 2000, 'residential', [], {
      role: 'backup',
    });

    deadAbort.abort();
    expect(await deadClaim).toBeUndefined();

    const dispatched = nodes.dispatch({ kind: 'resolve', url: media.url, providerId: 'youtube' });
    const liveTask = await liveClaim;
    expect(liveTask).toBeDefined();
    expect(nodes.claimedBy(liveTask!.id)).toBe('live-node');
    nodes.completeResolve(liveTask!.id, media);
    await expect(dispatched).resolves.toMatchObject({ title: 'A video' });
  });
});
