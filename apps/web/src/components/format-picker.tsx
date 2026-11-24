'use client';

import { memo, useMemo } from 'react';
import type { DownloadOption, MediaInfo } from '@sera/contracts/types';
import { AudioIcon, ChevronIcon, FileIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatBytes, optionBadges, stepRadio } from '@/lib/format';
import {
  availableKinds,
  kindLabel,
  optionsOfKind,
  qualityLabels,
  resolveSelection,
  type SelectableKind,
} from '@/lib/selection';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  file: FileIcon,
} as const;

export const FormatPicker = memo(function FormatPicker({
  info,
  selectedIds,
  kind,
  onKindChange,
  label,
  onLabelChange,
}: {
  readonly info: MediaInfo;
  readonly selectedIds: ReadonlySet<string>;
  readonly kind: SelectableKind;
  readonly onKindChange: (kind: SelectableKind) => void;
  readonly label: string | undefined;
  readonly onLabelChange: (label: string) => void;
}) {
  const emptySelection = selectedIds.size === 0;
  const effectiveIds = useMemo(
    () => (emptySelection ? new Set(info.items.map((item) => item.id)) : selectedIds),
    [emptySelection, info.items, selectedIds],
  );
  const kinds = useMemo(() => availableKinds(info, effectiveIds), [info, effectiveIds]);
  const labels = useMemo(() => qualityLabels(info, kind, effectiveIds), [info, kind, effectiveIds]);
  const activeLabel = label ?? labels[0];

  const matchingOptions: DownloadOption[] = useMemo(
    () =>
      info.items
        .filter((item) => effectiveIds.has(item.id))
        .flatMap((item) => optionsOfKind(item, kind)),
    [info.items, effectiveIds, kind],
  );

  const labelCards = useMemo(
    () =>
      labels.map((candidate) => {
        const option = matchingOptions.find((item) => item.label === candidate);
        const aggregated =
          effectiveIds.size > 1 ? resolveSelection(info, effectiveIds, kind, candidate) : undefined;
        const sizeBytes = aggregated ? aggregated.totalBytes : option?.filesizeBytes;
        const approximate = aggregated
          ? aggregated.anyApproximate
          : Boolean(option?.filesizeIsApproximate);
        const badges = option ? optionBadges(option) : [];
        return {
          candidate,
          option,
          sizeBytes,
          approximate,
          badges,
        };
      }),
    [labels, matchingOptions, effectiveIds, info, kind],
  );

  const describing = useMemo(
    () => matchingOptions.find((option) => option.label === activeLabel),
    [matchingOptions, activeLabel],
  );
  const describingBadges = useMemo(
    () => (describing ? optionBadges(describing) : []),
    [describing],
  );

  return (
    <div className={cx('flex flex-col gap-4', emptySelection && 'opacity-60')}>
      {kinds.length > 1 && (
        <fieldset disabled={emptySelection}>
          <legend className="mb-2 text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Format
          </legend>
          <div
            role="radiogroup"
            aria-label="Format"
            className="grid grid-flow-col gap-1 rounded-xl bg-[var(--color-sunken)] p-1"
            style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }}
          >
            {kinds.map((candidate, index) => {
              const Icon = KIND_ICON[candidate];
              const selected = candidate === kind;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={emptySelection}
                  onClick={() => onKindChange(candidate)}
                  onKeyDown={(event) => stepRadio(event, kinds, index, onKindChange)}
                  className={cx(
                    'flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-1.5 py-2.5 text-[0.8125rem] font-medium transition-all duration-150 disabled:cursor-not-allowed min-[400px]:px-3',
                    selected
                      ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  <Icon
                    size={16}
                    className={cx('shrink-0', kinds.length > 2 && 'max-[399px]:hidden')}
                  />
                  <span className="truncate">{kindLabel(info, candidate)}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {labels.length > 1 && (
        <div>
          <span
            id="sera-quality-label"
            className="mb-2 block text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
          >
            Quality
          </span>
          <div className="relative sm:hidden">
            <select
              id="sera-quality"
              aria-labelledby="sera-quality-label"
              value={activeLabel}
              disabled={emptySelection}
              onChange={(event) => onLabelChange(event.target.value)}
              className="w-full cursor-pointer appearance-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] py-3 pr-10 pl-3.5 text-[0.9375rem] text-[var(--color-ink)] transition-colors hover:border-[var(--color-line-strong)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed"
            >
              {labelCards.map(({ candidate, option, sizeBytes, approximate }) => {
                const meta = [
                  option?.container?.toUpperCase(),
                  sizeBytes !== undefined
                    ? `${approximate ? '~' : ''}${formatBytes(sizeBytes)}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <option key={candidate} value={candidate}>
                    {meta ? `${candidate} (${meta})` : candidate}
                  </option>
                );
              })}
            </select>
            <ChevronIcon
              size={18}
              className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[var(--color-ink-faint)]"
            />
          </div>

          <div
            role="radiogroup"
            aria-labelledby="sera-quality-label"
            className="mt-2.5 hidden grid-cols-1 gap-2 sm:grid sm:grid-cols-2"
          >
            {labelCards.map(({ candidate, option, sizeBytes, approximate, badges }, index) => {
              const selected = candidate === activeLabel;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={emptySelection}
                  onClick={() => onLabelChange(candidate)}
                  onKeyDown={(event) => stepRadio(event, labels, index, onLabelChange)}
                  className={cx(
                    'flex cursor-pointer flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-150 disabled:cursor-not-allowed',
                    selected
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]',
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate text-[0.875rem] font-medium text-[var(--color-ink)]">
                      {candidate}
                    </span>
                    {sizeBytes !== undefined && (
                      <span className="tabular shrink-0 text-xs text-[var(--color-ink-muted)]">
                        {approximate ? '~' : ''}
                        {formatBytes(sizeBytes)}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    {option?.container && (
                      <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-sunken)] px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
                        {option.container}
                      </span>
                    )}
                    {badges.map((badge) => (
                      <span
                        key={badge}
                        data-codec-badge={badge}
                        className="rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-surface)] px-1.5 py-0.5 text-[0.6875rem] font-medium text-[var(--color-accent)]"
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(Boolean(describing?.detail) || describingBadges.length > 0) && (
        <div
          className={cx(
            '-mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem] text-[var(--color-ink-muted)]',
            !describing?.detail && labels.length > 1 && 'sm:hidden',
          )}
        >
          {describing?.detail && (
            <span>
              {describing.detail}
              {describing.requiresConversion && (
                <span className="text-[var(--color-ink-faint)]"> · converted after download</span>
              )}
            </span>
          )}
          {describingBadges.length > 0 && (
            <span
              className={cx('flex flex-wrap items-center gap-1', labels.length > 1 && 'sm:hidden')}
            >
              {describingBadges.map((badge) => (
                <span
                  key={badge}
                  data-codec-badge={badge}
                  className="rounded-md border border-[var(--color-line)] bg-[var(--color-sunken)] px-1.5 py-0.5 text-[0.6875rem] font-medium text-[var(--color-ink)]"
                >
                  {badge}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {selectedIds.size === 1 && labels.length === 1 && describing?.filesizeBytes !== undefined && (
        <p className="-mt-1 text-[0.8125rem] text-[var(--color-ink-muted)]">
          {describing.filesizeIsApproximate ? 'About ' : ''}
          {formatBytes(describing.filesizeBytes)}
        </p>
      )}
    </div>
  );
});
