import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { hostMatches } from '../security/url.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class TumblrProvider extends YtdlpProvider {
  readonly id = 'tumblr';
  readonly label = 'Tumblr';
  readonly hosts = ['tumblr.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    authRequiredFor: ['photo posts'],
  });

  override canHandle(_url: URL, host: string): boolean {
    return hostMatches(host, 'tumblr.com');
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
