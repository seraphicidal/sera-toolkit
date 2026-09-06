'use client';

import { useEffect, useState } from 'react';
import type { Job } from '@sera/contracts/types';
import { CheckIcon, DownloadIcon } from './icons';
import { formatBytes, pluralize } from '@/lib/format';

/**
 * The finished state.
 *
 * The download starts on its own, because the user already asked for it — clicking a
 * second button to receive a file they just waited for is a step that exists only to
 * make the interface feel busy. The button remains for anyone whose browser blocked the
 * automatic navigation, and the individual files stay listed so a carousel can be taken
 * apart rather than unzipped.
 */
export function ResultPanel({ job, onReset }: { readonly job: Job; readonly onReset: () => void }) {
  const result = job.result;
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!result || started) return;
    setStarted(true);
    // A same-origin navigation to a Content-Disposition: attachment response. No anchor
    // synthesis, no blob in memory: the file streams straight from the server to disk.
    window.location.assign(result.downloadPath);
  }, [result, started]);

  if (!result) return null;

  const expires = new Date(result.expiresAt);
  const minutesLeft = Math.max(0, Math.round((expires.getTime() - Date.now()) / 60_000));

  return (
    <section
      aria-label="Download ready"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-success)]/12 text-[var(--color-success)]">
          <CheckIcon size={16} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] font-medium text-[var(--color-ink)]">Ready</h2>
          <p className="truncate text-[0.8125rem] text-[var(--color-ink-muted)]">
            {result.filename} · {formatBytes(result.sizeBytes)}
          </p>
        </div>
      </div>

      <a
        href={result.downloadPath}
        download
        className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)] text-[0.9375rem] font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
      >
        <DownloadIcon size={17} />
        {result.isArchive ? 'Download ZIP' : 'Download'}
      </a>

      {result.files && result.files.length > 1 && (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]">
            <span className="transition-transform group-open:rotate-90">›</span>
            {pluralize(result.files.length, 'file')} individually
          </summary>
          <ul className="mt-2 flex flex-col gap-1 border-l border-[var(--color-line)] pl-3">
            {result.files.map((file) => (
              <li key={file.name}>
                <a
                  href={file.downloadPath}
                  download
                  className="flex items-center justify-between gap-3 rounded-md py-1 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-accent)]"
                >
                  <span className="truncate">{file.name}</span>
                  <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--color-line)] pt-3">
        <p className="text-xs text-[var(--color-ink-faint)]">
          {minutesLeft > 0
            ? `Deleted from the server in about ${pluralize(minutesLeft, 'minute')}.`
            : 'Deleted from the server shortly.'}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 cursor-pointer rounded-md text-[0.8125rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          New link
        </button>
      </div>
    </section>
  );
}
