import type { MediaKind, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
import { SeraError, seraError } from '../errors.js';
import { extractWithGalleryDl } from '../extract/gallerydl.js';
import { discoverMedia, type DiscoveredMedia } from '../extract/html.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { isAllowed, parseRobots } from '../security/robots.js';
import { hostMatchesAny, MEDIA_EXTENSIONS, parseUserUrl, urlExtension } from '../security/url.js';
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
    protected override useExtractors(): string {
      return 'default';
    }
  })();

  canHandle(): boolean {
    return true;
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    await assertRobotsAllows(url, context);

    if (hostMatchesAny(url.hostname, context.config.extraAllowedHosts)) {
      return this.delegate.resolve(url, context);
    }

    const directExt = urlExtension(url);
    if (directExt === 'm3u8' || directExt === 'mpd') {
      const item = toItem({ url: url.toString(), kind: 'video', source: 'video' }, 0);
      return {
        provider: this.id,
        providerLabel: this.label,
        url: url.toString(),
        type: 'single',
        title: url.hostname,
        items: [item],
        metadata: { discoveredFrom: 'manifest' },
      };
    }

    let page: ReturnType<typeof discoverMedia> | undefined;
    try {
      page = await this.readPage(url, context, true);
    } catch (error) {
      if (
        error instanceof SeraError &&
        (error.code === 'BLOCKED_ADDRESS' ||
          error.code === 'DRM_PROTECTED' ||
          error.detail?.startsWith('robots.txt disallows'))
      ) {
        throw error;
      }
    }

    if (page?.drmProtected && !page.media.length) {
      throw seraError('DRM_PROTECTED', {
        detail: `generic: DRM protected media on ${url.hostname}`,
      });
    }

    if (page && page.media.length > 0) {
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

    if (page && directExt && MEDIA_EXTENSIONS.has(directExt)) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `generic: no declared media on ${url.hostname}`,
      });
    }

    try {
      return await this.delegate.resolve(url, context);
    } catch (delegateError) {
      if (
        delegateError instanceof SeraError &&
        delegateError.code !== 'UNSUPPORTED_SOURCE' &&
        delegateError.code !== 'MEDIA_UNAVAILABLE'
      ) {
        throw delegateError;
      }
    }

    try {
      return await extractWithGalleryDl(url, context);
    } catch (galleryError) {
      if (galleryError instanceof SeraError && galleryError.code === 'BLOCKED_ADDRESS') {
        throw galleryError;
      }
    }

    throw seraError('UNSUPPORTED_SOURCE', {
      detail: `generic: no declared media on ${url.hostname}`,
    });
  }

  private async readPage(
    url: URL,
    context: ProviderContext,
    robotsChecked = false,
  ): Promise<ReturnType<typeof discoverMedia>> {
    if (!robotsChecked) {
      await assertRobotsAllows(url, context);
    }
    const response = await context.fetchText(url, 2 * 1024 * 1024);
    const resolvedUrl = response.url || url.toString();
    const parsed = parseUserUrl(resolvedUrl, {
      allowPrivateAddresses: context.config.allowPrivateAddresses,
    });
    if (hostMatchesAny(parsed.url.hostname, context.config.blockedHosts)) {
      throw seraError('BLOCKED_ADDRESS', {
        detail: `redirect to blocked host ${parsed.url.hostname}`,
      });
    }
    return discoverMedia(response.body, parsed.url);
  }
}

export async function assertRobotsAllows(url: URL, context: ProviderContext): Promise<void> {
  const allowPrivateAddresses = context.config.allowPrivateAddresses;
  parseUserUrl(url.toString(), { allowPrivateAddresses });
  if (hostMatchesAny(url.hostname, context.config.blockedHosts)) {
    throw seraError('BLOCKED_ADDRESS', { detail: `blocked host ${url.hostname}` });
  }
  const robotsUrl = new URL('/robots.txt', url);
  parseUserUrl(robotsUrl.toString(), { allowPrivateAddresses });

  let response: { body: string; url: string };
  try {
    response = await context.fetchText(robotsUrl, 512 * 1024);
  } catch (error) {
    if (error instanceof SeraError && error.code === 'BLOCKED_ADDRESS') {
      throw error;
    }
    return;
  }

  if (response.url) {
    const redirected = parseUserUrl(response.url, { allowPrivateAddresses });
    if (hostMatchesAny(redirected.url.hostname, context.config.blockedHosts)) {
      throw seraError('BLOCKED_ADDRESS', {
        detail: `redirect to blocked host ${redirected.url.hostname}`,
      });
    }
  }

  if (!isAllowed(parseRobots(response.body, 'sera-toolkit'), url.pathname)) {
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
  const mime = (media.mimeType ?? '').toLowerCase();
  const isManifest =
    extension === 'm3u8' ||
    extension === 'mpd' ||
    mime.includes('mpegurl') ||
    mime.includes('dash+xml');
  const container = isManifest ? 'mp4' : normalizeContainer(media.mimeType ?? '', extension);

  if (isManifest) {
    const plans: DownloadPlan[] = [
      {
        kind: 'video',
        container: 'mp4',
        label: 'Original',
        detail: extension === 'mpd' ? 'MP4 · DASH stream' : 'MP4 · HLS stream',
        ...(media.width ? { width: media.width } : {}),
        ...(media.height ? { height: media.height } : {}),
        requiresConversion: false,
        recommended: true,
        fetch: {
          via: 'ytdlp',
          selector: 'bestvideo+bestaudio/best',
          merge: 'mp4',
          target: media.url,
          useExtractors: 'default',
        },
      },
      {
        kind: 'audio',
        container: 'mp3',
        label: 'MP3',
        detail: '320 kbps · extracted',
        audioBitrateKbps: 320,
        requiresConversion: true,
        recommended: true,
        fetch: {
          via: 'ytdlp',
          selector: 'bestaudio/best',
          audio: { format: 'mp3', quality: '320K' },
          target: media.url,
          useExtractors: 'default',
        },
      },
    ];

    return {
      sourceId: media.url,
      index,
      kind: 'video',
      ...(media.width ? { width: media.width } : {}),
      ...(media.height ? { height: media.height } : {}),
      container: 'mp4',
      plans: ensureRecommendations(plans),
    };
  }

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
