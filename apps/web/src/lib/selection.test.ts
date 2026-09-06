import { describe, expect, it } from 'vitest';
import type { DownloadOption, MediaInfo, MediaItem } from '@sera/contracts/types';
import {
  availableKinds,
  defaultOption,
  initialKind,
  optionForItem,
  qualityLabels,
  resolveSelection,
} from './selection';

/**
 * The rules that decide what a click actually downloads.
 *
 * This is the frontend's only real logic, and the place a mistake would be invisible:
 * every failure mode here produces a plausible-looking interface that quietly fetches
 * the wrong thing.
 */

function option(
  partial: Partial<DownloadOption> & Pick<DownloadOption, 'id' | 'kind' | 'label'>,
): DownloadOption {
  return {
    itemId: 'item-0',
    container: 'mp4',
    requiresConversion: false,
    recommended: false,
    ...partial,
  };
}

function item(
  id: string,
  index: number,
  kind: MediaItem['kind'],
  options: DownloadOption[],
): MediaItem {
  return { id, index, kind, options };
}

function info(items: MediaItem[]): MediaInfo {
  return {
    id: 'info-1',
    provider: 'test',
    providerLabel: 'Test',
    url: 'https://example.com/post',
    type: items.length > 1 ? 'collection' : 'single',
    title: 'A post',
    items,
    expiresIn: 3600,
  };
}

const videoItem = item('i0', 1, 'video', [
  option({ id: 'v1080', kind: 'video', label: '1080p', filesizeBytes: 100, recommended: true }),
  option({ id: 'v720', kind: 'video', label: '720p', filesizeBytes: 50 }),
  option({
    id: 'mp3',
    kind: 'audio',
    label: 'MP3',
    container: 'mp3',
    filesizeBytes: 10,
    recommended: true,
  }),
  option({ id: 'wav', kind: 'audio', label: 'WAV', container: 'wav', filesizeBytes: 90 }),
]);

const imageItem = item('i1', 2, 'image', [
  option({
    id: 'img',
    kind: 'image',
    label: 'Original',
    container: 'jpg',
    filesizeBytes: 5,
    recommended: true,
  }),
]);

describe('availableKinds', () => {
  it('lists only the kinds the source actually has, in display order', () => {
    expect(availableKinds(info([videoItem]))).toEqual(['video', 'audio']);
    expect(availableKinds(info([imageItem]))).toEqual(['image']);
    expect(availableKinds(info([videoItem, imageItem]))).toEqual(['video', 'audio', 'image']);
  });
});

describe('initialKind', () => {
  it('opens on whatever the engine marked as the default', () => {
    expect(initialKind(info([videoItem]))).toBe('video');
    expect(initialKind(info([imageItem]))).toBe('image');
  });

  it('falls back to the first available kind when nothing is marked', () => {
    const unmarked = item('x', 1, 'audio', [option({ id: 'a', kind: 'audio', label: 'MP3' })]);
    expect(initialKind(info([unmarked]))).toBe('audio');
  });
});

describe('defaultOption', () => {
  it('prefers the engine’s recommendation', () => {
    expect(defaultOption(videoItem, 'video')?.id).toBe('v1080');
    expect(defaultOption(videoItem, 'audio')?.id).toBe('mp3');
  });

  it('returns nothing for a kind the item does not have', () => {
    expect(defaultOption(imageItem, 'video')).toBeUndefined();
  });
});

describe('optionForItem', () => {
  it('honours an exact label when the item has it', () => {
    expect(optionForItem(videoItem, 'video', '720p')?.id).toBe('v720');
  });

  it('falls back to the recommended option of that kind when the label is absent', () => {
    expect(optionForItem(videoItem, 'video', '4K')?.id).toBe('v1080');
  });

  it('falls back to the item’s own default when the kind does not apply', () => {
    // This is what lets one control drive a post of mixed videos and photos.
    expect(optionForItem(imageItem, 'audio', 'MP3')?.id).toBe('img');
    expect(optionForItem(imageItem, 'video', '1080p')?.id).toBe('img');
  });
});

describe('qualityLabels', () => {
  it('deduplicates across the selected items', () => {
    const second = item('i2', 2, 'video', [
      option({ id: 'x1080', kind: 'video', label: '1080p' }),
      option({ id: 'x480', kind: 'video', label: '480p' }),
    ]);
    const both = new Set(['i0', 'i2']);
    expect(qualityLabels(info([videoItem, second]), 'video', both)).toEqual([
      '1080p',
      '720p',
      '480p',
    ]);
  });

  it('ignores items that are not selected', () => {
    const second = item('i2', 2, 'video', [option({ id: 'x480', kind: 'video', label: '480p' })]);
    expect(qualityLabels(info([videoItem, second]), 'video', new Set(['i0']))).toEqual([
      '1080p',
      '720p',
    ]);
  });
});

describe('resolveSelection', () => {
  it('resolves one item to one option', () => {
    const result = resolveSelection(info([videoItem]), new Set(['i0']), 'video', '720p');
    expect(result.optionIds).toEqual(['v720']);
    expect(result.fileCount).toBe(1);
    expect(result.totalBytes).toBe(50);
  });

  it('applies the preference per item and falls back where it does not fit', () => {
    const result = resolveSelection(
      info([videoItem, imageItem]),
      new Set(['i0', 'i1']),
      'audio',
      'WAV',
    );
    // The video yields WAV; the photo cannot, so it yields itself.
    expect(result.optionIds).toEqual(['wav', 'img']);
    expect(result.totalBytes).toBe(95);
  });

  it('skips items that are not selected', () => {
    const result = resolveSelection(
      info([videoItem, imageItem]),
      new Set(['i1']),
      'video',
      '1080p',
    );
    expect(result.optionIds).toEqual(['img']);
  });

  it('reports no total when any chosen option has no known size', () => {
    // Better to show nothing than to show a total that is quietly missing a file.
    const unsized = item('i3', 3, 'video', [
      option({ id: 'u', kind: 'video', label: '1080p', recommended: true }),
    ]);
    const result = resolveSelection(
      info([videoItem, unsized]),
      new Set(['i0', 'i3']),
      'video',
      '1080p',
    );
    expect(result.optionIds).toEqual(['v1080', 'u']);
    expect(result.totalBytes).toBeUndefined();
  });

  it('flags an estimate when any chosen option is approximate', () => {
    const approx = item('i4', 4, 'video', [
      option({
        id: 'a',
        kind: 'video',
        label: '1080p',
        filesizeBytes: 10,
        filesizeIsApproximate: true,
        recommended: true,
      }),
    ]);
    const result = resolveSelection(info([approx]), new Set(['i4']), 'video', '1080p');
    expect(result.anyApproximate).toBe(true);
  });

  it('resolves an empty selection to nothing, not to everything', () => {
    const result = resolveSelection(info([videoItem, imageItem]), new Set(), 'video', '1080p');
    expect(result.optionIds).toEqual([]);
    expect(result.fileCount).toBe(0);
  });
});
