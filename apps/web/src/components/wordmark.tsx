import { cx } from '@/lib/format';

/**
 * The SERA.toolkit wordmark.
 *
 * Set in type rather than drawn as a logo: the name carries the weight, the tight
 * tracking on `SERA` gives it a mark-like density, and the muted `.toolkit` reads as the
 * qualifier it is. It stays legible at 14px in a footer and at 40px on the homepage
 * without a second asset, and it inherits the theme's ink colour automatically.
 */
export function Wordmark({
  size = 'md',
  className,
}: {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}) {
  const scale = {
    sm: 'text-[0.9375rem]',
    md: 'text-xl',
    lg: 'text-[2rem] sm:text-[2.5rem]',
  }[size];

  return (
    <span className={cx('inline-flex items-baseline font-semibold select-none', scale, className)}>
      <span className="tracking-[-0.055em] text-[var(--color-ink)]">SERA</span>
      <span className="font-normal tracking-[-0.02em] text-[var(--color-ink-faint)]">.toolkit</span>
    </span>
  );
}
