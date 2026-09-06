import { seraError } from '../errors.js';
import { isIpLiteral, isPublicAddress } from './ip.js';

/** Only these schemes are ever fetched. Everything else is refused before DNS. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Ports the server will connect to. Anything else is refused. */
const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * Control characters and whitespace that must not survive into a URL.
 *
 * `new URL()` silently strips tabs and newlines, which is how `http://evil\n.example`
 * turns into a host the caller never inspected. Rejecting the input outright is the
 * only safe reading of it.
 */
function hasForbiddenUrlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // C0 controls and space, DEL, C1 controls.
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
    // Zero-width, bidi-override and BOM characters, which can disguise a hostname.
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0x3000 || code === 0xfeff) return true;
  }
  return false;
}

/**
 * Query parameters stripped during normalization.
 *
 * These are tracking identifiers, not addressing: removing them means two people who
 * paste the same post from different apps get the same normalized URL, and it keeps
 * campaign ids out of the server logs.
 */
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

/** Parameters that must survive normalization even though they match a rule above. */
const PRESERVE_PARAMS = new Set(['v', 'list', 'index', 'id', 'p', 'story_fbid', 'set']);

export interface ParsedUrl {
  readonly url: URL;
  /** Lowercase hostname with any `www.` prefix removed. */
  readonly host: string;
  /** Hostname exactly as written, lowercased. */
  readonly rawHost: string;
}

export interface ParseUrlOptions {
  /**
   * Permits private and loopback literals, and ports other than 80 and 443.
   *
   * This mirrors the transport-level guard: both layers have to agree, or the
   * development flag that lets the test suite talk to a local origin would be silently
   * overruled here. Configuration refuses to enable it in production.
   */
  readonly allowPrivateAddresses?: boolean;
}

/**
 * Turns user input into a URL, or explains why it cannot be one.
 *
 * Bare hosts (`youtube.com/watch?v=x`) are accepted and assumed to be https, because
 * that is what people paste. Everything else is strict: no credentials, no unusual
 * scheme, no unusual port, and no IP literal that points back at infrastructure.
 */
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

  // A literal address can be checked immediately; names are checked at connect time.
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

/**
 * Produces the canonical form of a URL: no fragment, no tracking parameters, sorted
 * query, and no trailing slash on a non-root path.
 */
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

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const h = stripWww(host.toLowerCase());
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** True when `host` matches any entry in `domains`. */
export function hostMatchesAny(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostMatches(host, d));
}

/** Common media file extensions, used to recognize a direct media link. */
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

/** The lowercase extension of a URL's path, without the dot. */
export function urlExtension(url: URL): string | undefined {
  const match = /\.([a-z0-9]{1,5})$/i.exec(decodeURIComponent(url.pathname));
  return match?.[1]?.toLowerCase();
}
