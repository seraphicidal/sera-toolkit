const SWEEP_BATCH = 16;

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private sweepCursor: IterableIterator<[string, { value: V; expiresAt: number }]> | undefined;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.evict(now);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.sweepCursor = undefined;
  }

  get size(): number {
    return this.entries.size;
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
        if (entry.expiresAt <= now) this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
