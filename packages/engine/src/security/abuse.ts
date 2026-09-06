import type { ErrorCode } from '@sera/contracts/types';
import { seraError } from '../errors.js';

/**
 * The failures that suggest probing rather than ordinary use.
 *
 * This distinction is the whole point. A malformed URL, a blocked address or a forged
 * handle is something a person almost never produces by accident, so it counts. A
 * private post, a deleted video or a geo-block is a completely normal thing to paste,
 * and counting those would cool down exactly the users who are trying hardest to use the
 * service. Everything not listed here is treated as an ordinary outcome.
 */
const SUSPICIOUS_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INVALID_URL',
  'BLOCKED_ADDRESS',
  'UNSUPPORTED_SOURCE',
  // A handle that does not verify was either tampered with or replayed long after it
  // expired; neither happens through the interface.
  'EXPIRED',
  'NOT_FOUND',
]);

/** Whether a failure with this code should count toward a cooldown. */
export function countsAsAbuse(code: ErrorCode): boolean {
  return SUSPICIOUS_CODES.has(code);
}

/**
 * A cooldown for clients that keep failing.
 *
 * Plain rate limiting counts every request the same, which means probing a service with
 * garbage costs an attacker exactly as much as using it properly. Failures are the
 * cheaper signal to act on: a person who pastes a bad link occasionally never notices
 * this, while something enumerating URLs hits the cooldown quickly and stops consuming
 * extractor time.
 *
 * Deliberately in-memory and per-instance. It is a speed bump, not an access control,
 * and coordinating it through Redis would add a dependency and a failure mode to
 * something whose worst case is that an abusive client gets throttled slightly later.
 */

export interface AbuseGuardOptions {
  /** Failures within the window before a client is put on cooldown. */
  readonly maxFailures?: number;
  /** How long failures are remembered. */
  readonly windowMs?: number;
  /** How long a client stays on cooldown once tripped. */
  readonly cooldownMs?: number;
  /** Upper bound on tracked clients, so the map cannot grow without limit. */
  readonly maxTracked?: number;
}

interface Entry {
  failures: number;
  /** When the current counting window began. */
  windowStartedAt: number;
  /** Epoch millis until which the client is refused, or 0. */
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

  /** Throws `RATE_LIMITED` when the client is on cooldown. */
  assertAllowed(clientKey: string, now = Date.now()): void {
    const entry = this.entries.get(clientKey);
    if (!entry || entry.blockedUntil <= now) return;

    throw seraError('RATE_LIMITED', {
      message: "You're downloading too quickly.",
      hint: 'Please wait a moment before starting another download.',
      // Seconds remaining is server-side detail; the user gets the sentence above.
      detail: `cooldown for ${Math.ceil((entry.blockedUntil - now) / 1000)}s`,
    });
  }

  /**
   * Records a failure, tripping the cooldown once the threshold is crossed.
   *
   * Pass the error code so ordinary outcomes — a private post, a deleted video — are
   * ignored. Omitting it counts the failure unconditionally.
   */
  recordFailure(clientKey: string, code?: ErrorCode, now = Date.now()): void {
    if (code !== undefined && !countsAsAbuse(code)) return;

    const existing = this.entries.get(clientKey);
    // A new client, or one whose window has lapsed, starts a fresh count — but the
    // threshold is still checked, so a limit of one failure means exactly that.
    const entry: Entry =
      existing && now - existing.windowStartedAt <= this.options.windowMs
        ? existing
        : { failures: 0, windowStartedAt: now, blockedUntil: 0 };

    entry.failures += 1;
    if (entry.failures >= this.options.maxFailures) {
      entry.blockedUntil = now + this.options.cooldownMs;
      // Reset the counter so the cooldown is not extended by requests made during it.
      entry.failures = 0;
      entry.windowStartedAt = now;
    }

    this.entries.set(clientKey, entry);
    this.evict(now);
  }

  /**
   * Records a success, which forgives one failure.
   *
   * Without this, a heavy legitimate user accumulates failures across a long session and
   * eventually trips a limit meant for abuse.
   */
  recordSuccess(clientKey: string): void {
    const entry = this.entries.get(clientKey);
    if (!entry || entry.blockedUntil) return;
    entry.failures = Math.max(0, entry.failures - 1);
    if (entry.failures === 0) this.entries.delete(clientKey);
  }

  /** Number of clients currently tracked. For the health report. */
  get size(): number {
    return this.entries.size;
  }

  /** Drops expired entries, and the oldest ones if the map is still over its bound. */
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
