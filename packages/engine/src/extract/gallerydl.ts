import type { MediaKind } from '@sera/contracts/types';
import { locateTool } from '../config.js';
import { seraError, SeraError } from '../errors.js';
import { normalizeContainer as normalizeFormatContainer } from '../normalize/formats.js';
import { ensureRecommendations } from '../normalize/plans.js';
import type {
  DownloadPlan,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from '../providers/types.js';
import { hostMatchesAny, parseUserUrl, scrubCredentials, urlExtension } from '../security/url.js';
import { truncate } from '../util/format.js';
import { run } from '../util/spawn.js';

export interface GalleryDlOptions {
  readonly binary?: string;
  readonly proxy?: string;
  readonly providerId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GalleryDlEntry {
  readonly url: string;
  readonly kind: MediaKind;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly extension?: string;
}

export function parseGalleryDlJson(
  stdout: string,
  allowPrivateAddresses = false,
  blockedHosts: readonly string[] = [],
): { title?: string; author?: string; entries: GalleryDlEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { entries: [] };
  }

  const entries: GalleryDlEntry[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  let author: string | undefined;

  const addCandidate = (rawUrl: unknown, meta?: Record<string, unknown>): void => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
    let validUrl: URL;
    try {
      validUrl = parseUserUrl(rawUrl, { allowPrivateAddresses }).url;
    } catch {
      return;
    }
    if (hostMatchesAny(validUrl.hostname, blockedHosts)) return;
    const normalized = validUrl.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);

    const rawExt = typeof meta?.extension === 'string' ? meta.extension.trim().toLowerCase() : '';
    const ext = (rawExt || undefined) ?? urlExtension(validUrl) ?? 'jpg';
    const kind: MediaKind =
      ext === 'gif'
        ? 'gif'
        : ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'm3u8', 'mpd'].includes(ext)
          ? 'video'
          : ['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac'].includes(ext)
            ? 'audio'
            : 'image';
    const width = typeof meta?.width === 'number' && meta.width > 0 ? meta.width : undefined;
    const height = typeof meta?.height === 'number' && meta.height > 0 ? meta.height : undefined;
    const itemTitle =
      typeof meta?.title === 'string' && meta.title.trim()
        ? meta.title.trim()
        : typeof meta?.filename === 'string' && meta.filename.trim()
          ? meta.filename.trim()
          : undefined;

    entries.push({
      url: normalized,
      kind,
      extension: ext,
      ...(itemTitle ? { title: itemTitle } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  };

  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (Array.isArray(row)) {
        const [code, first, second] = row as [unknown, unknown, unknown];
        if (code === 2 && first && typeof first === 'object') {
          const meta = first as Record<string, unknown>;
          if (!title && typeof meta.title === 'string') title = meta.title;
          if (!author && typeof meta.uploader === 'string') author = meta.uploader;
          if (!author && typeof meta.author === 'string') author = meta.author;
        } else if (code === 3 && typeof first === 'string') {
          const meta =
            second && typeof second === 'object' ? (second as Record<string, unknown>) : undefined;
          if (meta) {
            if (!title && typeof meta.title === 'string') title = meta.title;
            if (!author && typeof meta.uploader === 'string') author = meta.uploader;
          }
          addCandidate(first, meta);
        }
      } else if (row && typeof row === 'object') {
        const obj = row as Record<string, unknown>;
        addCandidate(obj.url, obj);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === 'string') title = obj.title;
    if (typeof obj.uploader === 'string') author = obj.uploader;
    addCandidate(obj.url, obj);
  }

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    entries,
  };
}

const MISSING_BINARY_TTL_MS = 5 * 60_000;
const missingBinaries = new Map<string, number>();

export function resetGalleryDlAvailabilityCache(): void {
  missingBinaries.clear();
}

export async function extractWithGalleryDl(
  url: URL,
  context: ProviderContext,
  options: GalleryDlOptions = {},
): Promise<ResolvedMedia> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw seraError('BLOCKED_ADDRESS', { detail: `gallery-dl: protocol ${url.protocol}` });
  }
  const binary = options.binary ?? locateTool('gallery-dl', process.env.SERA_GALLERYDL_PATH ?? '');
  const missingUntil = missingBinaries.get(binary);
  if (missingUntil !== undefined && Date.now() < missingUntil) {
    throw seraError('UNSUPPORTED_SOURCE', {
      detail: 'gallery-dl binary not installed',
    });
  }
  const provider = options.providerId ?? 'generic';
  const upstream = options.proxy ?? context.config.proxyFor(provider);
  const proxy = context.egressProxy ? await context.egressProxy(url, upstream) : upstream;

  const args = [
    '--ignore-config',
    '--dump-json',
    '--no-download',
    '--range',
    `1-${context.config.maxItemsPerJob}`,
  ];
  if (proxy) args.push('--proxy', proxy);
  args.push('--', url.toString());

  let stdout: string;
  try {
    const result = await run(binary, {
      args,
      timeoutMs: options.timeoutMs ?? context.config.resolveTimeoutMsFor(provider),
      captureStdout: true,
      maxStdoutBytes: 16 * 1024 * 1024,
      ...(options.signal
        ? { signal: options.signal }
        : context.signal
          ? { signal: context.signal }
          : {}),
    });
    if (result.code !== 0) {
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: `gallery-dl exit ${result.code}: ${scrubCredentials(result.stderrTail).slice(-300)}`,
      });
    }
    stdout = result.stdout;
  } catch (error) {
    if (error instanceof SeraError) {
      const causeCode = (error.cause as NodeJS.ErrnoException | undefined)?.code;
      if (error.code === 'INTERNAL' && causeCode === 'ENOENT') {
        missingBinaries.set(binary, Date.now() + MISSING_BINARY_TTL_MS);
        throw seraError('UNSUPPORTED_SOURCE', {
          detail: 'gallery-dl binary not installed',
          cause: error.cause,
        });
      }
      throw error;
    }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      missingBinaries.set(binary, Date.now() + MISSING_BINARY_TTL_MS);
      throw seraError('UNSUPPORTED_SOURCE', {
        detail: 'gallery-dl binary not installed',
        cause: error,
      });
    }
    throw seraError('UNSUPPORTED_SOURCE', { detail: 'gallery-dl execution failed', cause: error });
  }

  const parsed = parseGalleryDlJson(
    stdout,
    context.config.allowPrivateAddresses,
    context.config.blockedHosts,
  );
  const filtered = parsed.entries.filter((entry) => {
    if (!context.allowUrl) return true;
    try {
      context.allowUrl(entry.url);
      return true;
    } catch {
      return false;
    }
  });
  const selected = filtered.slice(0, context.config.maxItemsPerJob);
  if (!selected.length) {
    throw seraError('UNSUPPORTED_SOURCE', {
      detail: `gallery-dl: no media found on ${url.hostname}`,
    });
  }

  const items: ResolvedItem[] = selected.map((entry, index) => {
    const isManifest = entry.extension === 'm3u8' || entry.extension === 'mpd';
    const container = isManifest ? 'mp4' : normalizeFormatContainer(entry.extension, 'jpg');
    const plans: DownloadPlan[] = [
      {
        kind: entry.kind === 'gif' ? 'gif' : entry.kind === 'unknown' ? 'image' : entry.kind,
        container,
        label: 'Original',
        detail: container.toUpperCase(),
        ...(entry.width ? { width: entry.width } : {}),
        ...(entry.height ? { height: entry.height } : {}),
        requiresConversion: false,
        recommended: true,
        fetch: isManifest
          ? {
              via: 'ytdlp',
              selector: 'bestvideo+bestaudio/best',
              merge: 'mp4',
              target: entry.url,
              useExtractors: 'default',
            }
          : { via: 'direct', url: entry.url },
      },
    ];
    return {
      sourceId: entry.url,
      index,
      kind: entry.kind,
      ...(entry.title ? { title: truncate(entry.title, 200) } : {}),
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
      container,
      plans: ensureRecommendations(plans),
    };
  });

  return {
    provider: 'generic',
    providerLabel: 'Web page',
    url: url.toString(),
    type: items.length > 1 ? 'collection' : 'single',
    title: parsed.title ? truncate(parsed.title, 200) : url.hostname,
    ...(parsed.author ? { author: parsed.author } : {}),
    items,
    metadata: { discoveredFrom: 'gallery-dl' },
  };
}
