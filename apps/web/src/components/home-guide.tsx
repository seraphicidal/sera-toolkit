import type { ProviderSummary } from '@sera/contracts/types';
import { cx } from '@/lib/format';

/**
 * The two short sections under the form: what it works with, and how it works.
 *
 * Server-rendered from data the page already has, so they cost no request and no script.
 */

const STATUS: Record<ProviderSummary['status'], { dot: string; words: string }> = {
  ok: { dot: 'bg-[var(--color-success)]', words: 'working' },
  degraded: { dot: 'bg-[var(--color-warning)]', words: 'partly working' },
  unavailable: { dot: 'bg-[var(--color-danger)]', words: 'unavailable' },
};

export function SupportedSources({
  providers,
}: {
  readonly providers: readonly ProviderSummary[];
}) {
  if (!providers.length) return null;
  return (
    <section aria-labelledby="sources-heading" className="flex flex-col gap-2.5">
      <h2
        id="sources-heading"
        className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
      >
        Works with
      </h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[0.8125rem] text-[var(--color-ink-muted)]">
        {providers.map((provider) => {
          const status = STATUS[provider.status];
          return (
            <li key={provider.id} className="flex items-center gap-1.5">
              <span aria-hidden className={cx('block size-1.5 rounded-full', status.dot)} />
              {provider.label}
              {provider.status !== 'ok' && <span className="sr-only">({status.words})</span>}
            </li>
          );
        })}
        <li className="text-[var(--color-ink-faint)]">and most pages that publish their media</li>
      </ul>
    </section>
  );
}

export function HowItWorks({ retentionMinutes }: { readonly retentionMinutes?: number }) {
  const steps = [
    'Paste a link, or share it to SERA from another app.',
    'Pick the format and quality — only what the source really has.',
    retentionMinutes
      ? `Download. Files are deleted from the server after ${String(retentionMinutes)} minutes.`
      : 'Download. Files are deleted from the server shortly after.',
  ];
  return (
    <section aria-labelledby="how-heading" className="flex flex-col gap-2.5">
      <h2
        id="how-heading"
        className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
      >
        How it works
      </h2>
      <ol className="flex flex-col gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)]">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2.5">
            <span
              aria-hidden
              className="tabular grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)] text-[0.6875rem] font-medium text-[var(--color-ink)]"
            >
              {index + 1}
            </span>
            <span className="pt-px">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
