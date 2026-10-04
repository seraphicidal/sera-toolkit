/**
 * Recent downloads, kept in this browser and nowhere else.
 *
 * The server forgets a download after its retention window, by design, so "what did I get
 * yesterday" can only be answered here. It lives in `localStorage` and is never sent
 * anywhere. Storage can be missing, full, or forbidden (a private window, a blocked site), so
 * every access is wrapped: a history that cannot be kept is an empty one, never an error.
 */

export interface HistoryEntry {
  /** The job's id; one entry per job. */
  readonly jobId: string;
  readonly title: string;
  /** The source's name, e.g. "YouTube". */
  readonly source: string;
  /** The link that was analysed, so the entry can be fetched again once it expires. */
  readonly url: string;
  readonly filename: string;
  /** Same-origin path to the file or ZIP. */
  readonly downloadPath: string;
  /** ISO-8601. */
  readonly savedAt: string;
  /** ISO-8601; the server deletes the files after this. */
  readonly expiresAt: string;
}

export const HISTORY_KEY = 'sera-history';
export const HISTORY_LIMIT = 10;
/** Fired on `window` when this tab changes the history, so every list on the page follows. */
export const HISTORY_EVENT = 'sera-history-change';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage`, if this browser will let the page have it. */
export function browserStore(): Store | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    ['jobId', 'title', 'source', 'url', 'filename', 'downloadPath', 'savedAt', 'expiresAt'].every(
      (key) => typeof entry[key] === 'string',
    ) &&
    // Only ever a same-origin API path: whatever is stored becomes an href.
    (entry.downloadPath as string).startsWith('/api/') &&
    /^https?:\/\//i.test(entry.url as string)
  );
}

export function readHistory(store: Store | undefined = browserStore()): HistoryEntry[] {
  try {
    const raw = store?.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function write(store: Store | undefined, entries: readonly HistoryEntry[]): void {
  try {
    if (entries.length) store?.setItem(HISTORY_KEY, JSON.stringify(entries));
    else store?.removeItem(HISTORY_KEY);
  } catch {
    // Full or forbidden. The download itself is unaffected; it just is not remembered.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(HISTORY_EVENT));
}

/** Puts a finished download at the top, replacing an earlier entry for the same job. */
export function addToHistory(
  entry: HistoryEntry,
  store: Store | undefined = browserStore(),
): HistoryEntry[] {
  const next = [entry, ...readHistory(store).filter((e) => e.jobId !== entry.jobId)].slice(
    0,
    HISTORY_LIMIT,
  );
  write(store, next);
  return next;
}

export function clearHistory(store: Store | undefined = browserStore()): void {
  write(store, []);
}

export function isExpired(entry: HistoryEntry, now: number = Date.now()): boolean {
  const expires = Date.parse(entry.expiresAt);
  return Number.isNaN(expires) || expires <= now;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then a date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'yesterday';
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
