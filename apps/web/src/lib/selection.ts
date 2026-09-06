import type { DownloadOption, MediaInfo, MediaItem, MediaKind } from '@sera/contracts/types';

export type SelectableKind = Exclude<MediaKind, 'unknown'>;

/**
 * Turning a resolution into a download request.
 *
 * The rules here are what make the interface feel decided rather than configurable. A
 * single video shows a format and a quality. A carousel shows the items, because that is
 * the real choice there — which slides, not which codec. And a preference for one kind
 * is honoured per item where it exists and quietly ignored where it does not, so asking
 * for audio on a post of three videos and two photos still returns all five files
 * instead of an error about the photos.
 */

/** The kinds present anywhere in a resolution, in a stable display order. */
export function availableKinds(info: MediaInfo): SelectableKind[] {
  const order: SelectableKind[] = ['video', 'audio', 'image', 'gif'];
  const present = new Set<SelectableKind>();
  for (const item of info.items) {
    for (const option of item.options) present.add(option.kind);
  }
  return order.filter((kind) => present.has(kind));
}

/** Options of one kind for one item, in the order the engine produced them. */
export function optionsOfKind(item: MediaItem, kind: SelectableKind): DownloadOption[] {
  return item.options.filter((option) => option.kind === kind);
}

/** The engine's default for a kind, or the first option if it marked none. */
export function defaultOption(item: MediaItem, kind: SelectableKind): DownloadOption | undefined {
  const candidates = optionsOfKind(item, kind);
  return candidates.find((option) => option.recommended) ?? candidates[0];
}

/**
 * The option to use for an item, given a preferred kind.
 *
 * Falls back to the item's own default when the preference does not apply, which is what
 * lets one control drive a mixed collection.
 */
export function optionForItem(
  item: MediaItem,
  preferredKind: SelectableKind | undefined,
  /** A label the user picked, applied when this item offers the same one. */
  preferredLabel?: string,
): DownloadOption | undefined {
  if (preferredKind) {
    const sameKind = optionsOfKind(item, preferredKind);
    if (sameKind.length) {
      const matched = preferredLabel
        ? sameKind.find((option) => option.label === preferredLabel)
        : undefined;
      return matched ?? sameKind.find((option) => option.recommended) ?? sameKind[0];
    }
  }
  const anyRecommended = item.options.find((option) => option.recommended);
  return anyRecommended ?? item.options[0];
}

/** The kind SERA opens on: whatever the first item's own default is. */
export function initialKind(info: MediaInfo): SelectableKind {
  const first = info.items[0];
  const recommended = first?.options.find((option) => option.recommended);
  return recommended?.kind ?? availableKinds(info)[0] ?? 'video';
}

/** Quality labels offered for a kind across the selected items, deduplicated. */
export function qualityLabels(
  info: MediaInfo,
  kind: SelectableKind,
  selectedIds: ReadonlySet<string>,
): string[] {
  const labels: string[] = [];
  for (const item of info.items) {
    if (selectedIds.size && !selectedIds.has(item.id)) continue;
    for (const option of optionsOfKind(item, kind)) {
      if (!labels.includes(option.label)) labels.push(option.label);
    }
  }
  return labels;
}

export interface ResolvedSelection {
  readonly optionIds: string[];
  /** Combined size estimate, when every chosen option reported one. */
  readonly totalBytes?: number;
  readonly anyApproximate: boolean;
  readonly fileCount: number;
}

/** Resolves the UI state into the exact options a job request will carry. */
export function resolveSelection(
  info: MediaInfo,
  selectedIds: ReadonlySet<string>,
  kind: SelectableKind | undefined,
  label: string | undefined,
): ResolvedSelection {
  const optionIds: string[] = [];
  let totalBytes = 0;
  let everySizeKnown = true;
  let anyApproximate = false;

  for (const item of info.items) {
    if (!selectedIds.has(item.id)) continue;
    const option = optionForItem(item, kind, label);
    if (!option) continue;
    optionIds.push(option.id);
    if (option.filesizeBytes === undefined) everySizeKnown = false;
    else totalBytes += option.filesizeBytes;
    if (option.filesizeIsApproximate) anyApproximate = true;
  }

  return {
    optionIds,
    ...(everySizeKnown && optionIds.length ? { totalBytes } : {}),
    anyApproximate,
    fileCount: optionIds.length,
  };
}
