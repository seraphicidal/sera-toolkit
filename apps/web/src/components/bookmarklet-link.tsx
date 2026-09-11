'use client';

import { useEffect, useRef, useState } from 'react';
import { bookmarkletSource, buildBookmarklet } from '@/lib/bookmarklet';

/**
 * The draggable "SERA: Import post" link, a copy button, and the exact code it carries.
 *
 * A bookmarklet installs by being dragged to the bookmarks bar on a computer — and React 19
 * strips a `javascript:` href written in JSX, so it is set on the anchor through a ref after
 * mount. On a phone there is no bar to drag to, so the copy button is the way in: it puts the
 * whole `javascript:` string on the clipboard to paste into a new bookmark's address. The
 * origin comes from where this page is served, so a self-hosted SERA gets a bookmarklet that
 * points at itself. Clicking the link here does nothing useful — it only runs on instagram.com
 * — so a click is swallowed with a nudge.
 *
 * The "What this runs" panel shows the same string the link and the clipboard carry, verbatim,
 * because this is code that will run on instagram.com with the visitor's session: reading
 * exactly what you install, and confirming it fetches nothing and evaluates nothing, is the point.
 */
export function BookmarkletLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [href, setHref] = useState('');
  const [source, setSource] = useState('');
  const [copied, setCopied] = useState(false);
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    const origin = window.location.origin;
    const built = buildBookmarklet(origin);
    ref.current?.setAttribute('href', built);
    setHref(built);
    setSource(bookmarkletSource(origin));
  }, []);

  const copy = async (): Promise<void> => {
    const done = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    try {
      await navigator.clipboard.writeText(href);
      done();
    } catch {
      // Some browsers refuse the async clipboard outside a stronger gesture; the old
      // execCommand path still works from a click, and is what mobile Safari falls back to.
      try {
        const ta = document.createElement('textarea');
        ta.value = href;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done();
        else setNudge(true);
      } catch {
        setNudge(true);
      }
    }
  };

  return (
    <span className="inline-flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
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
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
        >
          {copied ? 'Copied ✓' : 'Copy code'}
        </button>
        {nudge && !copied && (
          <span className="text-[0.75rem] text-[var(--color-ink-faint)]">
            Drag to your bookmarks bar, or copy the code.
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
