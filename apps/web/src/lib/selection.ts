import type { DownloadOption, MediaInfo, MediaItem, MediaKind } from '@sera/contracts/types';
import { KIND_LABELS } from './format';

export type SelectableKind = Exclude<MediaKind, 'unknown'>;

export function availableKinds(info: MediaInfo): SelectableKind[] {
  const order: SelectableKind[] = ['video', 'audio', 'image', 'gif'];
  const present = new Set<SelectableKind>();
  for (const item of info.items) {
    for (const option of item.options) present.add(option.kind);
  }
  return order.filter((kind) => present.has(kind));
}

export function kindLabel(info: MediaInfo, kind: SelectableKind): string {
  if (kind === 'image' && !info.items.some((item) => item.kind === 'image')) return 'Thumbnail';
  return KIND_LABELS[kind];
}

export function optionsOfKind(item: MediaItem, kind: SelectableKind): DownloadOption[] {
  return item.options.filter((option) => option.kind === kind);
}

export function defaultOption(item: MediaItem, kind: SelectableKind): DownloadOption | undefined {
  const candidates = optionsOfKind(item, kind);
  return candidates.find((option) => option.recommended) ?? candidates[0];
}

export function optionForItem(
  item: MediaItem,
  preferredKind: SelectableKind | undefined,
  preferredLabel?: string,
): DownloadOption | undefined {
  if (preferredKind) {
    const matched = preferredLabel
      ? optionsOfKind(item, preferredKind).find((option) => option.label === preferredLabel)
      : undefined;
    const chosen = matched ?? defaultOption(item, preferredKind);
    if (chosen) return chosen;
  }
  const anyRecommended = item.options.find((option) => option.recommended);
  return anyRecommended ?? item.options[0];
}

export function initialKind(info: MediaInfo): SelectableKind {
  const first = info.items[0];
  const recommended = first?.options.find((option) => option.recommended);
  return recommended?.kind ?? availableKinds(info)[0] ?? 'video';
}

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
  readonly totalBytes?: number;
  readonly anyApproximate: boolean;
  readonly fileCount: number;
}

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
