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

/**
 * Transport v2: a post the bookmarklet placed in the URL fragment.
 *
 * The mobile-safe path, and now the one the bookmarklet uses. Rather than open a popup and hand
 * the post over through it, the bookmarklet reads the post on instagram.com and navigates this
 * same tab to `/import#v=2&p=<encoded {url,node}>`. That sidesteps the two things that broke the
 * popup on phones: iOS Safari's pop-up blocker refusing `window.open`, and cross-origin COOP
 * severing the opener a `postMessage` needs.
 *
 * The fragment never reaches the SERA server — fragments are not sent in an HTTP request — and it
 * is cleared from history the instant it is read, so the signed media links it carries do not
 * linger in the address bar or the back-stack. What it carries is still untrusted: the server
 * validates and re-signs it exactly as it does a pasted or postMessage'd post.
 */
export function readImportFragment(target: Window): ImportRequest | undefined {
  const hash = target.location.hash;
  if (!new RegExp(`[#&]v=${FRAGMENT_VERSION}(?:&|$)`).test(hash)) return undefined;
  const encoded = /[#&]p=([^&]*)/.exec(hash)?.[1];

  // Cleared whether or not it parses: a malformed fragment should not survive in history either.
  try {
    target.history.replaceState(null, '', target.location.pathname + target.location.search);
  } catch {
    // A browser that refuses replaceState still works; the fragment just stays in the URL.
  }
  if (!encoded) return undefined;

  let request: unknown;
  try {
    request = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
  return looksLikeImport(request) ? request : undefined;
}
