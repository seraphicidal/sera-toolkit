import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Vimeo videos, taken through the embed player.
 *
 * Vimeo's watch page no longer answers an anonymous client: the extractor reports
 * _"The web client only works when logged-in"_, and its other client — `android` —
 * refuses too, because it can only reuse OAuth tokens it was already given. Measured on
 * yt-dlp 2026.08.19, from a residential connection, so it is not about the address.
 *
 * `player.vimeo.com/video/<id>` is the same video served the way an embed on any other
 * site receives it, and it answers with the full format list: ten formats up to 720p on
 * the video this was measured against, with the title, uploader and thumbnail intact.
 * Nothing is bypassed — this is the public embed Vimeo publishes for the video.
 *
 * So the normalizer runs the other way round from how it used to. It rewrote the embed
 * form into the watch page, which is the one form that stopped working; a link that
 * arrived already working was converted into one that could not.
 */
export class VimeoProvider extends YtdlpProvider {
  readonly id = 'vimeo';
  readonly label = 'Vimeo';
  readonly hosts = ['vimeo.com', 'player.vimeo.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    // An album or a channel URL expands into its videos.
    gallery: true,
  });

  /** `/76979871`, `/channels/staffpicks/76979871`, `/groups/x/videos/76979871`. */
  private static readonly ID = /(?:^|\/)(\d{6,})(?:\/([0-9a-z]+))?\/?$/i;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (out.hostname.toLowerCase() === 'player.vimeo.com') return out;

    const match = VimeoProvider.ID.exec(out.pathname);
    if (!match?.[1]) return out;

    const embed = new URL(`https://player.vimeo.com/video/${match[1]}`);
    // An unlisted video carries its permission hash in the path; the embed takes it as
    // `h`. Without it the same link would resolve to "this video is private", which is
    // true of the embed and not of the link the visitor pasted.
    const hash = match[2] ?? out.searchParams.get('h');
    if (hash) embed.searchParams.set('h', hash);
    return embed;
  }
}
