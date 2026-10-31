import type { ContainerFormat, MediaKind, ProviderCapabilities } from '@sera/contracts/types';
import { declare } from './capabilities.js';
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

export class DirectFileProvider implements MediaProvider {
  readonly id = 'direct';
  readonly label = 'Direct file';
  readonly hosts: readonly string[] = [];
  readonly priority = 900;

  readonly capabilities: ProviderCapabilities = declare({
    image: true,
    gif: true,
    residentialFallback: false,
  });

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

    const isManifest =
      extension === 'm3u8' ||
      extension === 'mpd' ||
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml');
    const container: ContainerFormat = isManifest
      ? 'mp4'
      : normalizeContainer(contentType, extension);
    const rawSegment = url.pathname.split('/').filter(Boolean).pop() ?? 'file';
    let filename = rawSegment;
    try {
      filename = decodeURIComponent(rawSegment);
    } catch {}
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
        fetch: isManifest
          ? {
              via: 'ytdlp',
              selector: 'bestvideo+bestaudio/best',
              merge: 'mp4',
              target: head.url,
              useExtractors: 'default',
            }
          : { via: 'direct', url: head.url },
      },
    ];

    if (kind === 'video') {
      plans.push(
        audioPlan('mp3', 'MP3', 320, head.url, isManifest),
        audioPlan('m4a', 'M4A', 256, head.url, isManifest),
        audioPlan('wav', 'WAV', undefined, head.url, isManifest),
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
  isManifest = false,
): DownloadPlan {
  return {
    kind: 'audio',
    container,
    label,
    detail: bitrate ? `${bitrate} kbps · extracted` : 'Lossless · extracted',
    ...(bitrate ? { audioBitrateKbps: bitrate } : {}),
    requiresConversion: true,
    recommended: container === 'mp3',
    fetch: isManifest
      ? {
          via: 'ytdlp',
          selector: 'bestaudio/best',
          audio: {
            format: container,
            ...(bitrate ? { quality: `${bitrate}K` } : { quality: '0' }),
          },
          target: url,
          useExtractors: 'default',
        }
      : { via: 'direct', url },
    ...(isManifest
      ? {}
      : { convert: { kind: 'audio', container, ...(bitrate ? { bitrateKbps: bitrate } : {}) } }),
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
export const ARCHIVE_DOC_EXTS = new Set([
  'pdf',
  'iso',
  'zip',
  'tar',
  '7z',
  'apk',
  'dmg',
  'exe',
  'epub',
]);

const ARCHIVE_DOC_MIMES: Readonly<Record<string, ContainerFormat>> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-tar': 'tar',
  'application/tar': 'tar',
  'application/x-gtar': 'tar',
  'application/x-7z-compressed': '7z',
  'application/vnd.android.package-archive': 'apk',
  'application/x-apple-diskimage': 'dmg',
  'application/x-iso9660-image': 'iso',
  'application/x-cd-image': 'iso',
  'application/x-msdownload': 'exe',
  'application/x-msdos-program': 'exe',
  'application/x-executable': 'exe',
  'application/vnd.microsoft.portable-executable': 'exe',
  'application/epub+zip': 'epub',
};

export function classify(contentType: string, extension: string): MediaKind {
  if (contentType === 'image/gif' || (!contentType && extension === 'gif')) return 'gif';
  if (contentType.startsWith('image/') || (!contentType && IMAGE_EXTS.has(extension)))
    return 'image';
  if (contentType.startsWith('video/') || (!contentType && VIDEO_EXTS.has(extension)))
    return 'video';
  if (contentType.startsWith('audio/') || (!contentType && AUDIO_EXTS.has(extension)))
    return 'audio';
  if (
    Object.hasOwn(ARCHIVE_DOC_MIMES, contentType) ||
    (!contentType && ARCHIVE_DOC_EXTS.has(extension))
  )
    return 'image';

  if (contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
    if (VIDEO_EXTS.has(extension)) return 'video';
    if (AUDIO_EXTS.has(extension)) return 'audio';
    if (IMAGE_EXTS.has(extension)) return 'image';
    if (ARCHIVE_DOC_EXTS.has(extension)) return 'image';
  }
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
    ...ARCHIVE_DOC_MIMES,
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
    'pdf',
    'iso',
    'zip',
    'tar',
    '7z',
    'apk',
    'dmg',
    'exe',
    'epub',
  ];
  return (known.includes(normalized) ? normalized : 'bin') as ContainerFormat;
}
