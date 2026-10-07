'use client';

import { useEffect, useRef, useState } from 'react';
import { bookmarkletSource, buildBookmarklet } from '@/lib/bookmarklet';

export function BookmarkletLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const [href, setHref] = useState('');
  const [source, setSource] = useState('');
  const [copied, setCopied] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    const origin = window.location.origin;
    const built = buildBookmarklet(origin);
    ref.current?.setAttribute('href', built);
    setHref(built);
    setSource(bookmarkletSource(origin));
  }, []);

  useEffect(() => {
    if (manual && manualRef.current) {
      manualRef.current.focus();
      manualRef.current.select();
    }
  }, [manual]);

  const copy = async (): Promise<void> => {
    const done = (): void => {
      setManual(false);
      setNudge(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    try {
      await navigator.clipboard.writeText(href);
      done();
    } catch {
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
        else setManual(true);
      } catch {
        setManual(true);
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
        {nudge && !copied && !manual && (
          <span className="text-[0.75rem] text-[var(--color-ink-faint)]">
            Drag to your bookmarks bar, or copy the code.
          </span>
        )}
      </span>

      {manual && (
        <label className="flex flex-col gap-1 text-[0.75rem] text-[var(--color-ink-faint)]">
          Couldn’t copy automatically — long-press to select, then Copy:
          <textarea
            ref={manualRef}
            readOnly
            value={href}
            rows={3}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full resize-none rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-2 font-mono text-[0.6875rem] break-all text-[var(--color-ink-muted)]"
          />
        </label>
      )}

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
