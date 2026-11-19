'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from './wordmark';

export function HeaderHomeLink() {
  if (usePathname() === '/') return null;
  return (
    <Link
      href="/"
      className="rounded-md transition-opacity hover:opacity-70"
      aria-label="SERA.toolkit home"
    >
      <Wordmark size="sm" />
    </Link>
  );
}
