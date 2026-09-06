import { describe, expect, it } from 'vitest';
import { SeraError } from '../errors.js';
import { AbuseGuard, countsAsAbuse } from './abuse.js';

function blocked(guard: AbuseGuard, key: string, now?: number): boolean {
  try {
    guard.assertAllowed(key, now);
    return false;
  } catch (error) {
    return error instanceof SeraError && error.code === 'RATE_LIMITED';
  }
}

describe('AbuseGuard', () => {
  it('allows a client that has done nothing', () => {
    expect(blocked(new AbuseGuard(), 'fresh')).toBe(false);
  });

  it('allows failures below the threshold', () => {
    const guard = new AbuseGuard({ maxFailures: 5 });
    for (let i = 0; i < 4; i += 1) guard.recordFailure('a');
    expect(blocked(guard, 'a')).toBe(false);
  });

  it('trips a cooldown once the threshold is crossed', () => {
    const guard = new AbuseGuard({ maxFailures: 5 });
    for (let i = 0; i < 5; i += 1) guard.recordFailure('a');
    expect(blocked(guard, 'a')).toBe(true);
  });

  it('cools down only the offending client', () => {
    const guard = new AbuseGuard({ maxFailures: 3 });
    for (let i = 0; i < 3; i += 1) guard.recordFailure('noisy');
    expect(blocked(guard, 'noisy')).toBe(true);
    expect(blocked(guard, 'quiet')).toBe(false);
  });

  it('releases the client when the cooldown expires', () => {
    const start = 1_000_000;
    const guard = new AbuseGuard({ maxFailures: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i += 1) guard.recordFailure('a', undefined, start);

    expect(blocked(guard, 'a', start + 59_000)).toBe(true);
    expect(blocked(guard, 'a', start + 61_000)).toBe(false);
  });

  it('forgets failures once the window has passed', () => {
    const start = 1_000_000;
    const guard = new AbuseGuard({ maxFailures: 3, windowMs: 10_000 });
    guard.recordFailure('a', undefined, start);
    guard.recordFailure('a', undefined, start + 1_000);
    // Past the window: the counter restarts rather than carrying two failures forward.
    guard.recordFailure('a', undefined, start + 20_000);
    expect(blocked(guard, 'a', start + 20_000)).toBe(false);
  });

  it('lets a success forgive a failure, so heavy legitimate use never trips it', () => {
    const guard = new AbuseGuard({ maxFailures: 3 });
    guard.recordFailure('a');
    guard.recordFailure('a');
    guard.recordSuccess('a');
    guard.recordSuccess('a');
    guard.recordFailure('a');
    guard.recordFailure('a');
    expect(blocked(guard, 'a')).toBe(false);
  });

  it('does not extend a cooldown for requests made during it', () => {
    // Otherwise a client retrying on a timer could never get out.
    const start = 1_000_000;
    const guard = new AbuseGuard({ maxFailures: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i += 1) guard.recordFailure('a', undefined, start);
    for (let i = 0; i < 2; i += 1) guard.recordFailure('a', undefined, start + 10_000);
    expect(blocked(guard, 'a', start + 61_000)).toBe(false);
  });

  it('gives the user a sentence, not an implementation detail', () => {
    const guard = new AbuseGuard({ maxFailures: 1 });
    guard.recordFailure('a');
    try {
      guard.assertAllowed('a');
      throw new Error('expected a cooldown');
    } catch (error) {
      const sera = error as SeraError;
      expect(sera.message).toBe("You're downloading too quickly.");
      expect(sera.hint).toContain('wait a moment');
      // The remaining time is server-side only.
      expect(sera.toJobError()).not.toHaveProperty('detail');
    }
  });

  it('bounds how many clients it tracks', () => {
    const guard = new AbuseGuard({ maxTracked: 50, windowMs: 1 });
    for (let i = 0; i < 500; i += 1)
      guard.recordFailure(`client-${i}`, undefined, 1_000_000 + i * 10);
    expect(guard.size).toBeLessThanOrEqual(50);
  });
});

describe('what counts as abuse', () => {
  it('counts the codes a person does not produce by accident', () => {
    for (const code of [
      'INVALID_URL',
      'BLOCKED_ADDRESS',
      'UNSUPPORTED_SOURCE',
      'EXPIRED',
    ] as const) {
      expect(countsAsAbuse(code), code).toBe(true);
    }
  });

  it('ignores the ordinary outcomes of pasting a real link', () => {
    // Cooling someone down for pasting a private post would punish exactly the people
    // trying hardest to use the service.
    for (const code of [
      'PRIVATE_CONTENT',
      'LOGIN_REQUIRED',
      'MEDIA_UNAVAILABLE',
      'GEO_RESTRICTED',
      'AGE_RESTRICTED',
      'PROVIDER_UNAVAILABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
      'RATE_LIMITED',
      'TOO_LARGE',
    ] as const) {
      expect(countsAsAbuse(code), code).toBe(false);
    }
  });

  it('never trips on a run of ordinary failures', () => {
    const guard = new AbuseGuard({ maxFailures: 3 });
    for (let i = 0; i < 20; i += 1) guard.recordFailure('a', 'PRIVATE_CONTENT');
    expect(blocked(guard, 'a')).toBe(false);
  });

  it('still trips on a run of probing failures', () => {
    const guard = new AbuseGuard({ maxFailures: 3 });
    for (let i = 0; i < 3; i += 1) guard.recordFailure('a', 'BLOCKED_ADDRESS');
    expect(blocked(guard, 'a')).toBe(true);
  });
});
