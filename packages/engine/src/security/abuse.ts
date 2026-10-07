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

export class AbuseGuard {
  private readonly entries = new Map<string, Entry>();
  private readonly options: Required<AbuseGuardOptions>;

  constructor(options: AbuseGuardOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  assertAllowed(clientKey: string, now = Date.now()): void {
    const entry = this.entries.get(clientKey);
    if (!entry || entry.blockedUntil <= now) return;

    throw seraError('RATE_LIMITED', {
      message: "You're downloading too quickly.",
      hint: 'Please wait a moment before starting another download.',
      detail: `cooldown for ${Math.ceil((entry.blockedUntil - now) / 1000)}s`,
    });
  }

  recordFailure(clientKey: string, code?: ErrorCode, now = Date.now()): void {
    if (code !== undefined && !countsAsAbuse(code)) return;

    const existing = this.entries.get(clientKey);
    const entry: Entry =
      existing && now - existing.windowStartedAt <= this.options.windowMs
        ? existing
        : { failures: 0, windowStartedAt: now, blockedUntil: 0 };

    entry.failures += 1;
    if (entry.failures >= this.options.maxFailures) {
      entry.blockedUntil = now + this.options.cooldownMs;
      entry.failures = 0;
      entry.windowStartedAt = now;
    }

    this.entries.set(clientKey, entry);
    this.evict(now);
  }

  recordSuccess(clientKey: string): void {
    const entry = this.entries.get(clientKey);
    if (!entry || entry.blockedUntil) return;
    entry.failures = Math.max(0, entry.failures - 1);
    if (entry.failures === 0) this.entries.delete(clientKey);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    if (this.entries.size <= this.options.maxTracked) return;
    for (const [key, entry] of this.entries) {
      const stale =
        now - entry.windowStartedAt > this.options.windowMs && entry.blockedUntil <= now;
      if (stale) this.entries.delete(key);
    }
    while (this.entries.size > this.options.maxTracked) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
