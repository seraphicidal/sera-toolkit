'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { MediaInfo, MediaItem } from '@sera/contracts/types';
import { AudioIcon, CheckIcon, CloseIcon, FileIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatDuration, isSafeDownloadPath, KIND_LABELS, pluralize } from '@/lib/format';
import { filterMediaItems, selectItemRange, selectItemsUpToMax } from '@/lib/selection';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  file: FileIcon,
  unknown: VideoIcon,
} as const;

const FILTER_THRESHOLD = 6;

export const ItemPicker = memo(function ItemPicker({
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
  const [capNotice, setCapNotice] = useState<string | undefined>(undefined);
  const lastClickedIndexRef = useRef<number | undefined>(undefined);
  const selectedIdsRef = useRef<ReadonlySet<string>>(selectedIds);
  selectedIdsRef.current = selectedIds;

  useEffect(() => {
    setFilterQuery('');
    setCapNotice(undefined);
    lastClickedIndexRef.current = undefined;
  }, [info.id, info.items.length]);

  const showFilter = info.items.length > FILTER_THRESHOLD;

  const visibleItems = useMemo(
    () => (showFilter ? filterMediaItems(info.items, filterQuery) : info.items),
    [info.items, filterQuery, showFilter],
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
      const current = selectedIdsRef.current;
      for (const item of info.items) {
        const hasNow = current.has(item.id);
        const shouldHave = nextSet.has(item.id);
        if (hasNow !== shouldHave) {
          onToggle(item.id);
        }
      }
    },
    [info.items, onSelectAll, onSelectIds, onToggle],
  );

  const isFiltered = showFilter && visibleItems.length !== info.items.length;

  const handleSelectAllVisible = (): void => {
    const base = isFiltered ? selectedIdsRef.current : undefined;
    const next = selectItemsUpToMax(visibleItems, maxItems, base);
    applySelection(next);
    const allVisibleSelected = visibleItems.every((item) => next.has(item.id));
    if (maxItems !== undefined && !allVisibleSelected) {
      setCapNotice(
        isFiltered
          ? `Selection limit reached (${maxItems} items max per download).`
          : `Selected the first ${maxItems} items (server limit per download).`,
      );
    } else {
      setCapNotice(undefined);
    }
  };

  const handleClear = (): void => {
    setCapNotice(undefined);
    applySelection(new Set());
  };

  const handleTileClick = useCallback(
    (item: MediaItem, event?: MouseEvent): void => {
      const prevIndex = lastClickedIndexRef.current;
      const currentSelected = selectedIdsRef.current;
      if (event?.shiftKey && prevIndex !== undefined) {
        const rangeSet = selectItemRange(visibleItems, prevIndex, item.index, maxItems);
        const merged = selectItemsUpToMax(
          visibleItems.filter((candidate) => rangeSet.has(candidate.id)),
          maxItems,
          currentSelected,
        );
        applySelection(merged);
        lastClickedIndexRef.current = item.index;
        if (maxItems !== undefined && merged.size >= maxItems) {
          setCapNotice(`Selection limit reached (${maxItems} items max per download).`);
        }
        return;
      }
      lastClickedIndexRef.current = item.index;
      if (
        maxItems !== undefined &&
        !currentSelected.has(item.id) &&
        currentSelected.size >= maxItems
      ) {
        setCapNotice(`Selection limit reached (${maxItems} items max per download).`);
        return;
      }
      setCapNotice(undefined);
      onToggle(item.id);
    },
    [applySelection, maxItems, onToggle, visibleItems],
  );

  const noneSelected = selectedIds.size === 0;
  const atCap = maxItems !== undefined && selectedIds.size >= maxItems;
  const cappedPlaylist = maxItems !== undefined && info.items.length > maxItems;
  const cappedVisible = maxItems !== undefined && visibleItems.length > maxItems;

  return (
    <fieldset data-item-picker="true" className="flex flex-col gap-3">
      <legend className="sr-only">Items to download</legend>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          {pluralize(info.items.length, 'item')} found
          {visibleItems.length !== info.items.length
            ? ` · ${pluralize(visibleItems.length, 'match', 'matches')}`
            : ''}
        </span>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={handleSelectAllVisible}
            className="min-h-9 cursor-pointer rounded-md px-2.5 py-1 text-[0.8125rem] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            {cappedVisible
              ? `Select first ${maxItems}`
              : isFiltered
                ? 'Select matches'
                : 'Select All'}
          </button>

          <button
            type="button"
            onClick={handleClear}
            disabled={noneSelected}
            className="min-h-9 cursor-pointer rounded-md px-2.5 py-1 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="relative">
          <input
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Filter items..."
            aria-label="Filter playlist items"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] py-2 pr-9 pl-3 text-[0.8125rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus-visible:shadow-[var(--shadow-focus)] [&::-webkit-search-cancel-button]:appearance-none"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
              className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded text-[var(--color-ink-faint)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-4 text-center text-[0.8125rem] text-[var(--color-ink-muted)]">
          No items match &ldquo;{filterQuery}&rdquo;.
        </p>
      ) : (
        <div
          className={cx(
            'grid grid-cols-2 gap-2 sm:grid-cols-3',
            visibleItems.length > 9 && 'max-h-[26rem] overflow-y-auto p-0.5',
          )}
        >
          {visibleItems.map((item) => {
            const selected = selectedIds.has(item.id);
            return (
              <ItemTile
                key={item.id}
                item={item}
                selected={selected}
                disabled={!selected && atCap}
                onToggle={handleTileClick}
              />
            );
          })}
        </div>
      )}

      <div aria-live="polite" className="flex flex-col gap-0.5 text-[0.8125rem]">
        <p
          className={cx(
            noneSelected ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-muted)]',
          )}
        >
          {noneSelected
            ? 'Select at least one item.'
            : `${pluralize(selectedIds.size, 'item')} selected${cappedPlaylist ? ` (max ${maxItems})` : ''}`}
        </p>
        {(Boolean(capNotice) || (atCap && cappedPlaylist)) && (
          <p className="text-xs text-[var(--color-ink-faint)]">
            {capNotice ??
              `Limit of ${maxItems} items per download reached. Deselect one to pick another.`}
          </p>
        )}
      </div>
    </fieldset>
  );
});

const ItemTile = memo(function ItemTile({
  item,
  selected,
  disabled,
  onToggle,
}: {
  readonly item: MediaItem;
  readonly selected: boolean;
  readonly disabled: boolean;
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
      title={disabled ? 'Maximum items selected' : displayTitle}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey) {
          event.preventDefault();
          onToggle(item, event);
        }
      }}
      className={cx(
        'group relative flex flex-col overflow-hidden rounded-xl border transition-all duration-150',
        disabled
          ? 'cursor-not-allowed border-[var(--color-line)] bg-[var(--color-surface)] opacity-45'
          : selected
            ? 'cursor-pointer border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
            : 'cursor-pointer border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]',
        'has-[:focus-visible]:shadow-[var(--shadow-focus)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--color-accent)]',
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled}
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
