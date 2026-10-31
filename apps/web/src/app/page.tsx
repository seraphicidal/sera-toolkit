'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Downloader } from '@/components/downloader';
import { ShareHint } from '@/components/share-hint';
import { Wordmark } from '@/components/wordmark';
import { Workstation } from '@/components/workstation';

export default function HomePage() {
  const [mode, setMode] = useState<'workstation' | 'classic'>('workstation');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('sera-view-mode');
      if (saved === 'classic' || saved === 'workstation') {
        setMode(saved);
      }
    } catch {}
    setMounted(true);
  }, []);

  const toggleMode = () => {
    const next = mode === 'workstation' ? 'classic' : 'workstation';
    setMode(next);
    try {
      localStorage.setItem('sera-view-mode', next);
    } catch {}
  };

  if (!mounted || mode === 'workstation') {
    return <Workstation onToggleView={toggleMode} />;
  }

  return (
    <div className="flex flex-1 flex-col justify-center pt-6 pb-14 sm:pt-10">
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={toggleMode}
          className="cursor-pointer border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-1 font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          [ WORKSTATION // REV.04 ]
        </button>
      </div>

      <div className="mb-8 text-center sm:mb-10">
        <h1 className="mb-2.5">
          <Wordmark size="lg" />
        </h1>
        <p className="text-[0.9375rem] text-balance text-[var(--color-ink-muted)]">
          One link in, whatever media is available out.
        </p>
      </div>

      <Downloader />
      <ShareHint />

      <p className="mt-6 text-center text-[0.8125rem] text-[var(--color-ink-faint)]">
        Instagram photo post or carousel?{' '}
        <Link
          href="/import"
          className="font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          Send it from your browser →
        </Link>
      </p>
    </div>
  );
}
