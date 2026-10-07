'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ClipboardIcon, CloseIcon, LinkIcon, SpinnerIcon } from './icons';
import { cx } from '@/lib/format';

export function UrlForm({
  value,
  onChange,
  onSubmit,
  busy,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly busy: boolean;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [canPaste, setCanPaste] = useState(false);

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && 'clipboard' in navigator);

    if (window.matchMedia('(min-width: 640px)').matches) inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed && !busy) onSubmit(trimmed);
  };

  const paste = async (): Promise<void> => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      onChange(text);
      inputRef.current?.focus();
      onSubmit(text);
    } catch {
      inputRef.current?.focus();
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label htmlFor="sera-url" className="sr-only">
        Link to analyze
      </label>

      <div
        className={cx(
          'group relative flex items-center gap-2 rounded-[var(--radius-input)] border bg-[var(--color-surface)] pr-2 pl-3.5 transition-[box-shadow,border-color] duration-200',
          'border-[var(--color-line)] focus-within:border-[var(--color-accent)] focus-within:shadow-[var(--shadow-focus)]',
          disabled && 'opacity-60',
        )}
      >
        <LinkIcon
          size={18}
          className="shrink-0 text-[var(--color-ink-faint)] transition-colors group-focus-within:text-[var(--color-accent)]"
        />

        <input
          ref={inputRef}
          id="sera-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={disabled}
          placeholder="Paste a link…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent py-4 text-base text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />

        {value && !busy && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            aria-label="Clear the link"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          >
            <CloseIcon size={16} />
          </button>
        )}

        {!value && canPaste && (
          <button
            type="button"
            onClick={() => void paste()}
            disabled={busy || disabled}
            className="hidden shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] sm:flex"
          >
            <ClipboardIcon size={15} />
            Paste
          </button>
        )}
      </div>

      <button
        type="submit"
        disabled={!value.trim() || busy || disabled}
        className={cx(
          'mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] text-[0.9375rem] font-medium transition-all duration-200',
          'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]',
          'disabled:cursor-not-allowed disabled:bg-[var(--color-sunken)] disabled:text-[var(--color-ink-faint)]',
        )}
      >
        {busy ? (
          <>
            <SpinnerIcon size={17} />
            Analyzing
          </>
        ) : (
          'Analyze'
        )}
      </button>
    </form>
  );
}
