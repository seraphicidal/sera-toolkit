'use client';

import type { MediaInfo } from '@sera/contracts/types';
import { AudioIcon, ChevronIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatBytes, KIND_LABELS } from '@/lib/format';
import { availableKinds, optionsOfKind, qualityLabels, type SelectableKind } from '@/lib/selection';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
} as const;

/**
 * Format and quality.
 *
 * Only kinds the source actually has are shown, and the quality list is only rendered
 * when there is more than one — a control with a single option is a decision the user
 * did not need to be shown. The detail line under the select is where honesty lives:
 * it says what will really be produced, including whether a size is an estimate.
 */
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
  const kinds = availableKinds(info);
  const labels = qualityLabels(info, kind, selectedIds);

  // The detail shown under the select comes from the first selected item that offers
  // this exact choice, so it describes what the user is actually about to get.
  const describing = info.items
    .filter((item) => selectedIds.has(item.id))
    .flatMap((item) => optionsOfKind(item, kind))
    .find((option) => option.label === label);

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
            {kinds.map((candidate) => {
              const Icon = KIND_ICON[candidate];
              const selected = candidate === kind;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onKindChange(candidate)}
                  className={cx(
                    'flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[0.8125rem] font-medium transition-all duration-150',
                    selected
                      ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  <Icon size={16} />
                  {KIND_LABELS[candidate]}
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
              value={label ?? labels[0]}
              onChange={(event) => onLabelChange(event.target.value)}
              className="w-full cursor-pointer appearance-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] py-3 pr-10 pl-3.5 text-[0.9375rem] text-[var(--color-ink)] transition-colors hover:border-[var(--color-line-strong)] focus:border-[var(--color-accent)] focus:outline-none"
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
        </div>
      )}

      {describing?.detail && (
        <p className="-mt-1 text-[0.8125rem] text-[var(--color-ink-muted)]">
          {describing.detail}
          {describing.requiresConversion && (
            <span className="text-[var(--color-ink-faint)]"> · converted after download</span>
          )}
        </p>
      )}

      {labels.length === 1 && describing?.filesizeBytes !== undefined && (
        <p className="-mt-1 text-[0.8125rem] text-[var(--color-ink-muted)]">
          {describing.filesizeIsApproximate ? 'About ' : ''}
          {formatBytes(describing.filesizeBytes)}
        </p>
      )}
    </div>
  );
}
