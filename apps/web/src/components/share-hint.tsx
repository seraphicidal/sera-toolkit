'use client';

import { useEffect, useState } from 'react';
import { isInstalledApp } from '@/lib/share';

export function ShareHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(!isInstalledApp(window));
  }, []);

  if (!show) return null;
  return (
    <p className="mt-3 text-center text-xs text-[var(--color-ink-faint)]">
      On a phone, add SERA to your home screen to share links to it from any app.
    </p>
  );
}
