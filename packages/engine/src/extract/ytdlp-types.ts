/**
 * The subset of yt-dlp's JSON output the engine relies on.
 *
 * Everything is optional. yt-dlp normalizes across hundreds of extractors and any given
 * field may simply be absent, so the engine treats a missing value as unknown rather
 * than as an error — that is what lets one code path serve a YouTube video and a
 * Mastodon image attachment.
 */

export interface YtdlpThumbnail {
  readonly url?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly preference?: number | null;
  readonly id?: string;
}

export interface YtdlpFragment {
  readonly url?: string;
  readonly duration?: number | null;
}

export interface YtdlpFormat {
  readonly format_id?: string;
  readonly format_note?: string | null;
  readonly format?: string;
  readonly ext?: string;
  readonly protocol?: string;
  readonly acodec?: string | null;
  readonly vcodec?: string | null;
  readonly audio_ext?: string | null;
  readonly video_ext?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly fps?: number | null;
  /** Total bitrate, kbps. */
  readonly tbr?: number | null;
  /** Audio bitrate, kbps. */
  readonly abr?: number | null;
  /** Video bitrate, kbps. */
  readonly vbr?: number | null;
  /** Audio sample rate, Hz. */
  readonly asr?: number | null;
  readonly filesize?: number | null;
  readonly filesize_approx?: number | null;
  readonly url?: string;
  readonly container?: string | null;
  readonly dynamic_range?: string | null;
  readonly language?: string | null;
  readonly quality?: number | null;
  readonly preference?: number | null;
  readonly fragments?: readonly YtdlpFragment[];
  readonly resolution?: string | null;
}

export type YtdlpEntryType = 'video' | 'playlist' | 'multi_video' | 'url' | 'url_transparent';

export interface YtdlpInfo {
  readonly id?: string;
  readonly _type?: YtdlpEntryType;
  readonly title?: string | null;
  readonly fulltitle?: string | null;
  readonly description?: string | null;
  readonly uploader?: string | null;
  readonly uploader_id?: string | null;
  readonly uploader_url?: string | null;
  readonly channel?: string | null;
  readonly channel_url?: string | null;
  readonly creator?: string | null;
  readonly webpage_url?: string | null;
  readonly original_url?: string | null;
  readonly extractor?: string | null;
  readonly extractor_key?: string | null;
  /** Seconds. */
  readonly duration?: number | null;
  readonly thumbnail?: string | null;
  readonly thumbnails?: readonly YtdlpThumbnail[];
  /** `YYYYMMDD`. */
  readonly upload_date?: string | null;
  readonly timestamp?: number | null;
  readonly release_timestamp?: number | null;
  readonly formats?: readonly YtdlpFormat[];
  readonly entries?: readonly (YtdlpInfo | null)[];
  readonly is_live?: boolean | null;
  readonly was_live?: boolean | null;
  readonly live_status?: string | null;
  readonly ext?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly url?: string | null;
  readonly vcodec?: string | null;
  readonly acodec?: string | null;
  readonly filesize?: number | null;
  readonly filesize_approx?: number | null;
  readonly view_count?: number | null;
  readonly like_count?: number | null;
  readonly playlist_count?: number | null;
  readonly age_limit?: number | null;
  readonly availability?: string | null;
  readonly requested_downloads?: readonly { readonly filepath?: string }[];
}

/** Treats yt-dlp's `null`, `undefined` and the literal string `NA` as absent. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== 'NA' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** As `num`, but for strings; also rejects yt-dlp's `none` placeholder. */
export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'NA' || trimmed === 'none' || trimmed === 'null') return undefined;
  return trimmed;
}
