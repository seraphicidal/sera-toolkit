'use client';

import { useEffect, useRef, useState } from 'react';
import { bookmarkletSource, buildBookmarklet } from '@/lib/bookmarklet';

/**
 * The draggable "SERA: Import post" link, with the exact code it carries shown beside it.
 *
 * A bookmarklet installs by being dragged to the bookmarks bar, so it has to be a real anchor
 * with a `javascript:` href — and React 19 strips a `javascript:` href written in JSX, so it is
 * set on the element through a ref after mount instead. The origin comes from where this page
 * is actually served, so a self-hosted SERA gets a bookmarklet pointing at itself with no build
 * step. Clicking it here does nothing useful — it only runs on instagram.com — so a click is
 * swallowed with a nudge to drag it.
 *
 * The "What this runs" panel shows the same string the href carries, verbatim, because this is
 * code that will run on instagram.com with the visitor's session: being able to read exactly
 * what you are installing, and confirm it fetches nothing and evaluates nothing, is the point.
 */
export function BookmarkletLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [source, setSource] = useState('');
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    const origin = window.location.origin;
    ref.current?.setAttribute('href', buildBookmarklet(origin));
    setSource(bookmarkletSource(origin));
  }, []);

  return (
    <span className="inline-flex flex-col gap-2">
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

      {source && (
        <details className="text-[0.75rem] text-[var(--color-ink-faint)]">
          <summary className="cursor-pointer transition-colors select-none hover:text-[var(--color-ink-muted)]">
            What this runs — it fetches only Instagram, and evaluates nothing
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-3 text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
            <code>{source}</code>
          </pre>
        </details>
      )}
    </span>
  );
}
