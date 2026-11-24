import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <p className="font-mono text-xs font-medium tracking-widest text-[var(--color-ink-faint)] uppercase">
        404
      </p>
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
        Page not found
      </h1>
      <p className="max-w-md text-[0.9375rem] text-[var(--color-ink-muted)]">
        The page you requested does not exist or has moved.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
      >
        Back to SERA.toolkit
      </Link>
    </section>
  );
}
