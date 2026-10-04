'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from './wordmark';

/**
 * The small wordmark in the header, linking home — except on the home page, which shows the
 * large one a few pixels below it and has nowhere to link to.
 */
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
