'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { MediaInfo, MediaItem } from '@sera/contracts/types';
import { AudioIcon, CheckIcon, CloseIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatDuration, isSafeDownloadPath, KIND_LABELS, pluralize } from '@/lib/format';
import { filterMediaItems, selectItemRange, selectItemsUpToMax } from '@/lib/selection';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  unknown: VideoIcon,
} as const;

export function ItemPicker({
  info,
  selectedIds,
  onToggle,
  onSelectAll,
  onSelectIds,
  maxItems,
}: {
  readonly info: MediaInfo;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggle: (itemId: string) => void;
  readonly onSelectAll: (selected: boolean) => void;
  readonly onSelectIds?: (ids: ReadonlySet<string>) => void;
  readonly maxItems?: number;
}) {
  const [filterQuery, setFilterQuery] = useState('');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState(() => String(info.items.length));
  const [lastClickedIndex, setLastClickedIndex] = useState<number | undefined>(undefined);

  useEffect(() => {
    setRangeEnd(String(info.items.length));
  }, [info.items.length]);

  const visibleItems = useMemo(
    () => filterMediaItems(info.items, filterQuery),
    [info.items, filterQuery],
  );

  const applySelection = useCallback(
    (nextSet: Set<string>): void => {
      if (onSelectIds) {
        onSelectIds(nextSet);
        return;
      }
      if (nextSet.size === 0) {
        onSelectAll(false);
        return;
      }
      if (nextSet.size === info.items.length) {
        onSelectAll(true);
        return;
      }
      for (const item of info.items) {
        const hasNow = selectedIds.has(item.id);
        const shouldHave = nextSet.has(item.id);
        if (hasNow !== shouldHave) {
          onToggle(item.id);
        }
      }
    },
    [info.items, onSelectAll, onSelectIds, onToggle, selectedIds],
  );

  const handleSelectAllVisible = (): void => {
    const next = selectItemsUpToMax(visibleItems, maxItems);
    applySelection(next);
  };

  const handleSelectRange = (): void => {
    const fromNum = Number.parseInt(rangeStart, 10);
    const toNum = Number.parseInt(rangeEnd, 10);
    if (!Number.isFinite(fromNum) || !Number.isFinite(toNum)) return;
    const next = selectItemRange(visibleItems, fromNum, toNum, maxItems);
    applySelection(next);
  };

  const handleClear = (): void => {
    applySelection(new Set());
  };

  const handleTileClick = useCallback(
    (item: MediaItem, event?: MouseEvent): void => {
      if (event?.shiftKey && lastClickedIndex !== undefined) {
        const rangeSet = selectItemRange(visibleItems, lastClickedIndex, item.index, maxItems);
        const merged = selectItemsUpToMax(
          visibleItems.filter((candidate) => rangeSet.has(candidate.id)),
          maxItems,
          selectedIds,
        );
        applySelection(merged);
        setLastClickedIndex(item.index);
        return;
      }
      setLastClickedIndex(item.index);
      onToggle(item.id);
    },
    [applySelection, lastClickedIndex, maxItems, onToggle, selectedIds, visibleItems],
  );

  const noneSelected = selectedIds.size === 0;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
        {pluralize(info.items.length, 'item')} found
        {visibleItems.length !== info.items.length
          ? ` · ${pluralize(visibleItems.length, 'match', 'matches')}`
          : ''}
      </legend>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSelectAllVisible}
            className="cursor-pointer rounded-md px-2 py-1 text-[0.8125rem] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            Select All
          </button>

          <div className="flex items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5 text-xs">
            <input
              type="number"
              min={1}
              max={info.items.length}
              value={rangeStart}
              onChange={(event) => setRangeStart(event.target.value)}
              aria-label="Range start index"
              className="tabular w-10 bg-transparent text-center text-[var(--color-ink)] outline-none"
            />
            <span className="text-[var(--color-ink-faint)]">–</span>
            <input
              type="number"
              min={1}
              max={info.items.length}
              value={rangeEnd}
              onChange={(event) => setRangeEnd(event.target.value)}
              aria-label="Range end index"
              className="tabular w-10 bg-transparent text-center text-[var(--color-ink)] outline-none"
            />
            <button
              type="button"
              onClick={handleSelectRange}
              className="cursor-pointer rounded px-1.5 py-0.5 font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80"
            >
              Select Range
            </button>
          </div>

          <button
            type="button"
            onClick={handleClear}
            disabled={noneSelected}
            className="cursor-pointer rounded-md px-2 py-1 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="relative">
        <input
          type="search"
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
          placeholder="Filter items..."
          aria-label="Filter playlist items"
          className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] py-2 pr-8 pl-3 text-[0.8125rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]"
        />
        {filterQuery && (
          <button
            type="button"
            onClick={() => setFilterQuery('')}
            aria-label="Clear filter"
            className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-1 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {visibleItems.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-4 text-center text-[0.8125rem] text-[var(--color-ink-muted)]">
          No items match &ldquo;{filterQuery}&rdquo;.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visibleItems.map((item) => (
            <ItemTile
              key={item.id}
              item={item}
              selected={selectedIds.has(item.id)}
              onToggle={handleTileClick}
            />
          ))}
        </div>
      )}

      <p
        aria-live="polite"
        className={cx(
          'text-[0.8125rem]',
          noneSelected ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-muted)]',
        )}
      >
        {noneSelected
          ? 'Select at least one item.'
          : `${pluralize(selectedIds.size, 'item')} selected`}
      </p>
    </fieldset>
  );
}

const ItemTile = memo(function ItemTile({
  item,
  selected,
  onToggle,
}: {
  readonly item: MediaItem;
  readonly selected: boolean;
  readonly onToggle: (item: MediaItem, event?: MouseEvent) => void;
}) {
  const [retries, setRetries] = useState(0);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const Icon = KIND_ICON[item.kind];
  const safeThumbnail =
    item.thumbnail && isSafeDownloadPath(item.thumbnail) ? item.thumbnail : undefined;
  const showThumbnail = Boolean(safeThumbnail) && !thumbnailFailed;
  const displayTitle = item.title ?? KIND_LABELS[item.kind === 'unknown' ? 'video' : item.kind];

  useEffect(() => {
    setRetries(0);
    setThumbnailFailed(false);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [safeThumbnail]);

  return (
    <label
      onClick={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
          onToggle(item, event);
        }
      }}
      className={cx(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border transition-all duration-150',
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
          : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]',
        'focus-within:shadow-[var(--shadow-focus)]',
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(item)}
        className="sr-only"
        aria-label={`Item ${item.index}, ${displayTitle}`}
      />

      <div className="relative aspect-4/3 w-full bg-[var(--color-sunken)]">
        {showThumbnail ? (
          <img
            src={
              retries > 0 && safeThumbnail
                ? `${safeThumbnail}${safeThumbnail.includes('?') ? '&' : '?'}retry=${retries}`
                : safeThumbnail
            }
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => {
              if (retries < 2) {
                if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
                retryTimerRef.current = setTimeout(
                  () => setRetries((r) => r + 1),
                  1000 * (retries + 1),
                );
              } else {
                setThumbnailFailed(true);
              }
            }}
            className="size-full object-cover"
          />
        ) : (
          <span className="grid size-full place-items-center">
            <Icon size={22} className="text-[var(--color-ink-faint)]" />
          </span>
        )}

        <span
          aria-hidden="true"
          className={cx(
            'absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-md border transition-all duration-150',
            selected
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-ink)]'
              : 'border-[var(--color-line-strong)] bg-[var(--color-surface)]/85 text-transparent',
          )}
        >
          <CheckIcon size={13} />
        </span>
      </div>

      <span className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[0.6875rem] text-[var(--color-ink-muted)]">
        <span className="truncate" title={displayTitle}>
          {item.index}. {displayTitle}
        </span>
        {item.duration ? (
          <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
            {formatDuration(item.duration)}
          </span>
        ) : null}
      </span>
    </label>
  );
});
