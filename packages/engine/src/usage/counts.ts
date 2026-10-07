import type { Logger } from '../logging.js';

export const USAGE_RETENTION_DAYS = 90;

export type UsageEvent =
  | {
      readonly source: string;
      readonly kind: 'resolve' | 'download';
      readonly ok: true;
    }
  | {
      readonly source: string;
      readonly kind: 'resolve' | 'download';
      readonly ok: false;
      readonly code: string;
    }
  | { readonly source: string; readonly kind: 'bytes'; readonly bytes: number };

export interface Outcomes {
  readonly ok: number;
  readonly failed: Readonly<Record<string, number>>;
}

export interface SourceUsage {
  readonly resolves: Outcomes;
  readonly downloads: Outcomes;
  readonly bytes: number;
}

export interface UsageDay {
  readonly date: string;
  readonly sources: Readonly<Record<string, SourceUsage>>;
}

export interface UsageCounter {
  record(event: UsageEvent): Promise<void>;
  read(days: number, now?: Date): Promise<UsageDay[]>;
  close(): Promise<void>;
}

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export function usageField(event: UsageEvent): { field: string; by: number } | undefined {
  const source = TOKEN.test(event.source) ? event.source : 'other';
  if (event.kind === 'bytes') {
    if (!Number.isFinite(event.bytes) || event.bytes <= 0) return undefined;
    return { field: `${source}:bytes`, by: Math.round(event.bytes) };
  }
  if (event.ok) return { field: `${source}:${event.kind}:ok`, by: 1 };
  const code = TOKEN.test(event.code) ? event.code : 'INTERNAL';
  return { field: `${source}:${event.kind}:fail:${code}`, by: 1 };
}

interface Tally {
  resolves: { ok: number; failed: Record<string, number> };
  downloads: { ok: number; failed: Record<string, number> };
  bytes: number;
}

const emptyTally = (): Tally => ({
  resolves: { ok: 0, failed: {} },
  downloads: { ok: 0, failed: {} },
  bytes: 0,
});

export function parseUsageDay(
  date: string,
  hash: Readonly<Record<string, string | number>>,
): UsageDay {
  const sources: Record<string, Tally> = {};
  for (const [field, raw] of Object.entries(hash)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const [source, kind, outcome, code] = field.split(':');
    if (!source || !kind) continue;
    const entry = (sources[source] ??= emptyTally());
    if (kind === 'bytes') entry.bytes += value;
    else if (kind === 'resolve' || kind === 'download') {
      const outcomes = kind === 'resolve' ? entry.resolves : entry.downloads;
      if (outcome === 'ok') outcomes.ok += value;
      else if (outcome === 'fail' && code)
        outcomes.failed[code] = (outcomes.failed[code] ?? 0) + value;
    }
  }
  return { date, sources };
}

export function usageDates(count: number, now = new Date()): string[] {
  const days = Math.max(1, Math.min(USAGE_RETENTION_DAYS, Math.floor(count)));
  return Array.from({ length: days }, (_, offset) =>
    new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10),
  );
}

export class MemoryUsageCounter implements UsageCounter {
  private readonly days = new Map<string, Map<string, number>>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  record(event: UsageEvent): Promise<void> {
    const increment = usageField(event);
    if (increment) {
      const date = this.clock().toISOString().slice(0, 10);
      const day = this.days.get(date) ?? new Map<string, number>();
      day.set(increment.field, (day.get(increment.field) ?? 0) + increment.by);
      this.days.set(date, day);
      const oldest = usageDates(USAGE_RETENTION_DAYS, this.clock()).at(-1)!;
      for (const stored of this.days.keys()) if (stored < oldest) this.days.delete(stored);
    }
    return Promise.resolve();
  }

  read(days: number, now = this.clock()): Promise<UsageDay[]> {
    return Promise.resolve(
      usageDates(days, now).map((date) =>
        parseUsageDay(date, Object.fromEntries(this.days.get(date) ?? [])),
      ),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export const usageKey = (date: string): string => `sera:usage:${date}`;

export interface UsagePipeline {
  hincrby(key: string, field: string, by: number): UsagePipeline;
  expire(key: string, seconds: number): UsagePipeline;
  exec(): Promise<unknown>;
}

export interface UsageRedis {
  multi(): UsagePipeline;
  hgetall(key: string): Promise<Record<string, string>>;
  quit(): Promise<unknown>;
}

export class RedisUsageCounter implements UsageCounter {
  constructor(
    private readonly redis: UsageRedis,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(event: UsageEvent): Promise<void> {
    const increment = usageField(event);
    if (!increment) return;
    const key = usageKey(this.clock().toISOString().slice(0, 10));
    try {
      await this.redis
        .multi()
        .hincrby(key, increment.field, increment.by)
        .expire(key, USAGE_RETENTION_DAYS * 86_400)
        .exec();
    } catch (error) {
      this.logger.warn({ err: error, field: increment.field }, 'usage count not recorded');
    }
  }

  async read(days: number, now = this.clock()): Promise<UsageDay[]> {
    return Promise.all(
      usageDates(days, now).map(async (date) =>
        parseUsageDay(date, await this.redis.hgetall(usageKey(date))),
      ),
    );
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

export function totalUsage(days: readonly UsageDay[]): Record<string, SourceUsage> {
  const totals: Record<string, Tally> = {};
  for (const day of days) {
    for (const [source, usage] of Object.entries(day.sources)) {
      const total = (totals[source] ??= emptyTally());
      total.bytes += usage.bytes;
      for (const kind of ['resolves', 'downloads'] as const) {
        total[kind].ok += usage[kind].ok;
        for (const [code, count] of Object.entries(usage[kind].failed)) {
          total[kind].failed[code] = (total[kind].failed[code] ?? 0) + count;
        }
      }
    }
  }
  return totals;
}
