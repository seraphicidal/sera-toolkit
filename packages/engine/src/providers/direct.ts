import type { ContainerFormat, MediaKind } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import { MEDIA_EXTENSIONS, urlExtension } from '../security/url.js';
import { formatBytes } from '../util/format.js';
import { sanitizeStem } from '../util/filename.js';
import type {
  DownloadPlan,
  MediaProvider,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './types.js';
import { ensureRecommendations } from '../normalize/plans.js';

/**
 * A link that points straight at a media file.
 *
 * The provider only claims URLs whose path already ends in a media extension. Without
 * that gate it would claim every URL on the internet, turn the service into an open web
 * proxy, and bury genuine "this source isn't supported" answers under confusing
 * download failures. A HEAD request then confirms the server agrees about the type
 * before any option is offered.
 */
export class DirectFileProvider implements MediaProvider {
  readonly id = 'direct';
  readonly label = 'Direct file';
  readonly hosts: readonly string[] = [];
  readonly priority = 900;

  canHandle(url: URL): boolean {
    const extension = urlExtension(url);
    return Boolean(extension && MEDIA_EXTENSIONS.has(extension));
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const head = await context.head(url);
    if (head.status >= 400) {
      throw seraError(head.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
        detail: `HEAD ${head.status}`,
      });
    }

    const extension = urlExtension(url) ?? '';
    const contentType = (head.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const kind = classify(contentType, extension);

    if (kind === 'unknown') {
      throw seraError('UNSUPPORTED_SOURCE', {
        message: "That link doesn't point to a media file.",
        detail: `content-type ${contentType || '(none)'} for .${extension}`,
      });
    }
    if (head.contentLength && head.contentLength > context.config.maxFilesizeBytes) {
      throw seraError('TOO_LARGE', {
        detail: `${head.contentLength} bytes exceeds limit`,
      });
    }

    const container = normalizeContainer(contentType, extension);
    const filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'file');
    const title = sanitizeStem(filename.replace(/\.[^.]+$/, ''), 'Media file');

    const plans: DownloadPlan[] = [
      {
        kind: kind === 'gif' ? 'gif' : kind,
        container,
        label: 'Original',
        detail: [
          container.toUpperCase(),
          head.contentLength ? formatBytes(head.contentLength) : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        ...(head.contentLength ? { filesizeBytes: head.contentLength } : {}),
        requiresConversion: false,
        recommended: true,
        fetch: { via: 'direct', url: head.url },
      },
    ];

    // Only offer conversions the source can actually satisfy: extracting audio from a
    // JPEG, or making a GIF of a two-hour file, would be an option that always fails.
    if (kind === 'video') {
      plans.push(
        audioPlan('mp3', 'MP3', 320, head.url),
        audioPlan('m4a', 'M4A', 256, head.url),
        audioPlan('wav', 'WAV', undefined, head.url),
      );
    }
    if (kind === 'gif') {
      plans.push(
        convertedVideoPlan('mp4', 'MP4', head.url),
        convertedVideoPlan('webm', 'WebM', head.url),
      );
    }

    const item: ResolvedItem = {
      sourceId: 'file',
      index: 0,
      kind,
      title,
      container,
      ...(head.contentLength ? { filesizeBytes: head.contentLength } : {}),
      plans: ensureRecommendations(plans),
    };

    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: 'single',
      title,
      author: url.hostname,
      items: [item],
      metadata: { contentType: contentType || 'unknown' },
    };
  }
}

function audioPlan(
  container: Extract<ContainerFormat, 'mp3' | 'm4a' | 'wav'>,
  label: string,
  bitrate: number | undefined,
  url: string,
): DownloadPlan {
  return {
    kind: 'audio',
    container,
    label,
    detail: bitrate ? `${bitrate} kbps · extracted` : 'Lossless · extracted',
    ...(bitrate ? { audioBitrateKbps: bitrate } : {}),
    requiresConversion: true,
    recommended: container === 'mp3',
    fetch: { via: 'direct', url },
    convert: { kind: 'audio', container, ...(bitrate ? { bitrateKbps: bitrate } : {}) },
  };
}

function convertedVideoPlan(
  container: Extract<ContainerFormat, 'mp4' | 'webm'>,
  label: string,
  url: string,
): DownloadPlan {
  return {
    kind: 'video',
    container,
    label,
    detail: `Converted from GIF · ${container === 'mp4' ? 'H.264' : 'VP9'}`,
    requiresConversion: true,
    recommended: false,
    fetch: { via: 'direct', url },
    convert: { kind: 'video', container },
  };
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'wma']);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ts', 'm3u8', 'mpd']);

/**
 * Decides what a file is, trusting the server's `Content-Type` over the extension.
 *
 * A `.mp4` served as `text/html` is a redirect page or an error, not a video, and
 * treating it as one produces a download of a 404 page.
 */
export function classify(contentType: string, extension: string): MediaKind {
  // The extension only decides when the server said nothing, exactly as below. Without
  // that guard a file-description page — commons.wikimedia.org/wiki/File:x.gif, served as
  // text/html — was classified as a GIF, and the pipeline handed the visitor 150 KB of
  // markup named .gif.
  if (contentType === 'image/gif' || (!contentType && extension === 'gif')) return 'gif';
  if (contentType.startsWith('image/') || (!contentType && IMAGE_EXTS.has(extension)))
    return 'image';
  if (contentType.startsWith('video/') || (!contentType && VIDEO_EXTS.has(extension)))
    return 'video';
  if (contentType.startsWith('audio/') || (!contentType && AUDIO_EXTS.has(extension)))
    return 'audio';

  // Generic binary types are common on object storage; fall back to the extension.
  if (contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
    if (VIDEO_EXTS.has(extension)) return 'video';
    if (AUDIO_EXTS.has(extension)) return 'audio';
    if (IMAGE_EXTS.has(extension)) return 'image';
  }
  // Streaming manifests announce themselves with their own types.
  if (contentType.includes('mpegurl') || contentType.includes('dash+xml')) return 'video';
  return 'unknown';
}

export function normalizeContainer(contentType: string, extension: string): ContainerFormat {
  const fromType: Record<string, ContainerFormat> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/opus': 'opus',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
  };
  const mapped = fromType[contentType];
  if (mapped) return mapped;

  const normalized = extension === 'jpeg' ? 'jpg' : extension === 'm4v' ? 'mp4' : extension;
  const known: readonly string[] = [
    'mp4',
    'webm',
    'mov',
    'mkv',
    'mp3',
    'm4a',
    'aac',
    'opus',
    'ogg',
    'wav',
    'flac',
    'gif',
    'jpg',
    'png',
    'webp',
    'avif',
  ];
  return (known.includes(normalized) ? normalized : 'bin') as ContainerFormat;
}
