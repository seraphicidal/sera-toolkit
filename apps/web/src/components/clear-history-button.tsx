'use client';

import { useEffect, useRef, useState } from 'react';
import { clearHistory } from '@/lib/history';

export function ClearHistoryButton({
  label = 'Clear local history',
  className,
  onCleared,
}: {
  readonly label?: string;
  readonly className?: string;
  readonly onCleared?: () => void;
}) {
  const [cleared, setCleared] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const handleClick = () => {
    clearHistory();
    setCleared(true);
    onCleared?.();
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCleared(false), 2500);
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
        <span
          role="status"
          aria-live="polite"
          className="text-xs font-medium text-[var(--color-success)]"
        >
          Local history wiped
        </span>
      )}
    </div>
  );
}
