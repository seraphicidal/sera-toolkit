'use client';

import type { Job } from '@sera/contracts/types';
import { CheckIcon, SpinnerIcon } from './icons';
import {
  cx,
  formatBytes,
  formatEta,
  formatSpeed,
  PIPELINE_STEPS,
  resolvePipelineStepIndex,
} from '@/lib/format';

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
  const activeStepIndex = resolvePipelineStepIndex(job.state, job.step);
  const activeStepLabel = PIPELINE_STEPS[activeStepIndex] ?? 'Resolving';

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
        role="status"
        aria-live="polite"
        aria-label={`Pipeline step: ${activeStepLabel}`}
        className="mt-4"
      >
        <ol className="grid grid-cols-5 gap-1.5" aria-label="Download pipeline steps">
          {PIPELINE_STEPS.map((stepName, index) => {
            const isCompleted = index < activeStepIndex;
            const isActive = index === activeStepIndex;
            const stepState = isCompleted ? 'completed' : isActive ? 'active' : 'upcoming';
            return (
              <li
                key={stepName}
                data-step-state={stepState}
                aria-current={isActive ? 'step' : undefined}
                className={cx(
                  'flex flex-col items-center gap-1 rounded-lg border px-1.5 py-1.5 text-center text-[0.6875rem] font-medium transition-colors',
                  isCompleted &&
                    'border-[var(--color-accent)]/40 bg-[var(--color-accent-wash)] text-[var(--color-accent)]',
                  isActive &&
                    'border-[var(--color-accent)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]',
                  !isCompleted &&
                    !isActive &&
                    'border-[var(--color-line)] bg-[var(--color-sunken)] text-[var(--color-ink-faint)]',
                )}
              >
                <span className="flex size-4 items-center justify-center rounded-full text-[0.625rem]">
                  {isCompleted ? <CheckIcon size={12} /> : index + 1}
                </span>
                <span className="w-full truncate">{stepName}</span>
              </li>
            );
          })}
        </ol>
        <span className="sr-only">
          Step {activeStepIndex + 1} of {PIPELINE_STEPS.length}: {activeStepLabel} — {job.step}
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
    </section>
  );
}
