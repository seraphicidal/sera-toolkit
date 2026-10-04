import { describe, expect, it } from 'vitest';
import {
  addToHistory,
  clearHistory,
  HISTORY_KEY,
  HISTORY_LIMIT,
  isExpired,
  readHistory,
  timeAgo,
  type HistoryEntry,
} from './history';

/**
 * Recent downloads in `localStorage`.
 *
 * What matters is that it never gets in the way: storage that is missing, full, forbidden or
 * holding junk has to read as an empty history, and nothing stored can become an href to
 * somewhere other than this site's API.
 */

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

function entry(n: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    jobId: `job${String(n)}`,
    title: `Video ${String(n)}`,
    source: 'YouTube',
    url: `https://www.youtube.com/watch?v=${String(n)}`,
    filename: `video-${String(n)}.mp4`,
    downloadPath: `/api/jobs/job${String(n)}/download`,
    savedAt: '2026-10-04T10:00:00.000Z',
    expiresAt: '2026-10-04T10:30:00.000Z',
    ...overrides,
  };
}

describe('the history', () => {
  it('keeps the newest first, one entry per job', () => {
    const store = memoryStore();
    addToHistory(entry(1), store);
    addToHistory(entry(2), store);
    addToHistory(entry(1, { title: 'Video 1, again' }), store);
    expect(readHistory(store).map((e) => e.title)).toEqual(['Video 1, again', 'Video 2']);
  });

  it(`keeps only the last ${String(HISTORY_LIMIT)}`, () => {
    const store = memoryStore();
    for (let n = 1; n <= HISTORY_LIMIT + 3; n += 1) addToHistory(entry(n), store);
    const kept = readHistory(store);
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[0]?.jobId).toBe(`job${String(HISTORY_LIMIT + 3)}`);
  });

  it('clears to nothing, leaving no key behind', () => {
    const store = memoryStore();
    addToHistory(entry(1), store);
    clearHistory(store);
    expect(readHistory(store)).toEqual([]);
    expect(store.data.has(HISTORY_KEY)).toBe(false);
  });

  it('reads storage it cannot use as an empty history, and writes without throwing', () => {
    expect(readHistory(throwing)).toEqual([]);
    expect(() => addToHistory(entry(1), throwing)).not.toThrow();
    expect(() => clearHistory(throwing)).not.toThrow();
    expect(readHistory(undefined)).toEqual([]);
  });

  it('survives junk in its key', () => {
    expect(readHistory(memoryStore({ [HISTORY_KEY]: '{not json' }))).toEqual([]);
    expect(readHistory(memoryStore({ [HISTORY_KEY]: '{"a":1}' }))).toEqual([]);
    expect(
      readHistory(memoryStore({ [HISTORY_KEY]: JSON.stringify([entry(1), { jobId: 2 }, null]) })),
    ).toHaveLength(1);
  });

  it('drops an entry whose link would lead off this site, or whose source is not a web link', () => {
    const store = memoryStore({
      [HISTORY_KEY]: JSON.stringify([
        entry(1, { downloadPath: 'https://evil.example/file' }),
        entry(2, { downloadPath: 'javascript:alert(1)' }),
        entry(3, { url: 'javascript:alert(1)' }),
        entry(4),
      ]),
    });
    expect(readHistory(store).map((e) => e.jobId)).toEqual(['job4']);
  });
});

describe('isExpired', () => {
  const now = Date.parse('2026-10-04T10:15:00.000Z');

  it('is false within retention and true after it', () => {
    expect(isExpired(entry(1), now)).toBe(false);
    expect(isExpired(entry(1), Date.parse('2026-10-04T10:30:00.000Z'))).toBe(true);
  });

  it('treats an unreadable time as expired, so no dead link is offered', () => {
    expect(isExpired(entry(1, { expiresAt: 'soon' }), now)).toBe(true);
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');

  it('says how long ago, coarsely', () => {
    expect(timeAgo('2026-10-04T11:59:40.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-04T11:55:00.000Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-04T09:00:00.000Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-03T08:00:00.000Z', now)).toBe('yesterday');
    expect(timeAgo('2026-09-20T08:00:00.000Z', now)).not.toBe('');
    expect(timeAgo('whenever', now)).toBe('');
  });
});
