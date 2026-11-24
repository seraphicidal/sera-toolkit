'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ClipboardIcon, CloseIcon, LinkIcon, SpinnerIcon } from './icons';
import { cx, pluralize } from '@/lib/format';
import { firstHttpUrl, parseBatchUrls } from '@/lib/share';

export { parseBatchUrls };

export const MAX_BATCH_URLS = 50;

const MIN_TEXTAREA_HEIGHT = 56;
const MAX_TEXTAREA_HEIGHT = 168;

export const UrlForm = memo(function UrlForm({
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
  const pasteHintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [canPaste, setCanPaste] = useState(false);
  const [pasteHint, setPasteHint] = useState('');
  const [shortcutLabel, setShortcutLabel] = useState<string | undefined>(undefined);

  const syncHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    if (!el.value.includes('\n') && el.value.length < 36) {
      el.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
      return;
    }
    el.style.height = 'auto';
    const nextHeight = Math.min(
      Math.max(el.scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT,
    );
    el.style.height = `${nextHeight}px`;
  }, []);

  useEffect(() => {
    setCanPaste(
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function',
    );

    const finePointer = window.matchMedia('(pointer: fine)').matches;
    if (finePointer) {
      const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
      setShortcutLabel(mac ? '⌘+Enter' : 'Ctrl+Enter');
    }

    if (window.matchMedia('(min-width: 640px)').matches) inputRef.current?.focus();

    const el = inputRef.current;
    let observer: ResizeObserver | undefined;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => syncHeight(el));
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      if (pasteHintTimer.current) clearTimeout(pasteHintTimer.current);
    };
  }, [syncHeight]);

  useEffect(() => {
    syncHeight(inputRef.current);
  }, [value, syncHeight]);

  const parsedBatch = useMemo(() => (value.includes('\n') ? parseBatchUrls(value) : []), [value]);
  const isMultiLine = value.includes('\n') || parsedBatch.length > 1;
  const effectiveBatchCount = Math.min(parsedBatch.length, MAX_BATCH_URLS);

  const showPasteFallbackHint = useCallback(() => {
    const fallback = shortcutLabel === '⌘+Enter' ? 'Press ⌘+V to paste.' : 'Press Ctrl+V to paste.';
    setPasteHint(shortcutLabel ? fallback : 'Tap and hold the field to paste.');
    if (pasteHintTimer.current) clearTimeout(pasteHintTimer.current);
    pasteHintTimer.current = setTimeout(() => setPasteHint(''), 3_500);
  }, [shortcutLabel]);

  const submitValue = (rawText: string): void => {
    const trimmed = rawText.trim();
    if (!trimmed || busy || disabled) return;
    const batch = parseBatchUrls(trimmed);
    if (batch.length > 1) {
      const capped = batch.slice(0, MAX_BATCH_URLS);
      if (onSubmitBatch) {
        onSubmitBatch(capped);
      } else {
        onSubmit(capped[0]!);
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
      event.stopPropagation();
      submitValue(value);
      return;
    }
    if (!event.shiftKey && !isMultiLine) {
      event.preventDefault();
      event.stopPropagation();
      submitValue(value);
    }
  };

  const paste = async (): Promise<void> => {
    setPasteHint('');
    try {
      const trimmed = (await navigator.clipboard.readText()).trim();
      if (!trimmed) {
        inputRef.current?.focus();
        return;
      }
      const batch = parseBatchUrls(trimmed);
      if (batch.length > 1) {
        const capped = batch.slice(0, MAX_BATCH_URLS);
        const joined = capped.join('\n');
        onChange(joined);
        inputRef.current?.focus();
        if (onSubmitBatch) {
          onSubmitBatch(capped);
        } else {
          onSubmit(capped[0]!);
        }
        return;
      }
      const cleaned = batch[0] ?? firstHttpUrl(trimmed) ?? trimmed;
      onChange(cleaned);
      inputRef.current?.focus();
      onSubmit(cleaned);
    } catch {
      inputRef.current?.focus();
      showPasteFallbackHint();
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label htmlFor="sera-url" className="sr-only">
        Link or batch of links to analyze
      </label>

      <div
        className={cx(
          'group relative flex items-start gap-2 rounded-[var(--radius-input)] border bg-[var(--color-surface)] pr-2 pl-3.5 transition-colors duration-200',
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
          onChange={(event) => {
            if (pasteHint) setPasteHint('');
            onChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="max-h-42 min-h-14 min-w-0 flex-1 resize-none border-none bg-transparent py-4 text-base leading-normal text-[var(--color-ink)] ring-0 outline-none placeholder:text-[var(--color-ink-faint)] focus:border-none focus:ring-0 focus:outline-none"
        />

        <div className="mt-2.5 flex shrink-0 items-center gap-1">
          {value && !busy && !disabled && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                inputRef.current?.focus();
              }}
              aria-label="Clear the link"
              className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            >
              <CloseIcon size={16} />
            </button>
          )}

          {!value && canPaste && (
            <button
              type="button"
              onClick={() => void paste()}
              disabled={busy || disabled}
              className="flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            >
              <ClipboardIcon size={15} />
              Paste
            </button>
          )}
        </div>
      </div>

      {pasteHint && (
        <p
          role="status"
          aria-live="polite"
          className="mt-1.5 text-xs text-[var(--color-ink-muted)]"
        >
          {pasteHint}
        </p>
      )}

      {isMultiLine && (
        <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
          {parsedBatch.length > MAX_BATCH_URLS
            ? `First ${MAX_BATCH_URLS} of ${pluralize(parsedBatch.length, 'link')} will be queued${shortcutLabel ? ` · Press ${shortcutLabel} or click Analyze` : ''}`
            : parsedBatch.length > 1
              ? `${pluralize(parsedBatch.length, 'link')} detected${shortcutLabel ? ` · Press ${shortcutLabel} or click Analyze to queue batch` : ''}`
              : `Multi-line mode${shortcutLabel ? ` · Press ${shortcutLabel} or click Analyze` : ''}`}
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
        ) : effectiveBatchCount > 1 ? (
          `Analyze ${pluralize(effectiveBatchCount, 'link')}`
        ) : (
          'Analyze'
        )}
      </button>
    </form>
  );
});
