'use client';

import { useEffect, useRef, useState } from 'react';
import { buildBookmarklet } from '@/lib/bookmarklet';

/**
 * The draggable "SERA: Import post" link.
 *
 * A bookmarklet installs by being dragged to the bookmarks bar, so it has to be a real anchor
 * with a `javascript:` href — and React 19 strips a `javascript:` href written in JSX, so it is
 * set on the element through a ref after mount instead. The origin comes from where this page
 * is actually served, so a self-hosted SERA gets a bookmarklet pointing at itself with no build
 * step. Clicking it here does nothing useful — it only runs on instagram.com — so a click is
 * swallowed with a nudge to drag it.
 */
export function BookmarkletLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    ref.current?.setAttribute('href', buildBookmarklet(window.location.origin));
  }, []);

  return (
    <span className="inline-flex items-center gap-2">
      <a
        ref={ref}
        href="#"
        draggable
        onClick={(event) => {
          event.preventDefault();
          setNudge(true);
        }}
        className="inline-flex cursor-grab items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[0.8125rem] font-medium text-[var(--color-ink)] transition-colors select-none hover:bg-[var(--color-sunken)] active:cursor-grabbing"
      >
        <span aria-hidden="true">⌁</span> SERA: Import post
      </a>
      {nudge && (
        <span className="text-[0.75rem] text-[var(--color-ink-faint)]">
          Drag it to your bookmarks bar.
        </span>
      )}
    </span>
  );
}
