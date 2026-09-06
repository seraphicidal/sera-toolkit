'use client';

import { useState } from 'react';
import type { MediaInfo, MediaItem } from '@sera/contracts/types';
import { AudioIcon, CheckIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatDuration, KIND_LABELS, pluralize } from '@/lib/format';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  unknown: ImageIcon,
} as const;

/**
 * Choosing which parts of a post to take.
 *
 * This is the screen that exists because a carousel is not one file. Everything starts
 * selected — that is what someone pasting a four-image post almost always wants — and
 * deselecting is the deliberate act. Each tile is a real checkbox rather than a styled
 * div, so the whole grid is keyboard- and screen-reader-navigable for free.
 */
export function ItemPicker({
  info,
  selectedIds,
  onToggle,
  onSelectAll,
}: {
  readonly info: MediaInfo;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggle: (itemId: string) => void;
  readonly onSelectAll: (selected: boolean) => void;
}) {
  const allSelected = selectedIds.size === info.items.length;
  const noneSelected = selectedIds.size === 0;

  return (
    <fieldset>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <legend className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          {pluralize(info.items.length, 'item')} found
        </legend>
        <button
          type="button"
          onClick={() => onSelectAll(!allSelected)}
          className="cursor-pointer rounded-md text-[0.8125rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          {allSelected ? 'Clear all' : 'Select all'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {info.items.map((item) => (
          <ItemTile
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onToggle={() => onToggle(item.id)}
          />
        ))}
      </div>

      <p
        aria-live="polite"
        className={cx(
          'mt-2.5 text-[0.8125rem]',
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

function ItemTile({
  item,
  selected,
  onToggle,
}: {
  readonly item: MediaItem;
  readonly selected: boolean;
  readonly onToggle: () => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const Icon = KIND_ICON[item.kind];
  const showThumbnail = Boolean(item.thumbnail) && !thumbnailFailed;

  return (
    <label
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
        onChange={onToggle}
        className="sr-only"
        aria-label={`Item ${item.index}, ${KIND_LABELS[item.kind === 'unknown' ? 'video' : item.kind]}`}
      />

      {/* A plain img, not next/image: the source is a proxied API path whose dimensions
          are unknown, so the optimizer would add a round trip and no benefit. */}
      <div className="relative aspect-4/3 w-full bg-[var(--color-sunken)]">
        {showThumbnail ? (
          <img
            src={item.thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setThumbnailFailed(true)}
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
        <span className="truncate">
          {item.index}. {KIND_LABELS[item.kind === 'unknown' ? 'video' : item.kind]}
        </span>
        {item.duration ? (
          <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
            {formatDuration(item.duration)}
          </span>
        ) : null}
      </span>
    </label>
  );
}
