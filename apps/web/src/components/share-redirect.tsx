'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { homeWithUrl, sharedUrl } from '@/lib/share';

export function ShareRedirect() {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = sharedUrl({
      url: params.get('url'),
      text: params.get('text'),
      title: params.get('title'),
    });
    if (url) window.location.replace(homeWithUrl(url));
    else setMissing(true);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-14 text-center">
      {missing ? (
        <>
          <p className="text-[0.9375rem]">There was no link in what was shared.</p>
          <Link
            href="/"
            className="text-sm font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
          >
            Paste one instead →
          </Link>
        </>
      ) : (
        <p className="text-sm text-[var(--color-ink-muted)]" role="status">
          Opening the shared link…
        </p>
      )}
    </div>
  );
}
