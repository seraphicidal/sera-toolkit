import { seraError } from '../errors.js';
import { YtdlpProvider } from './ytdlp-base.js';
import type { ProviderContext, ResolvedMedia } from './types.js';

export class SnapchatProvider extends YtdlpProvider {
  readonly id = 'snapchat';
  readonly label = 'Snapchat';
  readonly hosts = ['snapchat.com', 't.snapchat.com'];
  override readonly priority = 40;

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
