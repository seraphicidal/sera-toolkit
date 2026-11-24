const SWEEP_BATCH = 16;

export interface TtlCacheOptions<V> {
  readonly maxBytes?: number;
  readonly sizeOf?: (value: V) => number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number; bytes: number }>();
  private sweepCursor:
    IterableIterator<[string, { value: V; expiresAt: number; bytes: number }]> | undefined;
  private readonly maxBytes: number | undefined;
  private readonly sizeOf: ((value: V) => number) | undefined;
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    options: TtlCacheOptions<V> = {},
  ) {
    this.maxBytes = options.maxBytes;
    this.sizeOf = options.sizeOf;
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.removeEntry(key, entry.bytes);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    const existing = this.entries.get(key);
    if (existing) this.removeEntry(key, existing.bytes);
    const bytes = this.sizeOf ? Math.max(0, this.sizeOf(value)) : 0;
    if (this.maxBytes !== undefined && bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs, bytes });
    this.totalBytes += bytes;
    this.evict(now);
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing) this.removeEntry(key, existing.bytes);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.sweepCursor = undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private removeEntry(key: string, bytes: number): void {
    if (this.entries.delete(key)) {
      this.totalBytes = Math.max(0, this.totalBytes - bytes);
    }
  }

  private evict(now: number): void {
    if (this.entries.size > 0) {
      this.sweepCursor ??= this.entries.entries();
      for (let i = 0; i < SWEEP_BATCH; i += 1) {
        const next = this.sweepCursor.next();
        if (next.done) {
          this.sweepCursor = undefined;
          break;
        }
        const [key, entry] = next.value;
        if (entry.expiresAt <= now) this.removeEntry(key, entry.bytes);
      }
    }
    while (
      this.entries.size > this.maxEntries ||
      (this.maxBytes !== undefined && this.totalBytes > this.maxBytes)
    ) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      this.removeEntry(oldest.value[0], oldest.value[1].bytes);
    }
  }
}
