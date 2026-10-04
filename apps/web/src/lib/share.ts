/**
 * "Share to SERA": what arrives from a phone's share sheet, and how it reaches the form.
 *
 * The installed app registers `/share` as a share target (see `app/manifest.ts`), and the
 * share sheet opens `/share?url=&text=&title=`. Apps do not agree on where the link goes:
 * a browser fills `url`, while YouTube and TikTok put it in `text`, after a sentence. So
 * every field is searched, `url` first, for the first http(s) link.
 *
 * The link then travels to the home page in the fragment (`/#url=…`), not the query: the
 * fragment never leaves the browser, so the second request does not carry it to the server
 * or into a log, and the page clears it as soon as it has read it.
 */

/** Characters that end a link written inside a sentence, rather than belonging to it. */
const TRAILING = /[.,;:!?'")\]}>]+$/;
const LINK = /https?:\/\/[^\s<>"'`]+/i;

/** The first http(s) URL in a piece of shared text, or undefined. */
export function firstHttpUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const match = LINK.exec(text);
  if (!match) return undefined;
  let candidate = match[0];
  // A closing bracket that opened inside the link is part of it (Wikipedia's "(film)").
  while (TRAILING.test(candidate)) {
    const last = candidate.at(-1)!;
    if (
      last === ')' &&
      (candidate.match(/\(/g)?.length ?? 0) >= (candidate.match(/\)/g)?.length ?? 0)
    )
      break;
    candidate = candidate.slice(0, -1);
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** The link in a share, from whichever field the sharing app put it in. */
export function sharedUrl(params: {
  readonly url?: string | null;
  readonly text?: string | null;
  readonly title?: string | null;
}): string | undefined {
  return firstHttpUrl(params.url) ?? firstHttpUrl(params.text) ?? firstHttpUrl(params.title);
}

const FRAGMENT_KEY = 'url';

/** Where `/share` sends the browser: the home page, with the link in the fragment. */
export function homeWithUrl(url: string): string {
  return `/#${FRAGMENT_KEY}=${encodeURIComponent(url)}`;
}

/** The link `homeWithUrl` put in a fragment, if this fragment is one of those. */
export function urlFromFragment(hash: string): string | undefined {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(fragment).get(FRAGMENT_KEY);
  return value ? firstHttpUrl(value) : undefined;
}
