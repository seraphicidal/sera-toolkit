import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class ThreadsProvider extends YtdlpProvider {
  readonly id = 'threads';
  readonly label = 'Threads';
  readonly hosts = ['threads.net', 'threads.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare();

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    out.hostname = 'www.threads.net';
    return out;
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }
}
