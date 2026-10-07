import type { SubtitleTrack } from '@sera/contracts/types';
import type { YtdlpInfo } from '../extract/ytdlp-types.js';

export function subtitleTracks(entry: YtdlpInfo): SubtitleTrack[] {
  const manual = Object.entries(entry.subtitles ?? {}).filter(([lang]) => lang !== 'live_chat');
  const automatic = Object.keys(entry.automatic_captions ?? {});

  const tracks: SubtitleTrack[] = manual.map(([lang, renditions]) => ({
    lang,
    label: renditions.find((r) => r.name)?.name ?? languageName(lang),
    auto: false,
  }));

  const original =
    automatic.find((lang) => lang.endsWith('-orig')) ??
    (entry.language && automatic.includes(entry.language) ? entry.language : undefined);
  if (original) {
    const base = baseLanguage(original.replace(/-orig$/, ''));
    if (!tracks.some((track) => baseLanguage(track.lang) === base)) {
      tracks.push({ lang: original, label: `${languageName(base)} (auto-generated)`, auto: true });
    }
  }
  return tracks;
}

function baseLanguage(lang: string): string {
  return lang.split(/[-_]/)[0]!.toLowerCase();
}

const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });

export function languageName(lang: string): string {
  const code = lang.replace(/-orig$/, '');
  if (baseLanguage(code) === 'und') return 'Unknown language';
  try {
    return names.of(code) ?? lang;
  } catch {
    return lang;
  }
}
