import { describe, expect, it } from 'vitest';
import { QUEUE_NAME } from './redis.js';

/**
 * Naming rules for the Redis backend.
 *
 * These look trivial, and one of them shipped broken anyway: the queue was originally
 * `sera:jobs`, which BullMQ rejects in its constructor. Nothing caught it because the
 * Redis driver is the one path the offline suite cannot exercise, so the failure surfaced
 * as a container restart loop on a freshly provisioned server.
 *
 * A colon check is a poor substitute for running against a real Redis, but it is the part
 * of that failure that can be asserted without one.
 */
describe('queue naming', () => {
  it('has no colon, which BullMQ rejects', () => {
    // BullMQ builds its own key namespace by joining on ':', so a colon in the queue
    // name would collide with its internal layout. It throws from `new Queue(...)`.
    expect(QUEUE_NAME).not.toContain(':');
  });

  it('is a plain identifier', () => {
    // Whitespace and wildcards are equally unwelcome in something used to build keys.
    expect(QUEUE_NAME).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('is still namespaced to this application', () => {
    // The queue shares a Redis instance with the job records; a generic name like
    // "jobs" would collide with anything else pointed at the same server.
    expect(QUEUE_NAME.startsWith('sera')).toBe(true);
  });
});
