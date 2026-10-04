import {
  SUBTITLE_EMBED_CONTAINERS,
  type DownloadOption,
  type MediaItem,
  type SubtitleFormat,
  type SubtitleRequest,
  type SubtitleTrack,
} from '@sera/contracts/types';

/**
 * The subtitle choice for one item and the option picked for it.
 *
 * Embedding needs a video in a container that holds a soft subtitle track; everything else
 * can still take the track as a file beside it, or as the only thing downloaded.
 */
export interface SubtitleChoices {
  readonly tracks: readonly SubtitleTrack[];
  readonly canEmbed: boolean;
}

export function subtitleChoices(
  item: MediaItem | undefined,
  option: DownloadOption | undefined,
): SubtitleChoices | undefined {
  if (!item?.subtitles?.length || !option) return undefined;
  // A track belongs with the video or its sound, not with a thumbnail.
  if (option.kind !== 'video' && option.kind !== 'audio') return undefined;
  return {
    tracks: item.subtitles,
    canEmbed: option.kind === 'video' && SUBTITLE_EMBED_CONTAINERS.includes(option.container),
  };
}

/** A track's value in the language picker, and back: `en` or `en-orig:auto`. */
export const trackValue = (track: SubtitleTrack): string =>
  track.auto ? `${track.lang}:auto` : track.lang;

/** What the form sends, or nothing when no track is chosen or the choice no longer applies. */
export function subtitleRequest(
  choices: SubtitleChoices | undefined,
  value: string,
  format: SubtitleFormat,
  only: boolean,
): SubtitleRequest | undefined {
  if (!choices || !value) return undefined;
  const track = choices.tracks.find((candidate) => trackValue(candidate) === value);
  if (!track) return undefined;
  // An embed into a container that cannot hold it falls back to a file.
  const effective: SubtitleFormat = format === 'embed' && !choices.canEmbed ? 'srt' : format;
  return {
    lang: track.lang,
    ...(track.auto ? { auto: true } : {}),
    format: effective,
    ...(only && effective !== 'embed' ? { only: true } : {}),
  };
}
