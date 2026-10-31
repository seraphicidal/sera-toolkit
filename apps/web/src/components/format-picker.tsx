'use client';

import type { DownloadOption, MediaInfo } from '@sera/contracts/types';
import { AudioIcon, ChevronIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatBytes, optionBadges } from '@/lib/format';
import {
  availableKinds,
  kindLabel,
  optionsOfKind,
  qualityLabels,
  type SelectableKind,
} from '@/lib/selection';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
} as const;

export function FormatPicker({
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
  const kinds = availableKinds(info, selectedIds);
  const labels = qualityLabels(info, kind, selectedIds);
  const activeLabel = label ?? labels[0];

  const matchingOptions: DownloadOption[] = info.items
    .filter((item) => selectedIds.has(item.id))
    .flatMap((item) => optionsOfKind(item, kind));

  const describing = matchingOptions.find((option) => option.label === activeLabel);
  const describingBadges = describing ? optionBadges(describing) : [];

  return (
    <div className="flex flex-col gap-4">
      {kinds.length > 1 && (
        <fieldset>
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
                  onClick={() => onKindChange(candidate)}
                  onKeyDown={(event) => {
                    let offset = 0;
                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') offset = 1;
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') offset = -1;
                    if (!offset) return;
                    event.preventDefault();
                    const nextIndex = (index + offset + kinds.length) % kinds.length;
                    const nextKind = kinds[nextIndex];
                    if (!nextKind) return;
                    onKindChange(nextKind);
                    event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                      [nextIndex]?.focus();
                  }}
                  className={cx(
                    'flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg px-1.5 py-2.5 text-[0.8125rem] font-medium transition-all duration-150 min-[400px]:px-3',
                    selected
                      ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  <Icon size={16} className={cx(kinds.length > 2 && 'max-[399px]:hidden')} />
                  {kindLabel(info, candidate)}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {labels.length > 1 && (
        <div>
          <label
            htmlFor="sera-quality"
            className="mb-2 block text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
          >
            Quality
          </label>
          <div className="relative">
            <select
              id="sera-quality"
              value={activeLabel}
              onChange={(event) => onLabelChange(event.target.value)}
              className="w-full cursor-pointer appearance-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] py-3 pr-10 pl-3.5 text-[0.9375rem] text-[var(--color-ink)] transition-colors hover:border-[var(--color-line-strong)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              {labels.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
            <ChevronIcon
              size={18}
              className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[var(--color-ink-faint)]"
            />
          </div>

          <div
            role="radiogroup"
            aria-label="Quality options"
            className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {labels.map((candidate) => {
              const option = matchingOptions.find((item) => item.label === candidate);
              const selected = candidate === activeLabel;
              const badges = option ? optionBadges(option) : [];
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onLabelChange(candidate)}
                  className={cx(
                    'flex cursor-pointer flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-150',
                    selected
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]',
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-[0.875rem] font-medium text-[var(--color-ink)]">
                      {candidate}
                    </span>
                    {option?.filesizeBytes !== undefined && (
                      <span className="tabular text-xs text-[var(--color-ink-muted)]">
                        {option.filesizeIsApproximate ? '~' : ''}
                        {formatBytes(option.filesizeBytes)}
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
        <div className="-mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem] text-[var(--color-ink-muted)]">
          {describing?.detail && (
            <span>
              {describing.detail}
              {describing.requiresConversion && (
                <span className="text-[var(--color-ink-faint)]"> · converted after download</span>
              )}
            </span>
          )}
          {describingBadges.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
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
}
