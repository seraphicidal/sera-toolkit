import { seraError } from '../errors.js';
import { YtdlpProvider } from './ytdlp-base.js';
import type { ProviderContext, ResolvedMedia } from './types.js';

/**
 * Snapchat Spotlight and public profile media.
 *
 * Only the public surfaces are addressable. Personal snaps and stories require an
 * account and are refused before any request is made, rather than attempted and failed —
 * the tool has no business trying to reach content that is not published.
 */
export class SnapchatProvider extends YtdlpProvider {
  readonly id = 'snapchat';
  readonly label = 'Snapchat';
  readonly hosts = ['snapchat.com', 't.snapchat.com'];
  override readonly priority = 40;

  /** The two public surfaces: Spotlight posts and a public profile's shared media. */
  private static readonly PUBLIC_PATH = /^\/(spotlight|add|p|t)\//;

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    if (!SnapchatProvider.PUBLIC_PATH.test(url.pathname)) {
      throw seraError('PRIVATE_CONTENT', {
        message: 'Only public Snapchat Spotlight posts can be processed.',
        detail: 'snapchat: path is not a public surface',
      });
    }
    return super.resolve(url, context);
  }
}
