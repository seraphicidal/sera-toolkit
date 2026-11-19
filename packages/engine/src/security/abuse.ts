import type { ErrorCode } from '@sera/contracts/types';
import { seraError } from '../errors.js';

const SUSPICIOUS_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INVALID_URL',
  'BLOCKED_ADDRESS',
  'UNSUPPORTED_SOURCE',
  'EXPIRED',
  'NOT_FOUND',
]);

export function countsAsAbuse(code: ErrorCode): boolean {
  return SUSPICIOUS_CODES.has(code);
}

export interface AbuseGuardOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  readonly maxTracked?: number;
}

interface Entry {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

const DEFAULTS = {
  maxFailures: 12,
  windowMs: 5 * 60_000,
  cooldownMs: 5 * 60_000,
  maxTracked: 10_000,
} as const;

const SWEEP_BATCH = 32;

export class AbuseGuard {
  private readonly watching = new Map<string, Entry>();
  private readonly blocked = new Map<string, Entry>();
  private readonly options: Required<AbuseGuardOptions>;
  private watchCursor: IterableIterator<[string, Entry]> | undefined;
  private blockedCursor: IterableIterator<[string, Entry]> | undefined;

  constructor(options: AbuseGuardOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  assertAllowed(clientKey: string, now = Date.now()): void {
    const entry = this.blocked.get(clientKey);
    if (!entry) return;
    if (entry.blockedUntil <= now) {
      this.blocked.delete(clientKey);
      return;
    }

    throw seraError('RATE_LIMITED', {
      message: "You're downloading too quickly.",
      hint: 'Please wait a moment before starting another download.',
      detail: `cooldown for ${Math.ceil((entry.blockedUntil - now) / 1000)}s`,
    });
  }

  recordFailure(clientKey: string, code?: ErrorCode, now = Date.now()): void {
    if (code !== undefined && !countsAsAbuse(code)) return;

    const existingBlocked = this.blocked.get(clientKey);
    if (existingBlocked && existingBlocked.blockedUntil > now) {
      this.blocked.delete(clientKey);
      this.blocked.set(clientKey, existingBlocked);
      return;
    }
    if (existingBlocked) {
      this.blocked.delete(clientKey);
    }

    const existing = this.watching.get(clientKey);
    const entry: Entry =
      existing && now - existing.windowStartedAt <= this.options.windowMs
        ? existing
        : {
            failures: 0,
            windowStartedAt: now,
            blockedUntil: 0,
          };

    entry.failures += 1;
    if (entry.failures >= this.options.maxFailures) {
      entry.blockedUntil = now + this.options.cooldownMs;
      entry.failures = 0;
      entry.windowStartedAt = now;
      this.watching.delete(clientKey);
      this.blocked.delete(clientKey);
      this.blocked.set(clientKey, entry);
    } else {
      this.watching.delete(clientKey);
      this.watching.set(clientKey, entry);
    }
    this.evict(now);
  }

  recordSuccess(clientKey: string, now = Date.now()): void {
    const blocked = this.blocked.get(clientKey);
    if (blocked && blocked.blockedUntil > now) return;
    if (blocked) this.blocked.delete(clientKey);

    const entry = this.watching.get(clientKey);
    if (!entry) return;
    entry.failures = Math.max(0, entry.failures - 1);
    if (entry.failures === 0) {
      this.watching.delete(clientKey);
    } else {
      this.watching.delete(clientKey);
      this.watching.set(clientKey, entry);
    }
  }

  get size(): number {
    return this.watching.size + this.blocked.size;
  }

  private sweepExpired(now: number): void {
    if (this.watching.size > 0) {
      this.watchCursor ??= this.watching.entries();
      for (let i = 0; i < SWEEP_BATCH; i += 1) {
        const next = this.watchCursor.next();
        if (next.done) {
          this.watchCursor = undefined;
          break;
        }
        if (now - next.value[1].windowStartedAt > this.options.windowMs) {
          this.watching.delete(next.value[0]);
        }
      }
    }
    if (this.blocked.size > 0) {
      this.blockedCursor ??= this.blocked.entries();
      for (let i = 0; i < SWEEP_BATCH; i += 1) {
        const next = this.blockedCursor.next();
        if (next.done) {
          this.blockedCursor = undefined;
          break;
        }
        if (next.value[1].blockedUntil <= now) {
          this.blocked.delete(next.value[0]);
        }
      }
    }
  }

  private evict(now: number): void {
    if (this.size <= this.options.maxTracked) return;
    this.sweepExpired(now);
    while (this.size > this.options.maxTracked && this.watching.size > 0) {
      const oldest = this.watching.keys().next();
      if (oldest.done) break;
      this.watching.delete(oldest.value);
    }
    while (this.size > this.options.maxTracked && this.blocked.size > 0) {
      const oldest = this.blocked.keys().next();
      if (oldest.done) break;
      this.blocked.delete(oldest.value);
    }
  }
}
