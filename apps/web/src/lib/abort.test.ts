import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTimeoutSignal } from './abort';

describe('createTimeoutSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with TimeoutError when timeout elapses without aborting parent', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const handle = createTimeoutSignal(parent.signal, 500);

    expect(handle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);

    expect(handle.signal.aborted).toBe(true);
    expect((handle.signal.reason as Error | undefined)?.name).toBe('TimeoutError');
    expect(parent.signal.aborted).toBe(false);
    handle.cleanup();
  });

  it('propagates parent abort and clears pending timer', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const handle = createTimeoutSignal(parent.signal, 1_000);

    parent.abort('cancelled');
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('cancelled');

    vi.advanceTimersByTime(2_000);
    expect(handle.signal.reason).toBe('cancelled');
    handle.cleanup();
  });

  it('immediately reflects an already-aborted parent signal', () => {
    const parent = new AbortController();
    parent.abort('already-aborted');

    const handle = createTimeoutSignal(parent.signal, 1_000);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('already-aborted');
    handle.cleanup();
  });

  it('prevents timeout abort after cleanup is called', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const handle = createTimeoutSignal(parent.signal, 500);

    handle.cleanup();
    vi.advanceTimersByTime(1_000);

    expect(handle.signal.aborted).toBe(false);
  });
});
