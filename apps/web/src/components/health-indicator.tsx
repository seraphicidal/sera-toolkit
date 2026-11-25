'use client';

import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { createTimeoutSignal } from '@/lib/abort';
import { cx } from '@/lib/format';
import {
  describeHealth,
  headlineHealth,
  initialHealth,
  isHealthReport,
  nextHealth,
  showsLight,
  summarizeHealth,
  type HealthLight,
} from '@/lib/health';

const POLL_MS = 60_000;
const INITIAL_RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

const DOT: Record<HealthLight, string> = {
  unknown: 'bg-[var(--color-line-strong)]',
  green: 'bg-[var(--color-success)]',
  amber: 'bg-[var(--color-warning)]',
  red: 'bg-[var(--color-danger)]',
};

async function observe(signal: AbortSignal) {
  const timeout = createTimeoutSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      signal: timeout.signal,
    });
    const body: unknown = await response.json();
    return isHealthReport(body) ? { ok: true as const, report: body } : { ok: false as const };
  } catch {
    return { ok: false as const };
  } finally {
    timeout.cleanup();
  }
}

export function HealthIndicator() {
  const [state, dispatch] = useReducer(nextHealth, initialHealth);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastPoll = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const seqRef = useRef(0);
  const panelId = useId();

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    lastPoll.current = Date.now();
    setRefreshing(true);
    try {
      const observation = await observe(controller.signal);
      if (controller.signal.aborted || seq !== seqRef.current) return;
      dispatch(observation);
    } finally {
      if (seq === seqRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.visibilityState !== 'visible') return;
      if (Date.now() - lastPoll.current >= POLL_MS) void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  useEffect(() => {
    if (state.light !== 'unknown' || state.failures !== 1) return undefined;
    const retryTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') void poll();
    }, INITIAL_RETRY_MS);
    return () => clearTimeout(retryTimer);
  }, [state.light, state.failures, poll]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const summary = summarizeHealth(state);
  const headline = headlineHealth(state);
  const lines = describeHealth(state);

  return (
    <div
      ref={root}
      className="sm:relative"
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={summary}
        title={summary}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="grid size-9 cursor-pointer place-items-center rounded-full transition-colors hover:bg-[var(--color-sunken)]"
      >
        <span
          aria-hidden
          className={cx(
            'block size-2.5 rounded-full transition-[background-color,opacity] duration-300',
            DOT[state.light],
            !showsLight(state) && 'opacity-40',
          )}
        />
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Service status"
          className="absolute top-full right-0 left-0 z-40 mt-2 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-sm shadow-[var(--shadow-lift)] sm:left-auto sm:w-72"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <p className="font-medium">{headline}</p>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void poll()}
              className="cursor-pointer rounded-md px-2 py-0.5 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-sunken)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? 'Checking…' : 'Refresh'}
            </button>
          </div>
          <ul className="space-y-1.5">
            {lines.map((line) => (
              <li key={line.label} className="flex items-start gap-2.5 px-1">
                <span
                  aria-hidden
                  className={cx(
                    'mt-1.5 block size-2 shrink-0 rounded-full',
                    line.ok ? DOT.green : DOT.red,
                  )}
                />
                <span className="min-w-0">
                  <span className="block">{line.label}</span>
                  <span className="block text-xs text-[var(--color-ink-muted)]">
                    <span className="sr-only">{line.ok ? 'Working: ' : 'Not working: '}</span>
                    {line.note}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
