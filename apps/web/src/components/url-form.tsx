'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ClipboardIcon, CloseIcon, LinkIcon, SpinnerIcon } from './icons';
import { cx, pluralize } from '@/lib/format';
import { firstHttpUrl, parseBatchUrls } from '@/lib/share';

export { parseBatchUrls };

export function UrlForm({
  value,
  onChange,
  onSubmit,
  onSubmitBatch,
  busy,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onSubmitBatch?: (urls: string[]) => void;
  readonly busy: boolean;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [canPaste, setCanPaste] = useState(false);

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && 'clipboard' in navigator);

    if (window.matchMedia('(min-width: 640px)').matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.scrollHeight, 56), 168);
    el.style.height = `${nextHeight}px`;
  }, [value]);

  const parsedBatch = useMemo(() => parseBatchUrls(value), [value]);
  const isMultiLine = value.includes('\n') || parsedBatch.length > 1;

  const submitValue = (rawText: string): void => {
    const trimmed = rawText.trim();
    if (!trimmed || busy || disabled) return;
    const batch = parseBatchUrls(trimmed);
    if (batch.length > 1) {
      const normalized = batch.join('\n');
      if (normalized !== value) onChange(normalized);
      if (onSubmitBatch) {
        onSubmitBatch(batch);
      } else {
        onSubmit(batch[0]!);
      }
      return;
    }
    const cleaned = batch[0] ?? firstHttpUrl(trimmed) ?? trimmed;
    if (cleaned !== value) onChange(cleaned);
    onSubmit(cleaned);
  };

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    submitValue(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      submitValue(value);
      return;
    }
    if (!event.shiftKey && !isMultiLine) {
      event.preventDefault();
      submitValue(value);
    }
  };

  const paste = async (): Promise<void> => {
    try {
      const trimmed = (await navigator.clipboard.readText()).trim();
      if (!trimmed) return;
      const batch = parseBatchUrls(trimmed);
      if (batch.length > 1) {
        const joined = batch.join('\n');
        onChange(joined);
        inputRef.current?.focus();
        if (onSubmitBatch) {
          onSubmitBatch(batch);
        } else {
          onSubmit(batch[0]!);
        }
        return;
      }
      const cleaned = batch[0] ?? firstHttpUrl(trimmed) ?? trimmed;
      onChange(cleaned);
      inputRef.current?.focus();
      onSubmit(cleaned);
    } catch {
      inputRef.current?.focus();
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label htmlFor="sera-url" className="sr-only">
        Link or batch of links to analyze
      </label>

      <div
        className={cx(
          'group relative flex items-start gap-2 rounded-[var(--radius-input)] border bg-[var(--color-surface)] pr-2 pl-3.5 transition-[box-shadow,border-color] duration-200',
          'border-[var(--color-line)] focus-within:border-[var(--color-accent)] focus-within:shadow-[var(--shadow-focus)]',
          disabled && 'opacity-60',
        )}
      >
        <LinkIcon
          size={18}
          className="mt-4 shrink-0 text-[var(--color-ink-faint)] transition-colors group-focus-within:text-[var(--color-accent)]"
        />

        <textarea
          ref={inputRef}
          id="sera-url"
          name="url"
          rows={1}
          inputMode="url"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={disabled}
          placeholder="Paste a link or multiple links (one per line)…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="max-h-42 min-h-14 min-w-0 flex-1 resize-none bg-transparent py-4 text-base leading-normal text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />

        <div className="mt-3 flex shrink-0 items-center gap-1">
          {value && !busy && !disabled && (
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
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            >
              <ClipboardIcon size={15} />
              Paste
            </button>
          )}
        </div>
      </div>

      {isMultiLine && (
        <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
          {parsedBatch.length > 1
            ? `${pluralize(parsedBatch.length, 'link')} detected · Press Ctrl+Enter or click Analyze to queue batch`
            : 'Multi-line mode · Press Ctrl+Enter or click Analyze'}
        </p>
      )}

      <button
        type="submit"
        disabled={!value.trim() || busy || disabled}
        className={cx(
          'mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] text-[0.9375rem] font-medium transition-all duration-200',
          'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]',
          'disabled:cursor-not-allowed disabled:bg-[var(--color-sunken)] disabled:text-[var(--color-ink-faint)]',
          'focus-visible:shadow-[var(--shadow-focus)]',
        )}
      >
        {busy ? (
          <>
            <SpinnerIcon size={17} />
            Analyzing
          </>
        ) : parsedBatch.length > 1 ? (
          `Analyze ${pluralize(parsedBatch.length, 'link')}`
        ) : (
          'Analyze'
        )}
      </button>
    </form>
  );
}
