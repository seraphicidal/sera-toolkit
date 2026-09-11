import type { ImportRequest } from '@sera/contracts/types';

/**
 * The window-to-window handshake that carries a post from instagram.com to /import.
 *
 * A visitor's browser reads a post on instagram.com — where it is signed in and SERA is not —
 * and opens /import as a popup to hand it over. The two pages are different origins, so the
 * only channel between them is postMessage, and the only reason it works at all is that
 * /import is served with `Cross-Origin-Opener-Policy: unsafe-none`: under SERA's default
 * `same-origin`, opening a cross-origin popup switches browsing-context groups and the popup's
 * `window.opener` comes up null, so no message can flow. Verified in a real browser across the
 * two policies before this was written.
 *
 * What the popup receives is the visitor's own post data, not a secret — but it decides what
 * the server is asked to fetch, so it is accepted only from an Instagram origin and only from
 * the window that opened this one. Everything else on the wire is ignored.
 */

/** The origins a post may arrive from. instagram.com and its www, over HTTPS, and nothing else. */
export const INSTAGRAM_ORIGINS: readonly string[] = [
  'https://www.instagram.com',
  'https://instagram.com',
];

export const READY = 'sera-import-ready';
export const PAYLOAD = 'sera-import-payload';
export const ACK = 'sera-import-ack';

/** Transport v2 marker in the `/import` fragment (`#v=2&p=…`). The bookmarklet writes it. */
export const FRAGMENT_VERSION = '2';

/** A message the opener sends once it has a post ready. */
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

/**
 * Whether a message is a post from the window that opened this one.
 *
 * Both halves matter: the origin, so a page on another site cannot feed this one a post; and
 * the source, so only the opener that this popup is talking to is heard, not some other frame
 * that happens to be on instagram.com. `opener` is passed in rather than read here so the
 * caller captures it once at load, before anything can navigate it out from under the check.
 */
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
  /** Resolves with the first trusted post, or rejects if none arrives before `timeoutMs`. */
  readonly received: Promise<ImportRequest>;
  /** Stops listening and clears the timer. Safe to call more than once. */
  readonly close: () => void;
}

/**
 * Opens the receiving side of the handshake.
 *
 * Announces readiness to the opener, then waits for the one post it trusts. The 'ready' signal
 * carries nothing, so it is broadcast; the post is only ever accepted through `trustedImport`.
 * A window opened directly, with no opener, waits out the timeout and rejects — which is how
 * the page knows to explain itself rather than spin forever.
 */
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
    // Let the opener stop resending and close itself.
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
  // The opener attaches its listener synchronously before opening this window, so by the time
  // this runs it is already listening. Broadcast because the opener's exact origin is not known
  // in advance, and the signal reveals nothing.
  if (opener) opener.postMessage({ type: READY }, '*');

  return { received, close };
}

/** Reader's ceiling on the raw fragment, applied before it is decoded — a crafted hash could be
 * enormous, and neither `decodeURIComponent` nor `JSON.parse` should be handed something huge. It
 * sits above the ~36 KB a full carousel measures and below what a browser will carry. */
export const MAX_IMPORT_FRAGMENT_LENGTH = 65_536;

/** Instagram's CDN hosts, mirrored from the server's allowlist so the client can refuse early. */
const IMPORT_MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

/** Whether a URL is one the server would also admit: HTTPS, no port, no credentials, on the CDN. */
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

/** Every media and thumbnail URL in an imported node — the same set the server host-checks. */
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

/**
 * The outcome of reading the fragment: a post to import, a post to refuse, or nothing there.
 *
 * `{ ok: false }` is deliberately distinct from `undefined`. A crafted `/import#v=2&p=…` link is
 * new with this transport — under v1 only an instagram.com opener could hand a post over, but now
 * anyone can send someone a link. If its media is not on Instagram's CDN, the recipient must be
 * shown an error and **nothing POSTed**, because the server counts the resulting `BLOCKED_ADDRESS`
 * as abuse against whoever's browser sent it. `undefined` means no v2 fragment at all — fall
 * through to the v1 path or the explainer.
 */
export type ImportFragment =
  | { readonly ok: true; readonly request: ImportRequest }
  | { readonly ok: false; readonly reason: 'off-cdn' | 'too-large' };

/**
 * Transport v2: a post the bookmarklet placed in the URL fragment.
 *
 * The mobile-safe path, and now the one the bookmarklet uses. Rather than open a popup and hand
 * the post over through it, the bookmarklet reads the post on instagram.com and navigates this
 * same tab to `/import#v=2&p=<encoded {url,node}>`. That sidesteps the two things that make the
 * popup fragile on phones: a pop-up blocker refusing `window.open`, and cross-origin COOP severing
 * the opener a `postMessage` needs.
 *
 * The fragment is not sent in the HTTP request that loads this page — fragments never are, by the
 * URL spec, so no `Referer` or server log can carry it regardless of referrer policy. It is
 * cleared from this tab's session history the instant it is read (global or synced history may
 * still record the original URL, which is low impact: the signed links expire within hours). What
 * it carries is untrusted, and validated twice: the media-host check below, on the client, so a
 * crafted link cannot make this browser POST off-allowlist URLs; and the full check on the server,
 * which stays authoritative for any direct POST.
 */
export function readImportFragment(target: Window): ImportFragment | undefined {
  const hash = target.location.hash;
  if (!new RegExp(`[#&]v=${FRAGMENT_VERSION}(?:&|$)`).test(hash)) return undefined;
  // Capped before it is decoded or parsed. Still cleared, below, whether or not it is over.
  const tooLong = hash.length > MAX_IMPORT_FRAGMENT_LENGTH;
  const encoded = tooLong ? undefined : /[#&]p=([^&]*)/.exec(hash)?.[1];

  try {
    target.history.replaceState(null, '', target.location.pathname + target.location.search);
  } catch {
    // A browser that refuses replaceState still works; the fragment just stays in the URL.
  }
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
