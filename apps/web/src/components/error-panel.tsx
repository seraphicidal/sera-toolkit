'use client';

import type { JobError } from '@sera/contracts/types';
import { AlertIcon } from './icons';

export interface ErrorAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
}

/**
 * A failure, explained.
 *
 * One sentence about what happened, one about what to do, and the actions that actually
 * apply — retry is only offered when retrying could plausibly work, because a "Try
 * again" button on a private post just wastes someone's time twice. Nothing technical
 * reaches this component; the server keeps that.
 */
export function ErrorPanel({
  error,
  actions,
}: {
  readonly error: JobError;
  readonly actions: readonly ErrorAction[];
}) {
  return (
    <section
      role="alert"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-danger)]/35 bg-[var(--color-danger-wash)] p-5"
    >
      <div className="flex gap-3">
        <AlertIcon size={19} className="mt-px shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.9375rem] font-medium text-balance text-[var(--color-ink)]">
            {error.message}
          </p>
          {error.hint && (
            <p className="mt-1 text-[0.8125rem] text-[var(--color-ink-muted)]">{error.hint}</p>
          )}

          {actions.length > 0 && (
            <div className="mt-3.5 flex flex-wrap gap-2">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className={
                    action.primary
                      ? 'cursor-pointer rounded-lg bg-[var(--color-ink)] px-3.5 py-2 text-[0.8125rem] font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-85'
                      : 'cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3.5 py-2 text-[0.8125rem] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)]'
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
