'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { isSafeDownloadPath, pluralize } from '@/lib/format';
import { ClearHistoryButton } from './clear-history-button';
import {
  HISTORY_EVENT,
  HISTORY_KEY,
  isExpired,
  readHistory,
  timeAgo,
  type HistoryEntry,
} from '@/lib/history';

const TICK_MS = 30_000;

export const RecentDownloads = memo(function RecentDownloads({
  onAgain,
  disabled = false,
}: {
  readonly onAgain: (url: string) => void;
  readonly disabled?: boolean;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [clearedNotice, setClearedNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const refresh = () => {
      const next = readHistory();
      setEntries(next);
      setNow(Date.now());
      if (next.length > 0) setClearedNotice(false);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === HISTORY_KEY) refresh();
    };
    refresh();
    window.addEventListener(HISTORY_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(HISTORY_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!entries.length) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.visibilityState !== 'visible') return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), TICK_MS);
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
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [entries.length]);

  const handleCleared = () => {
    setClearedNotice(true);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setClearedNotice(false), 3_000);
    const urlInput = document.getElementById('sera-url');
    if (urlInput instanceof HTMLElement) urlInput.focus();
  };

  if (!entries.length) {
    if (!clearedNotice) return null;
    return (
      <p
        role="status"
        aria-live="polite"
        className="rounded-[var(--radius-input)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3.5 py-2.5 text-center text-xs font-medium text-[var(--color-success)]"
      >
        Local download history cleared.
      </p>
    );
  }

  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="recent-heading"
          className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
        >
          Recent downloads
        </h2>
        <ClearHistoryButton
          label="Clear history"
          onCleared={handleCleared}
          className="cursor-pointer rounded-md px-1.5 py-1 text-xs text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)] focus-visible:shadow-[var(--shadow-focus)]"
        />
      </div>
      <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--color-line)] bg-[var(--color-surface)]">
        {entries.map((entry) => {
          const expired = isExpired(entry, now);
          const canDownload = !expired && isSafeDownloadPath(entry.downloadPath);
          const individualFiles =
            !expired && !entry.isArchive && entry.files && entry.files.length > 1
              ? entry.files.filter((file) => isSafeDownloadPath(file.downloadPath))
              : undefined;
          return (
            <li key={entry.jobId} className="flex flex-col gap-2 px-3.5 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.875rem]" title={entry.title}>
                    {entry.title}
                  </p>
                  <p className="text-xs text-[var(--color-ink-faint)]">
                    {entry.source} · {timeAgo(entry.savedAt, now)}
                    {entry.fileCount && entry.fileCount > 1
                      ? ` · ${pluralize(entry.fileCount, 'file')}`
                      : ''}
                    {expired && ' · expired'}
                  </p>
                </div>
                {canDownload ? (
                  <a
                    href={entry.downloadPath}
                    download={entry.filename}
                    aria-label={`Download ${entry.filename}`}
                    className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
                  >
                    {individualFiles ? '1st file' : 'Download'}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAgain(entry.url)}
                    disabled={disabled}
                    aria-label={`Download again: ${entry.title}`}
                    className="inline-flex min-h-9 shrink-0 cursor-pointer items-center rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-sunken)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Download again
                  </button>
                )}
              </div>
              {individualFiles && individualFiles.length > 1 && (
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
                    <span className="transition-transform group-open:rotate-90">›</span>
                    All {pluralize(individualFiles.length, 'file')}
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1 border-l border-[var(--color-line)] pl-3">
                    {individualFiles.map((file) => (
                      <li key={file.downloadPath}>
                        <a
                          href={file.downloadPath}
                          download={file.name}
                          className="block truncate py-0.5 text-xs text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-accent)]"
                        >
                          {file.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
});
