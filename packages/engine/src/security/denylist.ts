import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostMatches, hostMatchesAny, normalizeUrl, stripWww } from './url.js';

export interface BlockedEntry {
  readonly id: string;
  readonly type: 'host' | 'url';
  readonly target: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface DenylistOptions {
  readonly staticHosts?: readonly string[];
  readonly filePath?: string;
  readonly onUpdate?: () => void;
  readonly canonicalizeUrl?: (url: URL) => URL;
}

interface CanonicalUrlKeys {
  readonly exact: string;
  readonly pathOnly: string;
  readonly hasQuery: boolean;
  readonly params: readonly (readonly [string, string])[];
}

const PROTECTED_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'twitch.tv',
  'vimeo.com',
  'soundcloud.com',
  'facebook.com',
  'pinterest.com',
  'bandcamp.com',
  'dailymotion.com',
  'tumblr.com',
  'threads.net',
  'bsky.app',
  'drive.google.com',
  'mediafire.com',
  'dropbox.com',
  'mega.nz',
]);

export class Denylist {
  private readonly staticHosts: readonly string[];
  private readonly filePath?: string;
  private readonly canonicalizeUrl?: (url: URL) => URL;
  private readonly dynamicHosts = new Set<string>();
  private readonly dynamicUrls = new Set<string>();
  private readonly dynamicPathUrls = new Set<string>();
  private readonly dynamicQueryUrls = new Map<string, (readonly (readonly [string, string])[])[]>();
  private readonly entries: BlockedEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pendingAdds = new Map<string, BlockedEntry>();
  private readonly pendingDeletes = new Set<string>();
  private lastMtimeMs = 0;
  private lastReloadCheckMs = 0;
  private persistQueue: Promise<void> = Promise.resolve();
  private reloadInFlight: Promise<void> | undefined;

  constructor(options: DenylistOptions = {}) {
    this.staticHosts = (options.staticHosts ?? []).map((h) => stripWww(h.trim().toLowerCase()));
    this.filePath = options.filePath;
    this.canonicalizeUrl = options.canonicalizeUrl;
    if (options.onUpdate) this.listeners.add(options.onUpdate);
    if (this.filePath) {
      void this.reload();
    }
  }

  onUpdate(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  private maybeReloadFromDisk(): void {
    if (!this.filePath || this.reloadInFlight) return;
    const now = Date.now();
    if (now - this.lastReloadCheckMs < 5_000) return;
    this.lastReloadCheckMs = now;
    void this.reloadIfModified();
  }

  async reload(): Promise<void> {
    if (!this.filePath) return;
    await this.reloadFromDisk(true);
  }

  async flush(): Promise<void> {
    if (this.reloadInFlight) await this.reloadInFlight;
    await this.persistQueue;
  }

  private reloadIfModified(): Promise<void> {
    return this.reloadFromDisk(false);
  }

  private reloadFromDisk(force: boolean): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    if (this.reloadInFlight) return this.reloadInFlight;
    const filePath = this.filePath;
    this.reloadInFlight = (async () => {
      try {
        const info = await stat(filePath);
        if (!force && info.mtimeMs <= this.lastMtimeMs) return;
        const diskEntries = await readDiskEntries(filePath);
        if (!diskEntries) return;
        const merged = this.mergeWithPending(diskEntries);
        const changed = entriesFingerprint(merged) !== entriesFingerprint(this.entries);
        this.entries.length = 0;
        this.entries.push(...merged);
        this.rebuildSets();
        this.lastMtimeMs = info.mtimeMs;
        if (changed) this.notify();
      } catch {}
    })().finally(() => {
      this.reloadInFlight = undefined;
    });
    return this.reloadInFlight;
  }

  isBlockedHost(hostname: string): boolean {
    this.maybeReloadFromDisk();
    const host = stripWww(hostname.trim().toLowerCase());
    if (!host) return false;
    if (this.staticHosts.length > 0 && hostMatchesAny(host, this.staticHosts)) {
      return true;
    }
    if (this.dynamicHosts.size > 0 && hostMatchesAny(host, this.dynamicHosts)) {
      return true;
    }
    return false;
  }

  isBlocked(target: string | URL): { readonly blocked: boolean; readonly reason?: string } {
    this.maybeReloadFromDisk();
    let url: URL;
    try {
      url = typeof target === 'string' ? new URL(target) : target;
    } catch {
      return { blocked: false };
    }

    const host = stripWww(url.hostname.toLowerCase());
    if (this.staticHosts.length > 0 && hostMatchesAny(host, this.staticHosts)) {
      return { blocked: true, reason: 'host is on the deny list' };
    }

    if (this.dynamicHosts.size > 0 && hostMatchesAny(host, this.dynamicHosts)) {
      return { blocked: true, reason: 'host is blocked' };
    }

    const keys = this.canonicalKeys(url);
    const canonicalHost = stripWww(new URL(keys.pathOnly).hostname.toLowerCase());
    if (canonicalHost !== host) {
      if (this.staticHosts.length > 0 && hostMatchesAny(canonicalHost, this.staticHosts)) {
        return { blocked: true, reason: 'host is on the deny list' };
      }
      if (this.dynamicHosts.size > 0 && hostMatchesAny(canonicalHost, this.dynamicHosts)) {
        return { blocked: true, reason: 'host is blocked' };
      }
    }

    if (this.dynamicUrls.has(keys.exact) || this.dynamicPathUrls.has(keys.pathOnly)) {
      return { blocked: true, reason: 'url is blocked' };
    }

    const queryRules = this.dynamicQueryUrls.get(keys.pathOnly);
    if (queryRules && keys.hasQuery) {
      const paramMap = new Map<string, Set<string>>();
      for (const [k, v] of keys.params) {
        let values = paramMap.get(k);
        if (!values) {
          values = new Set<string>();
          paramMap.set(k, values);
        }
        values.add(v);
      }
      for (const required of queryRules) {
        if (required.every(([k, v]) => paramMap.get(k)?.has(v))) {
          return { blocked: true, reason: 'url is blocked' };
        }
      }
    }

    return { blocked: false };
  }

  blockHost(host: string, reason = 'Report mitigation'): BlockedEntry | undefined {
    const cleanHost = stripWww(host.trim().toLowerCase());
    if (!cleanHost?.includes('.')) return undefined;
    if (
      hostMatchesAny(cleanHost, PROTECTED_HOSTS) ||
      [...PROTECTED_HOSTS].some((protectedHost) => hostMatches(protectedHost, cleanHost))
    ) {
      return undefined;
    }
    if (this.dynamicHosts.has(cleanHost)) {
      return this.entries.find((e) => e.type === 'host' && e.target === cleanHost);
    }

    this.dynamicHosts.add(cleanHost);
    const entry: BlockedEntry = {
      id: `blk_host_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'host',
      target: cleanHost,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.pendingAdds.set(entryKey(entry), entry);
    this.schedulePersist();
    this.notify();
    return entry;
  }

  blockUrl(rawUrl: string, reason = 'Report mitigation'): BlockedEntry | undefined {
    let keys: CanonicalUrlKeys;
    try {
      keys = this.canonicalKeys(new URL(rawUrl));
    } catch {
      return undefined;
    }
    if (this.dynamicUrls.has(keys.exact)) {
      return this.entries.find((e) => e.type === 'url' && e.target === keys.exact);
    }

    this.indexUrlKeys(keys);
    const entry: BlockedEntry = {
      id: `blk_url_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'url',
      target: keys.exact,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.pendingAdds.set(entryKey(entry), entry);
    this.schedulePersist();
    this.notify();
    return entry;
  }

  unblock(id: string): boolean {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    const [removed] = this.entries.splice(index, 1);
    if (removed) {
      this.pendingAdds.delete(entryKey(removed));
    }
    this.pendingDeletes.add(id);
    this.rebuildSets();
    this.schedulePersist();
    this.notify();
    return true;
  }

  listBlocked(): readonly BlockedEntry[] {
    this.maybeReloadFromDisk();
    return [...this.entries];
  }

  private canonicalKeys(url: URL): CanonicalUrlKeys {
    let candidate = url;
    if (this.canonicalizeUrl) {
      try {
        candidate = this.canonicalizeUrl(url);
      } catch {
        candidate = url;
      }
    }
    return canonicalUrlKeys(candidate);
  }

  private indexUrlKeys(keys: CanonicalUrlKeys): void {
    this.dynamicUrls.add(keys.exact);
    if (!keys.hasQuery) {
      this.dynamicPathUrls.add(keys.pathOnly);
      return;
    }
    let rules = this.dynamicQueryUrls.get(keys.pathOnly);
    if (!rules) {
      rules = [];
      this.dynamicQueryUrls.set(keys.pathOnly, rules);
    }
    rules.push(keys.params);
  }

  private rebuildSets(): void {
    this.dynamicHosts.clear();
    this.dynamicUrls.clear();
    this.dynamicPathUrls.clear();
    this.dynamicQueryUrls.clear();
    for (const entry of this.entries) {
      if (entry.type === 'host') {
        this.dynamicHosts.add(stripWww(entry.target.trim().toLowerCase()));
      } else if (entry.type === 'url') {
        try {
          const keys = this.canonicalKeys(new URL(entry.target));
          this.indexUrlKeys(keys);
        } catch {
          this.dynamicUrls.add(entry.target);
        }
      }
    }
  }

  private mergeWithPending(diskEntries: readonly BlockedEntry[]): BlockedEntry[] {
    const byKey = new Map<string, BlockedEntry>();
    for (const entry of diskEntries) {
      if (this.pendingDeletes.has(entry.id)) continue;
      byKey.set(entryKey(entry), entry);
    }
    for (const [key, entry] of this.pendingAdds) {
      if (this.pendingDeletes.has(entry.id)) continue;
      if (!byKey.has(key)) {
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()];
  }

  private schedulePersist(): void {
    if (!this.filePath) return;
    const filePath = this.filePath;
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const snapshotAdds = new Map(this.pendingAdds);
        const snapshotDeletes = new Set(this.pendingDeletes);
        const diskEntries = (await readDiskEntries(filePath)) ?? [];
        const byKey = new Map<string, BlockedEntry>();
        for (const entry of diskEntries) {
          if (snapshotDeletes.has(entry.id)) continue;
          byKey.set(entryKey(entry), entry);
        }
        for (const [key, entry] of snapshotAdds) {
          if (snapshotDeletes.has(entry.id)) continue;
          if (!byKey.has(key)) byKey.set(key, entry);
        }
        const merged = [...byKey.values()];
        const tmpPath = `${filePath}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(tmpPath, JSON.stringify({ entries: merged }, null, 2), 'utf-8');
          await rename(tmpPath, filePath);
          const info = await stat(filePath).catch(() => undefined);
          if (info) this.lastMtimeMs = info.mtimeMs;
          for (const [key, added] of snapshotAdds) {
            if (this.pendingAdds.get(key) === added) this.pendingAdds.delete(key);
          }
          for (const id of snapshotDeletes) {
            this.pendingDeletes.delete(id);
          }
          const finalEntries = this.mergeWithPending(merged);
          const changed = entriesFingerprint(finalEntries) !== entriesFingerprint(this.entries);
          this.entries.length = 0;
          this.entries.push(...finalEntries);
          this.rebuildSets();
          if (changed) this.notify();
        } catch {
          await rm(tmpPath, { force: true }).catch(() => undefined);
        }
      });
  }
}

function entryKey(entry: BlockedEntry): string {
  return `${entry.type}:${entry.target}`;
}

function entriesFingerprint(entries: readonly BlockedEntry[]): string {
  return entries.map((e) => `${e.id}|${e.type}|${e.target}`).join('\n');
}

async function readDiskEntries(filePath: string): Promise<BlockedEntry[] | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: BlockedEntry[] };
    if (!Array.isArray(data.entries)) return undefined;
    return data.entries.filter((entry) => Boolean(entry?.target && entry?.type));
  } catch {
    return undefined;
  }
}

function canonicalUrlKeys(url: URL): CanonicalUrlKeys {
  const normalized = normalizeUrl(url);
  if (normalized.protocol === 'http:') normalized.protocol = 'https:';
  normalized.hostname = stripWww(normalized.hostname.toLowerCase());
  const exact = normalized.toString();
  const params = [...normalized.searchParams.entries()];
  const hasQuery = params.length > 0;
  normalized.search = '';
  const pathOnly = normalized.toString();
  return { exact, pathOnly, hasQuery, params };
}
