import { cx } from '@/lib/format';

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
