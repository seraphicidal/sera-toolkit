import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import { readViaEmbed } from './threads-embed.js';
import type { ProviderContext } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class ThreadsProvider extends YtdlpProvider {
  readonly id = 'threads';
  readonly label = 'Threads';
  readonly hosts = ['threads.net', 'threads.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
  });

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    out.hostname = 'www.threads.com';
    return out;
  }

  protected override strategies(
    _url: URL,
    _context: ProviderContext,
  ): readonly ExtractionStrategy[] {
    return [
      {
        id: 'embed',
        label: 'the public embed',
        run: (target, ctx) =>
          readViaEmbed(
            target,
            (endpoint, maxBytes, options) => ctx.fetchText(endpoint, maxBytes, options),
            ctx.config.maxItemsPerJob,
          ),
      },
    ];
  }
}
