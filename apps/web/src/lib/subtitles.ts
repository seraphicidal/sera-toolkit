import {
  SUBTITLE_EMBED_CONTAINERS,
  type DownloadOption,
  type MediaItem,
  type SubtitleFormat,
  type SubtitleRequest,
  type SubtitleTrack,
} from '@sera/contracts/types';

export interface SubtitleChoices {
  readonly tracks: readonly SubtitleTrack[];
  readonly canEmbed: boolean;
}

export function subtitleChoices(
  item: MediaItem | undefined,
  option: DownloadOption | undefined,
): SubtitleChoices | undefined {
  if (!item?.subtitles?.length || !option) return undefined;
  if (option.kind !== 'video' && option.kind !== 'audio') return undefined;
  return {
    tracks: item.subtitles,
    canEmbed: option.kind === 'video' && SUBTITLE_EMBED_CONTAINERS.includes(option.container),
  };
}

export const trackValue = (track: SubtitleTrack): string =>
  track.auto ? `${track.lang}:auto` : track.lang;

export function subtitleRequest(
  choices: SubtitleChoices | undefined,
  value: string,
  format: SubtitleFormat,
  only: boolean,
): SubtitleRequest | undefined {
  if (!choices || !value) return undefined;
  const track = choices.tracks.find((candidate) => trackValue(candidate) === value);
  if (!track) return undefined;
  const effective: SubtitleFormat = format === 'embed' && !choices.canEmbed ? 'srt' : format;
  return {
    lang: track.lang,
    ...(track.auto ? { auto: true } : {}),
    format: effective,
    ...(only && effective !== 'embed' ? { only: true } : {}),
  };
}
