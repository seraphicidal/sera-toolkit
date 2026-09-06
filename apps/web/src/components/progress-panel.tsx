'use client';

import type { Job } from '@sera/contracts/types';
import { CheckIcon, SpinnerIcon } from './icons';
import { cx, formatBytes, formatEta, formatSpeed } from '@/lib/format';

/**
 * What is happening, in numbers.
 *
 * A percentage on its own tells someone almost nothing about whether to keep waiting.
 * Speed and ETA are what answer that, so they are given equal weight and set in tabular
 * figures so the row does not twitch as the digits change. When the server stops
 * reporting a number the slot collapses rather than showing a stale one.
 */
export function ProgressPanel({
  job,
  onCancel,
}: {
  readonly job: Job;
  readonly onCancel: () => void;
}) {
  const { progress } = job;
  const percent = Math.max(0, Math.min(100, progress.percent));
  const speed = formatSpeed(progress.speedBytesPerSecond);
  const eta = formatEta(progress.etaSeconds);
  const indeterminate = percent < 0.5 && job.state === 'queued';

  return (
    <section
      aria-label="Download progress"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <SpinnerIcon size={17} className="shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <p className="truncate text-[0.9375rem] font-medium text-[var(--color-ink)]">
              {job.step}
            </p>
            {progress.totalFiles && progress.totalFiles > 1 && (
              <p className="text-[0.8125rem] text-[var(--color-ink-muted)]">
                File {progress.currentFile ?? 1} of {progress.totalFiles}
              </p>
            )}
          </div>
        </div>

        <span className="tabular shrink-0 text-lg font-medium text-[var(--color-ink)]">
          {percent.toFixed(0)}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(percent)}
        aria-valuetext={`${Math.round(percent)} percent, ${job.step}`}
        className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-sunken)]"
      >
        <div
          className={cx(
            'h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out',
            indeterminate && 'shimmer',
          )}
          style={{ width: `${Math.max(percent, indeterminate ? 100 : 1.5)}%` }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-4 text-[0.8125rem] text-[var(--color-ink-muted)]">
        <span className="tabular flex flex-wrap items-center gap-x-3 gap-y-1">
          {progress.bytesDownloaded !== undefined && progress.bytesDownloaded > 0 && (
            <span>
              {formatBytes(progress.bytesDownloaded)}
              {progress.bytesTotal ? ` of ${formatBytes(progress.bytesTotal)}` : ''}
            </span>
          )}
          {speed && <span>{speed}</span>}
          {eta && <span>ETA {eta}</span>}
        </span>

        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 cursor-pointer rounded-md text-[0.8125rem] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-danger)]"
        >
          Cancel
        </button>
      </div>

      {/* Announced to screen readers on each step change, not on each percentage tick. */}
      <p className="sr-only" role="status" aria-live="polite">
        {job.step}
      </p>
    </section>
  );
}

/** The completed-step marker used above the active step in multi-stage jobs. */
export function CompletedStep({ label }: { readonly label: string }) {
  return (
    <p className="flex items-center gap-2 text-[0.8125rem] text-[var(--color-ink-muted)]">
      <CheckIcon size={15} className="text-[var(--color-success)]" />
      {label}
    </p>
  );
}
