import type { ImportRequest } from '@sera/contracts/types';

export const INSTAGRAM_ORIGINS: readonly string[] = [
  'https://www.instagram.com',
  'https://instagram.com',
];

export const READY = 'sera-import-ready';
export const PAYLOAD = 'sera-import-payload';
export const ACK = 'sera-import-ack';

export const FRAGMENT_VERSION = '2';

interface PayloadMessage {
  readonly type: typeof PAYLOAD;
  readonly url: unknown;
  readonly node: unknown;
}

function looksLikeImport(value: unknown): value is ImportRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === 'string' &&
    typeof record.node === 'object' &&
    record.node !== null &&
    !Array.isArray(record.node)
  );
}

export function trustedImport(
  event: MessageEvent,
  opener: Window | null,
): ImportRequest | undefined {
  if (!opener || event.source !== opener) return undefined;
  if (!INSTAGRAM_ORIGINS.includes(event.origin)) return undefined;
  const data = event.data as PayloadMessage | undefined;
  if (data?.type !== PAYLOAD) return undefined;
  const request = { url: data.url, node: data.node };
  return looksLikeImport(request) ? request : undefined;
}

export interface ImportChannel {
  readonly received: Promise<ImportRequest>;
  readonly close: () => void;
}

export function openImportChannel(target: Window, timeoutMs = 20_000): ImportChannel {
  const opener = target.opener as Window | null;
  let settle!: (request: ImportRequest) => void;
  let fail!: (reason: Error) => void;
  const received = new Promise<ImportRequest>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const onMessage = (event: MessageEvent): void => {
    const request = trustedImport(event, opener);
    if (!request) return;
    (event.source as Window | null)?.postMessage({ type: ACK }, event.origin);
    close();
    settle(request);
  };

  const timer = target.setTimeout(() => {
    close();
    fail(new Error('no post arrived'));
  }, timeoutMs);

  const close = (): void => {
    target.clearTimeout(timer);
    target.removeEventListener('message', onMessage);
  };

  target.addEventListener('message', onMessage);
  if (opener) opener.postMessage({ type: READY }, '*');

  return { received, close };
}

export const MAX_IMPORT_FRAGMENT_LENGTH = 65_536;

const IMPORT_MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

function onInstagramCdn(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return IMPORT_MEDIA_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function mediaUrlsOf(node: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const slide = value as {
      image_versions2?: { candidates?: unknown[] };
      video_versions?: unknown[];
      carousel_media?: unknown[];
    };
    for (const candidate of slide.image_versions2?.candidates ?? []) {
      const url = (candidate as { url?: unknown })?.url;
      if (typeof url === 'string') out.push(url);
    }
    for (const version of slide.video_versions ?? []) {
      const url = (version as { url?: unknown })?.url;
      if (typeof url === 'string') out.push(url);
    }
    for (const child of slide.carousel_media ?? []) walk(child);
  };
  walk(node);
  return out;
}

export type ImportFragment =
  | { readonly ok: true; readonly request: ImportRequest }
  | { readonly ok: false; readonly reason: 'off-cdn' | 'too-large' };

export function readImportFragment(target: Window): ImportFragment | undefined {
  const hash = target.location.hash;
  if (!new RegExp(`[#&]v=${FRAGMENT_VERSION}(?:&|$)`).test(hash)) return undefined;
  const tooLong = hash.length > MAX_IMPORT_FRAGMENT_LENGTH;
  const encoded = tooLong ? undefined : /[#&]p=([^&]*)/.exec(hash)?.[1];

  try {
    target.history.replaceState(null, '', target.location.pathname + target.location.search);
  } catch {}
  if (tooLong) return { ok: false, reason: 'too-large' };
  if (!encoded) return undefined;

  let request: unknown;
  try {
    request = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
  if (!looksLikeImport(request)) return undefined;

  const urls = mediaUrlsOf(request.node);
  if (urls.some((url) => !onInstagramCdn(url))) return { ok: false, reason: 'off-cdn' };
  return { ok: true, request };
}
