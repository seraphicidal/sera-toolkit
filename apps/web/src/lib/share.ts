const TRAILING = /[.,;:!?'")\]}>]+$/;
const LINK = /https?:\/\/[^\s<>"'`]+/i;

export function firstHttpUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const match = LINK.exec(text);
  if (!match) return undefined;
  let candidate = match[0];
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

export function sharedUrl(params: {
  readonly url?: string | null;
  readonly text?: string | null;
  readonly title?: string | null;
}): string | undefined {
  return firstHttpUrl(params.url) ?? firstHttpUrl(params.text) ?? firstHttpUrl(params.title);
}

const FRAGMENT_KEY = 'url';

export function homeWithUrl(url: string): string {
  return `/#${FRAGMENT_KEY}=${encodeURIComponent(url)}`;
}

export function urlFromFragment(hash: string): string | undefined {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(fragment).get(FRAGMENT_KEY);
  return value ? firstHttpUrl(value) : undefined;
}

export function isInstalledApp(win: {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly navigator?: object;
}): boolean {
  try {
    return (
      win.matchMedia?.('(display-mode: standalone)').matches === true ||
      (win.navigator as { standalone?: unknown } | undefined)?.standalone === true
    );
  } catch {
    return false;
  }
}
