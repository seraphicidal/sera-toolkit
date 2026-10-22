'use client';

import { useState } from 'react';
import { clearHistory } from '@/lib/history';

export function ClearHistoryButton({
  label = 'Clear local history',
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}) {
  const [cleared, setCleared] = useState(false);

  const handleClick = () => {
    clearHistory();
    setCleared(true);
    setTimeout(() => setCleared(false), 2500);
  };

  return (
    <div className="inline-flex items-center gap-2.5">
      <button
        type="button"
        onClick={handleClick}
        className={
          className ??
          'cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]'
        }
      >
        {cleared ? 'History cleared' : label}
      </button>
      {cleared && (
        <span role="status" aria-live="polite" className="text-xs text-[var(--color-success)]">
          Local history wiped
        </span>
      )}
    </div>
  );
}
