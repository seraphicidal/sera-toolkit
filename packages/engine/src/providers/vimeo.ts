import type { ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class VimeoProvider extends YtdlpProvider {
  readonly id = 'vimeo';
  readonly label = 'Vimeo';
  readonly hosts = ['vimeo.com', 'player.vimeo.com'];
  override readonly priority = 30;

  override readonly capabilities: ProviderCapabilities = declare({
    gallery: true,
  });

  private static readonly ID = /(?:^|\/)(\d{6,})(?:\/([0-9a-z]+))?\/?$/i;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    out.protocol = 'https:';
    if (out.hostname.toLowerCase() === 'player.vimeo.com') return out;

    const match = VimeoProvider.ID.exec(out.pathname);
    if (!match?.[1]) return out;

    const embed = new URL(`https://player.vimeo.com/video/${match[1]}`);
    const hash = match[2] ?? out.searchParams.get('h');
    if (hash) embed.searchParams.set('h', hash);
    return embed;
  }
}
