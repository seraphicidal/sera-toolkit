'use client';

import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import {
  describeHealth,
  initialHealth,
  isHealthReport,
  nextHealth,
  showsLight,
  summarizeHealth,
  type HealthLight,
} from '@/lib/health';

const POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const DOT: Record<HealthLight, string> = {
  unknown: 'bg-[var(--color-line-strong)]',
  green: 'bg-[var(--color-success)]',
  amber: 'bg-[var(--color-warning)]',
  red: 'bg-[var(--color-danger)]',
};

async function observe() {
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    return isHealthReport(body) ? { ok: true as const, report: body } : { ok: false as const };
  } catch {
    return { ok: false as const };
  }
}

export function HealthIndicator() {
  const [state, dispatch] = useReducer(nextHealth, initialHealth);
  const [open, setOpen] = useState(false);
  const lastPoll = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const poll = useCallback(async () => {
    lastPoll.current = Date.now();
    dispatch(await observe());
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.visibilityState !== 'visible') return;
      if (Date.now() - lastPoll.current >= POLL_MS) void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
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
  const status = summary.slice(summary.indexOf(':') + 2);
  const headline = status.charAt(0).toUpperCase() + status.slice(1);
  const lines = describeHealth(state);

  return (
    <div ref={root} className="sm:relative">
      <button
        type="button"
        aria-label={summary}
        title={summary}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="grid size-8 cursor-pointer place-items-center rounded-full transition-colors hover:bg-[var(--color-sunken)]"
      >
        <span
          aria-hidden
          className={cx(
            'block size-2.5 rounded-full transition-[background-color,opacity] duration-300',
            DOT[state.light],
            !showsLight(state) && 'opacity-0',
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
          <p className="px-1 pb-2 font-medium">{headline}</p>
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
