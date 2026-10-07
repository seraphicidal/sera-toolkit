import type { MediaKind, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { seraError } from '../errors.js';
import { discoverMedia, type DiscoveredMedia } from '../extract/html.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { isAllowed, parseRobots } from '../security/robots.js';
import { hostMatchesAny, urlExtension } from '../security/url.js';
import { truncate } from '../util/format.js';
import { normalizeContainer } from './direct.js';
import type {
  DownloadPlan,
  MediaProvider,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

export class GenericProvider implements MediaProvider {
  readonly id = 'generic';
  readonly label = 'Web page';
  readonly hosts: readonly string[] = [];
  readonly priority = 1000;

  readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
    residentialFallback: false,
  });

  private readonly delegate = new (class extends YtdlpProvider {
    readonly id = 'generic';
    readonly label = 'Web page';
    readonly hosts: readonly string[] = [];
  })();

  canHandle(): boolean {
    return true;
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    if (hostMatchesAny(url.hostname, context.config.extraAllowedHosts)) {
      return this.delegate.resolve(url, context);
    }

    const page = await this.readPage(url, context);
    if (!page.media.length) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `generic: no declared media on ${url.hostname}`,
      });
    }

    const hasPlayable = page.media.some((m) => m.kind === 'video' || m.kind === 'audio');
    const selected = (
      hasPlayable ? page.media.filter((m) => m.kind !== 'image') : page.media
    ).slice(0, context.config.maxItemsPerJob);

    const items: ResolvedItem[] = selected.map((media, index) => toItem(media, index));

    return {
      provider: this.id,
      providerLabel: page.siteName ?? this.label,
      url: url.toString(),
      type: items.length > 1 ? 'collection' : 'single',
      title: page.title ? truncate(page.title, 200) : url.hostname,
      ...(page.description ? { description: truncate(page.description, 500) } : {}),
      ...(page.author ? { author: page.author } : {}),
      ...(page.thumbnail ? { thumbnailUrl: page.thumbnail } : {}),
      items,
      metadata: { discoveredFrom: selected[0]?.source ?? 'unknown' },
    };
  }

  private async readPage(
    url: URL,
    context: ProviderContext,
  ): Promise<ReturnType<typeof discoverMedia>> {
    await assertRobotsAllows(url, context);
    const response = await context.fetchText(url, 2 * 1024 * 1024);
    return discoverMedia(response.body, new URL(response.url));
  }
}

async function assertRobotsAllows(url: URL, context: ProviderContext): Promise<void> {
  const robotsUrl = new URL('/robots.txt', url);
  let body: string;
  try {
    body = (await context.fetchText(robotsUrl, 512 * 1024)).body;
  } catch {
    return;
  }
  if (!isAllowed(parseRobots(body, 'sera-toolkit'), url.pathname)) {
    throw seraError('UNSUPPORTED_SOURCE', {
      message: 'This site asks not to be read automatically.',
      hint: 'Try a direct link to the media file instead.',
      detail: `robots.txt disallows ${url.pathname}`,
    });
  }
}

function toItem(media: DiscoveredMedia, index: number): ResolvedItem {
  const kind: MediaKind = media.kind === 'unknown' ? 'video' : media.kind;
  const extension = safeExtension(media.url);
  const container = normalizeContainer(media.mimeType ?? '', extension);

  const plans: DownloadPlan[] = [
    {
      kind: kind === 'gif' ? 'gif' : kind,
      container,
      label: 'Original',
      detail: container.toUpperCase(),
      ...(media.width ? { width: media.width } : {}),
      ...(media.height ? { height: media.height } : {}),
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'direct', url: media.url },
    },
  ];

  if (kind === 'video') {
    plans.push({
      kind: 'audio',
      container: 'mp3',
      label: 'MP3',
      detail: '320 kbps · extracted',
      audioBitrateKbps: 320,
      requiresConversion: true,
      recommended: true,
      fetch: { via: 'direct', url: media.url },
      convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
    });
  }

  return {
    sourceId: media.url,
    index,
    kind,
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    container,
    plans: ensureRecommendations(plans),
  };
}

function safeExtension(rawUrl: string): string {
  try {
    return urlExtension(new URL(rawUrl)) ?? '';
  } catch {
    return '';
  }
}
