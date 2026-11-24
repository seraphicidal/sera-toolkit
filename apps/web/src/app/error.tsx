'use client';

import Link from 'next/link';
import { AlertIcon } from '@/components/icons';

export default function GlobalError({
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <section
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-5 py-16 text-center"
    >
      <span className="grid size-12 place-items-center rounded-full bg-[var(--color-danger-wash)] text-[var(--color-danger)]">
        <AlertIcon size={24} />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)]">
          Something went wrong
        </h1>
        <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
          An unexpected error interrupted this page. Try reloading it or return to the toolkit.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          onClick={reset}
          className="cursor-pointer rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)]"
        >
          Back to SERA.toolkit
        </Link>
      </div>
    </section>
  );
}
