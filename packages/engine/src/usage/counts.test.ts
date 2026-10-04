import { describe, expect, it } from 'vitest';
import { silentLogger } from '../logging.js';
import {
  MemoryUsageCounter,
  parseUsageDay,
  RedisUsageCounter,
  totalUsage,
  USAGE_RETENTION_DAYS,
  usageDates,
  usageField,
  usageKey,
  type UsagePipeline,
  type UsageRedis,
} from './counts.js';

/**
 * Usage counts: what one event increments, how a day reads back, and how long it is kept.
 * The stored field is all there is — a source id, a kind, an outcome — so the tests check
 * that nothing else can get into it.
 */

describe('what an event increments', () => {
  it('a resolve or a download, by outcome and error code', () => {
    expect(usageField({ source: 'youtube', kind: 'resolve', ok: true })).toEqual({
      field: 'youtube:resolve:ok',
      by: 1,
    });
    expect(
      usageField({ source: 'tiktok', kind: 'download', ok: false, code: 'SOURCE_BLOCKED' }),
    ).toEqual({ field: 'tiktok:download:fail:SOURCE_BLOCKED', by: 1 });
    expect(usageField({ source: 'vimeo', kind: 'bytes', bytes: 1234.4 })).toEqual({
      field: 'vimeo:bytes',
      by: 1234,
    });
  });

  it('never a link, an address or a message, whatever it is handed', () => {
    expect(
      usageField({ source: 'https://example.com/a.mp4', kind: 'resolve', ok: true })?.field,
    ).toBe('other:resolve:ok');
    expect(
      usageField({ source: 'direct', kind: 'resolve', ok: false, code: 'Failed for 10.0.0.1' })
        ?.field,
    ).toBe('direct:resolve:fail:INTERNAL');
  });

  it('nothing for no bytes', () => {
    expect(usageField({ source: 'x', kind: 'bytes', bytes: 0 })).toBeUndefined();
    expect(usageField({ source: 'x', kind: 'bytes', bytes: Number.NaN })).toBeUndefined();
  });
});

describe('a day read back', () => {
  it('groups the fields by source, and ignores anything else', () => {
    expect(
      parseUsageDay('2026-10-04', {
        'youtube:resolve:ok': '5',
        'youtube:resolve:fail:SOURCE_BLOCKED': '2',
        'youtube:download:ok': '3',
        'youtube:download:fail:TOO_LARGE': '1',
        'youtube:bytes': '1048576',
        'stray-field': '9',
      }),
    ).toEqual({
      date: '2026-10-04',
      sources: {
        youtube: {
          resolves: { ok: 5, failed: { SOURCE_BLOCKED: 2 } },
          downloads: { ok: 3, failed: { TOO_LARGE: 1 } },
          bytes: 1_048_576,
        },
      },
    });
  });

  it('names the days newest first, in UTC, within the retention', () => {
    expect(usageDates(3, new Date('2026-10-04T00:30:00Z'))).toEqual([
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
    ]);
    expect(usageDates(1000)).toHaveLength(USAGE_RETENTION_DAYS);
  });
});

describe('counting in memory', () => {
  it('adds up per day, and totals across days', async () => {
    let now = new Date('2026-10-03T12:00:00Z');
    const counter = new MemoryUsageCounter(() => now);
    await counter.record({ source: 'youtube', kind: 'resolve', ok: true });
    now = new Date('2026-10-04T12:00:00Z');
    await counter.record({ source: 'youtube', kind: 'resolve', ok: true });
    await counter.record({ source: 'youtube', kind: 'download', ok: false, code: 'TIMEOUT' });

    const days = await counter.read(2);
    expect(days.map((day) => day.date)).toEqual(['2026-10-04', '2026-10-03']);
    expect(days[0]!.sources.youtube!.resolves.ok).toBe(1);
    expect(totalUsage(days).youtube).toEqual({
      resolves: { ok: 2, failed: {} },
      downloads: { ok: 0, failed: { TIMEOUT: 1 } },
      bytes: 0,
    });
  });

  it(`forgets a day after ${String(USAGE_RETENTION_DAYS)} days`, async () => {
    let now = new Date('2026-01-01T12:00:00Z');
    const counter = new MemoryUsageCounter(() => now);
    await counter.record({ source: 'vimeo', kind: 'resolve', ok: true });
    now = new Date('2026-06-01T12:00:00Z');
    await counter.record({ source: 'vimeo', kind: 'resolve', ok: true });
    const old = await counter.read(1, new Date('2026-01-01T12:00:00Z'));
    expect(old[0]!.sources).toEqual({});
  });
});

describe('counting in Redis', () => {
  /** Just enough Redis: hashes, and the TTL each key was given. */
  function fakeRedis() {
    const hashes = new Map<string, Map<string, number>>();
    const ttls = new Map<string, number>();
    const redis: UsageRedis = {
      multi() {
        const steps: (() => void)[] = [];
        const pipeline: UsagePipeline = {
          hincrby(key, field, by) {
            steps.push(() => {
              const hash = hashes.get(key) ?? new Map<string, number>();
              hash.set(field, (hash.get(field) ?? 0) + by);
              hashes.set(key, hash);
            });
            return pipeline;
          },
          expire(key, seconds) {
            steps.push(() => ttls.set(key, seconds));
            return pipeline;
          },
          exec() {
            for (const step of steps) step();
            return Promise.resolve([]);
          },
        };
        return pipeline;
      },
      hgetall: (key) =>
        Promise.resolve(
          Object.fromEntries(
            [...(hashes.get(key) ?? new Map<string, number>())].map(([f, v]) => [f, String(v)]),
          ),
        ),
      quit: () => Promise.resolve('OK'),
    };
    return { redis, hashes, ttls };
  }

  it('keeps one hash per day, expiring 90 days after its last write', async () => {
    const { redis, hashes, ttls } = fakeRedis();
    const now = new Date('2026-10-04T08:00:00Z');
    const counter = new RedisUsageCounter(redis, silentLogger(), () => now);
    await counter.record({ source: 'bandcamp', kind: 'download', ok: true });
    await counter.record({ source: 'bandcamp', kind: 'bytes', bytes: 500 });

    const key = usageKey('2026-10-04');
    expect([...hashes.keys()]).toEqual([key]);
    expect(Object.fromEntries(hashes.get(key)!)).toEqual({
      'bandcamp:download:ok': 1,
      'bandcamp:bytes': 500,
    });
    expect(ttls.get(key)).toBe(90 * 86_400);
    expect((await counter.read(1))[0]!.sources.bandcamp!.bytes).toBe(500);
  });

  it('loses a count rather than failing the request it belongs to', async () => {
    const broken: UsageRedis = {
      multi: () => {
        throw new Error('connection refused');
      },
      hgetall: () => Promise.reject(new Error('connection refused')),
      quit: () => Promise.resolve('OK'),
    };
    const counter = new RedisUsageCounter(broken, silentLogger());
    await expect(
      counter.record({ source: 'x', kind: 'resolve', ok: true }),
    ).resolves.toBeUndefined();
  });
});
