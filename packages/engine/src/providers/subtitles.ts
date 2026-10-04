import type { SubtitleTrack } from '@sera/contracts/types';
import type { YtdlpInfo } from '../extract/ytdlp-types.js';

/**
 * The subtitle tracks worth offering for one yt-dlp entry.
 *
 * A YouTube video lists its manual tracks — written by people — and around 160 automatic
 * ones: the speech recognised in the original language (keyed `en-orig`), and that same text
 * machine-translated into every other language. The list a person sees is the manual tracks,
 * and the original-language automatic track where no manual track covers that language,
 * labelled as auto-generated. Translations of a machine transcript are left out.
 */
export function subtitleTracks(entry: YtdlpInfo): SubtitleTrack[] {
  const manual = Object.entries(entry.subtitles ?? {}).filter(([lang]) => lang !== 'live_chat');
  const automatic = Object.keys(entry.automatic_captions ?? {});

  const tracks: SubtitleTrack[] = manual.map(([lang, renditions]) => ({
    lang,
    label: renditions.find((r) => r.name)?.name ?? languageName(lang),
    auto: false,
  }));

  // The original language's automatic track: yt-dlp marks it `-orig`; without the marker,
  // the entry's own language, where yt-dlp reports one.
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

/** `de-DE` → `de`; `en-eEY6OEpapPo` (a named YouTube track) → `en`. */
function baseLanguage(lang: string): string {
  return lang.split(/[-_]/)[0]!.toLowerCase();
}

const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });

/** "German (Germany)" for `de-DE`, the code itself for anything unrecognised. */
export function languageName(lang: string): string {
  const code = lang.replace(/-orig$/, '');
  // `und` is "undetermined", which Intl names "root", after its locale data; YouTube uses it
  // for a track whose uploader set no language.
  if (baseLanguage(code) === 'und') return 'Unknown language';
  try {
    return names.of(code) ?? lang;
  } catch {
    return lang;
  }
}
