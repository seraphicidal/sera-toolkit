import type { ProviderCapabilities } from '@sera/contracts/types';
import { SeraError, seraError } from '../errors.js';
import type { ProviderContext, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Instagram posts, reels and carousels.
 *
 * Playlist expansion is on so a carousel resolves to every slide rather than the first.
 * Nothing here attempts to reach private accounts or stories that require a session —
 * those simply fail with `PRIVATE_CONTENT`, which is the correct outcome.
 *
 * Reels and video posts resolve anonymously and work from this deployment. Photographs
 * do not, and the reason is not the extractor: measured against a real public post, the
 * post page returns a shell, `?__a=1` is a 404, `/api/v1/media/…/info/` redirects to a
 * login, and the GraphQL endpoint answers `require_login: true`. Instagram's own embed
 * endpoint no longer carries the media either. There is no supported third-party API
 * that returns an arbitrary public post's media — Basic Display and the Graph API only
 * reach accounts you own, and oEmbed returns a thumbnail and a blockquote.
 *
 * So a photo post gets a straight answer about what would be required, instead of an
 * extractor message about video that describes nothing the visitor did.
 */
export class InstagramProvider extends YtdlpProvider {
  readonly id = 'instagram';
  readonly label = 'Instagram';
  readonly hosts = ['instagram.com', 'instagr.am', 'ddinstagram.com'];
  override readonly priority = 20;

  /**
   * Reels and video posts resolve anonymously. Photographs do not: every anonymous
   * endpoint Instagram still serves either redirects to a login or answers
   * `require_login`, so this installation says so up front rather than failing per link.
   */
  override readonly capabilities: ProviderCapabilities = {
    video: true,
    image: false,
    carousel: false,
    audioExtraction: true,
    gif: false,
    authRequiredFor: ['photo posts', 'carousels'],
  };

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.hostname = 'www.instagram.com';
    out.protocol = 'https:';
    // Instagram serves the same post at /p/, /reel/ and /tv/; the extractor accepts all
    // three, and keeping the original avoids guessing wrong about which one exists.
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    try {
      return await super.resolve(url, context);
    } catch (error) {
      const failure = SeraError.from(error);
      // "No video in this post" means the extractor read the post and found photographs.
      // Everything anonymous that could return those now requires a session.
      if (failure.code !== 'UNSUPPORTED_SOURCE') throw failure;
      throw seraError('PROVIDER_AUTH_REQUIRED', {
        message: 'Instagram photo posts need an account, and this server does not have one.',
        hint: "Reels and video posts work. Instagram stopped serving photographs to anonymous clients, and offers no API that returns another account's posts.",
        detail: failure.detail ?? 'instagram: no video in post',
      });
    }
  }
}
