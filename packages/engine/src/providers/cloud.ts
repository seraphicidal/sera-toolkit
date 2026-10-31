import type { ContainerFormat, MediaKind, ProviderCapabilities } from '@sera/contracts/types';
import * as cheerio from 'cheerio';
import { seraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatches, hostMatchesAny, parseUserUrl, urlExtension } from '../security/url.js';
import { sanitizeStem } from '../util/filename.js';
import { formatBytes } from '../util/format.js';
import { declare } from './capabilities.js';
import { classify, normalizeContainer } from './direct.js';
import type {
  DownloadPlan,
  MediaProvider,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

export function extractGoogleDriveId(url: URL): string | undefined {
  const pathMatch = /\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]{6,})/i.exec(
    url.pathname,
  );
  if (pathMatch?.[1]) return pathMatch[1];
  const queryId = url.searchParams.get('id');
  if (queryId && /^[a-zA-Z0-9_-]{6,}$/.test(queryId)) return queryId;
  return undefined;
}

export function extractGoogleDriveConfirmUrl(html: string, base: URL): URL | undefined {
  const $ = cheerio.load(html);
  const form = $('form#download-form, form[action*="download"]').first();
  if (!form.length) return undefined;
  const action = form.attr('action');
  if (!action) return undefined;
  try {
    const target = new URL(action, base);
    form.find('input[name]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value');
      if (name && value !== undefined) {
        target.searchParams.set(name, value);
      }
    });
    if (!target.searchParams.has('confirm')) {
      target.searchParams.set('confirm', 't');
    }
    return target;
  } catch {
    return undefined;
  }
}

export function extractMediaFireDirectUrl(html: string): string | undefined {
  const $ = cheerio.load(html);
  const button = $('#downloadButton, a.popsok[href*="mediafire.com"]').first();
  const scrambled = button.attr('data-scrambled-url');
  if (scrambled) {
    try {
      const decoded = Buffer.from(scrambled, 'base64').toString('utf8').trim();
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {}
  }
  const href = button.attr('href');
  if (href && /^https?:\/\/download[0-9]*\.mediafire\.com\//i.test(href.trim())) {
    return href.trim();
  }
  const regexMatch = /https?:\/\/download[0-9]*\.mediafire\.com\/[^\s"'<>]+/i.exec(html);
  return regexMatch?.[0];
}

function filenameFromUrl(rawUrl: string, fallback: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    if (!segment) return fallback;
    return decodeURIComponent(segment);
  } catch {
    return fallback;
  }
}

function buildCloudMedia(options: {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly sourceUrl: URL;
  readonly downloadUrl: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly maxFilesizeBytes: number;
}): ResolvedMedia {
  const contentType = (options.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'text/html' || contentType === 'text/plain') {
    throw seraError('UNSUPPORTED_SOURCE', {
      message: "That link doesn't point to a downloadable file.",
      detail: `${options.providerId}: received ${contentType}`,
    });
  }

  if (options.contentLength && options.contentLength > options.maxFilesizeBytes) {
    throw seraError('TOO_LARGE', {
      detail: `${options.contentLength} bytes exceeds limit`,
    });
  }

  let ext = '';
  try {
    ext =
      urlExtension(new URL(options.filename, 'https://example.com/')) ??
      urlExtension(new URL(options.downloadUrl)) ??
      '';
  } catch {}

  const classified = classify(contentType, ext);
  const kind: Exclude<MediaKind, 'unknown'> = classified === 'unknown' ? 'image' : classified;
  const container: ContainerFormat = normalizeContainer(contentType, ext);
  const stem = options.filename.replace(/\.[^.]+$/, '');
  const title = sanitizeStem(stem, options.providerLabel);

  const plans: DownloadPlan[] = [
    {
      kind,
      container,
      label: 'Original',
      detail: [
        container.toUpperCase(),
        options.contentLength ? formatBytes(options.contentLength) : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      ...(options.contentLength ? { filesizeBytes: options.contentLength } : {}),
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'direct', url: options.downloadUrl },
    },
  ];

  if (kind === 'video') {
    plans.push(
      {
        kind: 'audio',
        container: 'mp3',
        label: 'MP3',
        detail: '320 kbps · extracted',
        audioBitrateKbps: 320,
        requiresConversion: true,
        recommended: true,
        fetch: { via: 'direct', url: options.downloadUrl },
        convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
      },
      {
        kind: 'audio',
        container: 'm4a',
        label: 'M4A',
        detail: '256 kbps · extracted',
        audioBitrateKbps: 256,
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: options.downloadUrl },
        convert: { kind: 'audio', container: 'm4a', bitrateKbps: 256 },
      },
    );
  } else if (kind === 'gif') {
    plans.push(
      {
        kind: 'video',
        container: 'mp4',
        label: 'MP4',
        detail: 'Converted from GIF · H.264',
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: options.downloadUrl },
        convert: { kind: 'video', container: 'mp4' },
      },
      {
        kind: 'video',
        container: 'webm',
        label: 'WebM',
        detail: 'Converted from GIF · VP9',
        requiresConversion: true,
        recommended: false,
        fetch: { via: 'direct', url: options.downloadUrl },
        convert: { kind: 'video', container: 'webm' },
      },
    );
  }

  const item: ResolvedItem = {
    sourceId: options.downloadUrl,
    index: 0,
    kind,
    title,
    container,
    ...(options.contentLength ? { filesizeBytes: options.contentLength } : {}),
    plans: ensureRecommendations(plans),
  };

  return {
    provider: options.providerId,
    providerLabel: options.providerLabel,
    url: options.sourceUrl.toString(),
    type: 'single',
    title,
    author: options.sourceUrl.hostname,
    items: [item],
    metadata: { contentType: contentType || 'application/octet-stream' },
  };
}

export class GoogleDriveProvider implements MediaProvider {
  readonly id = 'gdrive';
  readonly label = 'Google Drive';
  readonly hosts = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'] as const;
  readonly priority = 200;

  readonly capabilities: ProviderCapabilities = declare({
    image: true,
    audio: true,
    gif: true,
    residentialFallback: false,
  });

  canHandle(url: URL, host: string): boolean {
    return hostMatchesAny(host, this.hosts) && Boolean(extractGoogleDriveId(url));
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const fileId = extractGoogleDriveId(url);
    if (!fileId) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'gdrive: missing file id' });
    }

    let downloadTarget = new URL('https://drive.usercontent.google.com/download');
    downloadTarget.searchParams.set('id', fileId);
    downloadTarget.searchParams.set('export', 'download');
    downloadTarget.searchParams.set('confirm', 't');

    let head = await context.head(downloadTarget);
    if (head.status >= 400) {
      throw seraError(head.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
        detail: `gdrive HEAD ${head.status}`,
      });
    }

    if ((head.contentType ?? '').toLowerCase().includes('text/html')) {
      const page = await context.fetchText(downloadTarget, 512 * 1024);
      const confirmed = extractGoogleDriveConfirmUrl(
        page.body,
        new URL(page.url || downloadTarget.toString()),
      );
      if (!confirmed) {
        throw seraError('PRIVATE_CONTENT', {
          detail: 'gdrive: file requires sign-in or confirmation could not be bypassed',
        });
      }
      downloadTarget = confirmed;
      head = await context.head(downloadTarget);
      if (head.status >= 400) {
        throw seraError(head.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
          detail: `gdrive confirmed HEAD ${head.status}`,
        });
      }
    }

    const finalUrl = head.url || downloadTarget.toString();
    const filename = filenameFromUrl(finalUrl, `gdrive-${fileId}`);

    return buildCloudMedia({
      providerId: this.id,
      providerLabel: this.label,
      sourceUrl: url,
      downloadUrl: finalUrl,
      filename,
      ...(head.contentType ? { contentType: head.contentType } : {}),
      ...(head.contentLength ? { contentLength: head.contentLength } : {}),
      maxFilesizeBytes: context.config.maxFilesizeBytes,
    });
  }
}

export class DropboxProvider implements MediaProvider {
  readonly id = 'dropbox';
  readonly label = 'Dropbox';
  readonly hosts = ['dropbox.com', 'dl.dropboxusercontent.com'] as const;
  readonly priority = 200;

  readonly capabilities: ProviderCapabilities = declare({
    image: true,
    audio: true,
    gif: true,
    residentialFallback: false,
  });

  canHandle(url: URL, host: string): boolean {
    return hostMatchesAny(host, this.hosts) && url.pathname.length > 1;
  }

  normalize(url: URL): URL {
    const out = new URL(url.toString());
    if (hostMatches(out.hostname, 'dropbox.com')) {
      out.searchParams.delete('raw');
      out.searchParams.set('dl', '1');
    }
    return out;
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    const normalized = this.normalize(url);
    const head = await context.head(normalized);
    if (head.status >= 400) {
      throw seraError(head.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
        detail: `dropbox HEAD ${head.status}`,
      });
    }

    const finalUrl = head.url || normalized.toString();
    const filename = filenameFromUrl(url.toString(), filenameFromUrl(finalUrl, 'dropbox-file'));

    return buildCloudMedia({
      providerId: this.id,
      providerLabel: this.label,
      sourceUrl: url,
      downloadUrl: finalUrl,
      filename,
      ...(head.contentType ? { contentType: head.contentType } : {}),
      ...(head.contentLength ? { contentLength: head.contentLength } : {}),
      maxFilesizeBytes: context.config.maxFilesizeBytes,
    });
  }
}

export class MediaFireProvider implements MediaProvider {
  readonly id = 'mediafire';
  readonly label = 'MediaFire';
  readonly hosts = ['mediafire.com'] as const;
  readonly priority = 200;

  readonly capabilities: ProviderCapabilities = declare({
    image: true,
    audio: true,
    gif: true,
    residentialFallback: false,
  });

  canHandle(url: URL, host: string): boolean {
    return hostMatchesAny(host, this.hosts) && url.pathname.length > 1;
  }

  async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    let directUrl: URL;
    if (/^download[0-9]*\.mediafire\.com$/i.test(url.hostname)) {
      directUrl = url;
    } else {
      const page = await context.fetchText(url, 2 * 1024 * 1024);
      const extracted = extractMediaFireDirectUrl(page.body);
      if (!extracted) {
        throw seraError('MEDIA_UNAVAILABLE', {
          detail: 'mediafire: direct download URL not found on page',
        });
      }
      directUrl = parseUserUrl(extracted, {
        allowPrivateAddresses: context.config.allowPrivateAddresses,
      }).url;
    }

    const head = await context.head(directUrl);
    if (head.status >= 400) {
      throw seraError(head.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
        detail: `mediafire HEAD ${head.status}`,
      });
    }

    const finalUrl = head.url || directUrl.toString();
    const filename = filenameFromUrl(finalUrl, filenameFromUrl(url.toString(), 'mediafire-file'));

    return buildCloudMedia({
      providerId: this.id,
      providerLabel: this.label,
      sourceUrl: url,
      downloadUrl: finalUrl,
      filename,
      ...(head.contentType ? { contentType: head.contentType } : {}),
      ...(head.contentLength ? { contentLength: head.contentLength } : {}),
      maxFilesizeBytes: context.config.maxFilesizeBytes,
    });
  }
}

export class MegaProvider extends YtdlpProvider {
  readonly id = 'mega';
  readonly label = 'MEGA';
  readonly hosts = ['mega.nz', 'mega.co.nz'] as const;
  override readonly priority = 200;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    audio: true,
    gif: true,
    residentialFallback: false,
  });

  override canHandle(url: URL, host: string): boolean {
    return (
      hostMatchesAny(host, this.hosts) &&
      (url.pathname.startsWith('/file/') ||
        url.pathname.startsWith('/folder/') ||
        url.hash.startsWith('#!'))
    );
  }

  protected override useExtractors(): string {
    return 'default';
  }
}
