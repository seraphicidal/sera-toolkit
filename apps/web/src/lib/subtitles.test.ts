import { describe, expect, it } from 'vitest';
import type { DownloadOption, MediaItem } from '@sera/contracts/types';
import { subtitleChoices, subtitleRequest, trackValue } from './subtitles';

const item = {
  subtitles: [
    { lang: 'en', label: 'English', auto: false },
    { lang: 'de-orig', label: 'German (auto-generated)', auto: true },
  ],
} as unknown as MediaItem;
const option = (kind: string, container: string) => ({ kind, container }) as DownloadOption;

describe('subtitleChoices', () => {
  it('is offered only for an item with tracks', () => {
    expect(
      subtitleChoices({ subtitles: [] } as unknown as MediaItem, option('video', 'mp4')),
    ).toBeUndefined();
    expect(subtitleChoices(item, undefined)).toBeUndefined();
    expect(subtitleChoices(item, option('video', 'mp4'))?.tracks).toHaveLength(2);
    expect(subtitleChoices(item, option('image', 'jpg'))).toBeUndefined();
  });

  it('allows embedding only in MP4, MKV and WebM video', () => {
    expect(subtitleChoices(item, option('video', 'mp4'))?.canEmbed).toBe(true);
    expect(subtitleChoices(item, option('video', 'webm'))?.canEmbed).toBe(true);
    expect(subtitleChoices(item, option('video', 'mov'))?.canEmbed).toBe(false);
    expect(subtitleChoices(item, option('audio', 'mp3'))?.canEmbed).toBe(false);
  });
});

describe('subtitleRequest', () => {
  const mp4 = subtitleChoices(item, option('video', 'mp4'));
  const mp3 = subtitleChoices(item, option('audio', 'mp3'));

  it('is nothing until a track is chosen', () => {
    expect(subtitleRequest(mp4, '', 'embed', false)).toBeUndefined();
    expect(subtitleRequest(mp4, 'fr', 'srt', false)).toBeUndefined();
  });

  it('names the track, and marks an auto-generated one', () => {
    expect(subtitleRequest(mp4, 'en', 'embed', false)).toEqual({ lang: 'en', format: 'embed' });
    expect(subtitleRequest(mp4, trackValue(item.subtitles![1]!), 'vtt', false)).toEqual({
      lang: 'de-orig',
      auto: true,
      format: 'vtt',
    });
  });

  it('falls back to a file where embedding is impossible, and never asks for an embed alone', () => {
    expect(subtitleRequest(mp3, 'en', 'embed', false)).toEqual({ lang: 'en', format: 'srt' });
    expect(subtitleRequest(mp4, 'en', 'embed', true)).toEqual({ lang: 'en', format: 'embed' });
    expect(subtitleRequest(mp4, 'en', 'srt', true)).toEqual({
      lang: 'en',
      format: 'srt',
      only: true,
    });
  });
});
