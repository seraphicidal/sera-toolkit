'use client';

import { useEffect, useState } from 'react';
import {
  clearHistory,
  HISTORY_EVENT,
  HISTORY_KEY,
  isExpired,
  readHistory,
  timeAgo,
  type HistoryEntry,
} from '@/lib/history';

/** How often relative times and expiry are brought up to date while the list is shown. */
const TICK_MS = 30_000;

/**
 * The last few downloads made in this browser (`lib/history.ts`).
 *
 * Nothing here comes from the server: the list is this browser's own, and an entry outlives
 * the files it points at. Once they are deleted the entry says so, and offers to read the
 * original link again rather than a link that would 404.
 */
export function RecentDownloads({ onAgain }: { readonly onAgain: (url: string) => void }) {
  // Empty until mounted: the server has no history, and the first render must match it.
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      setEntries(readHistory());
      setNow(Date.now());
    };
    // Another tab's changes arrive as `storage`; this tab's own as HISTORY_EVENT.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === HISTORY_KEY) refresh();
    };
    refresh();
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    window.addEventListener(HISTORY_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      window.removeEventListener(HISTORY_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (!entries.length) return null;

  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="recent-heading"
          className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
        >
          Recent downloads
        </h2>
        <button
          type="button"
          onClick={() => clearHistory()}
          className="cursor-pointer rounded-md text-xs text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
        >
          Clear history
        </button>
      </div>
      <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--color-line)] bg-[var(--color-surface)]">
        {entries.map((entry) => {
          const expired = isExpired(entry, now);
          return (
            <li key={entry.jobId} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.875rem]" title={entry.title}>
                  {entry.title}
                </p>
                <p className="text-xs text-[var(--color-ink-faint)]">
                  {entry.source} · {timeAgo(entry.savedAt, now)}
                  {expired && ' · expired'}
                </p>
              </div>
              {expired ? (
                <button
                  type="button"
                  onClick={() => onAgain(entry.url)}
                  aria-label={`Download again: ${entry.title}`}
                  className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-line)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-sunken)]"
                >
                  Download again
                </button>
              ) : (
                <a
                  href={entry.downloadPath}
                  download={entry.filename}
                  aria-label={`Download ${entry.filename}`}
                  className="shrink-0 rounded-lg bg-[var(--color-accent)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
                >
                  Download
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
