import { seraError } from '../errors.js';
import { isIpLiteral, isPublicAddress } from './ip.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const ALLOWED_PORTS = new Set(['', '80', '443']);

function hasForbiddenUrlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0x3000 || code === 0xfeff) return true;
  }
  return false;
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_[ce]id$/i,
  /^igshid$/i,
  /^igsh$/i,
  /^si$/i,
  /^feature$/i,
  /^ref_src$/i,
  /^ref_url$/i,
  /^s$/i,
  /^t$/i,
  /^_r$/i,
  /^_t$/i,
  /^share_(app_)?id$/i,
  /^is_from_webapp$/i,
  /^sender_device$/i,
  /^web_id$/i,
  /^__twitter_impression$/i,
  /^spm_id_from$/i,
];

const PRESERVE_PARAMS = new Set(['v', 'list', 'index', 'id', 'p', 'story_fbid', 'set']);

export interface ParsedUrl {
  readonly url: URL;
  readonly host: string;
  readonly rawHost: string;
}

export interface ParseUrlOptions {
  readonly allowPrivateAddresses?: boolean;
}

export function parseUserUrl(input: string, options: ParseUrlOptions = {}): ParsedUrl {
  const trimmed = input.trim();
  if (!trimmed) throw seraError('INVALID_URL', { message: 'Enter a link.' });

  if (hasForbiddenUrlChar(trimmed)) {
    throw seraError('INVALID_URL', { detail: 'control character or space in url' });
  }

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw seraError('INVALID_URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw seraError('INVALID_URL', {
      message: 'Only http and https links are supported.',
      detail: `protocol ${url.protocol}`,
    });
  }
  if (url.username || url.password) {
    throw seraError('INVALID_URL', {
      message: 'Links with embedded credentials are not accepted.',
    });
  }
  if (!options.allowPrivateAddresses && !ALLOWED_PORTS.has(url.port)) {
    throw seraError('BLOCKED_ADDRESS', { detail: `port ${url.port}` });
  }

  const rawHost = url.hostname.toLowerCase();
  if (!rawHost) throw seraError('INVALID_URL');

  if (!options.allowPrivateAddresses && isIpLiteral(rawHost)) {
    const bare = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    if (!isPublicAddress(bare)) throw seraError('BLOCKED_ADDRESS');
  }

  url.hash = '';
  return { url, host: stripWww(rawHost), rawHost };
}

export function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function normalizeUrl(url: URL): URL {
  const out = new URL(url.toString());
  out.hash = '';
  out.hostname = out.hostname.toLowerCase();

  const params = [...out.searchParams.entries()].filter(
    ([key]) =>
      PRESERVE_PARAMS.has(key.toLowerCase()) || !TRACKING_PARAMS.some((re) => re.test(key)),
  );
  out.search = '';
  for (const [key, value] of params.sort(([a], [b]) => a.localeCompare(b))) {
    out.searchParams.append(key, value);
  }

  if (out.pathname.length > 1 && out.pathname.endsWith('/')) {
    out.pathname = out.pathname.replace(/\/+$/, '');
  }
  return out;
}

export function hostMatches(host: string, domain: string): boolean {
  const h = stripWww(host.toLowerCase());
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export function hostMatchesAny(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostMatches(host, d));
}

export const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'flv',
  'ts',
  'm3u8',
  'mpd',
  'mp3',
  'm4a',
  'aac',
  'opus',
  'ogg',
  'oga',
  'wav',
  'flac',
  'wma',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
]);

export function urlExtension(url: URL): string | undefined {
  const match = /\.([a-z0-9]{1,5})$/i.exec(decodeURIComponent(url.pathname));
  return match?.[1]?.toLowerCase();
}
