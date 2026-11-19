import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  private readonly dynamicHosts = new Set<string>();
  private readonly dynamicUrls = new Set<string>();
  private readonly dynamicPathUrls = new Set<string>();
  private readonly entries: BlockedEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private lastMtimeMs = 0;
  private lastReloadCheckMs = 0;

  constructor(options: DenylistOptions = {}) {
    this.staticHosts = (options.staticHosts ?? []).map((h) => stripWww(h.trim().toLowerCase()));
    this.filePath = options.filePath;
    if (options.onUpdate) this.listeners.add(options.onUpdate);
    this.load();
  }

  onUpdate(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private maybeReloadFromDisk(): void {
    if (!this.filePath) return;
    const now = Date.now();
    if (now - this.lastReloadCheckMs < 5_000) return;
    this.lastReloadCheckMs = now;
    try {
      const mtimeMs = statSync(this.filePath).mtimeMs;
      if (mtimeMs > this.lastMtimeMs) {
        this.load();
      }
    } catch {}
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

    const keys = canonicalUrlKeys(url);
    if (
      this.dynamicUrls.has(keys.exact) ||
      (keys.pathOnly !== undefined && this.dynamicPathUrls.has(keys.pathOnly))
    ) {
      return { blocked: true, reason: 'url is blocked' };
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
    this.save();
    this.notify();
    return entry;
  }

  blockUrl(rawUrl: string, reason = 'Report mitigation'): BlockedEntry | undefined {
    let keys: { exact: string; pathOnly: string; hasQuery: boolean };
    try {
      keys = canonicalUrlKeys(new URL(rawUrl));
    } catch {
      return undefined;
    }
    if (this.dynamicUrls.has(keys.exact)) {
      return this.entries.find((e) => e.type === 'url' && e.target === keys.exact);
    }

    this.dynamicUrls.add(keys.exact);
    if (keys.hasQuery === false) {
      this.dynamicPathUrls.add(keys.pathOnly);
    }
    const entry: BlockedEntry = {
      id: `blk_url_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'url',
      target: keys.exact,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.save();
    this.notify();
    return entry;
  }

  unblock(id: string): boolean {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.rebuildSets();
    this.save();
    this.notify();
    return true;
  }

  listBlocked(): readonly BlockedEntry[] {
    this.maybeReloadFromDisk();
    return [...this.entries];
  }

  private rebuildSets(): void {
    this.dynamicHosts.clear();
    this.dynamicUrls.clear();
    this.dynamicPathUrls.clear();
    for (const entry of this.entries) {
      if (entry.type === 'host') {
        this.dynamicHosts.add(stripWww(entry.target.trim().toLowerCase()));
      } else if (entry.type === 'url') {
        try {
          const keys = canonicalUrlKeys(new URL(entry.target));
          this.dynamicUrls.add(keys.exact);
          if (!keys.hasQuery) this.dynamicPathUrls.add(keys.pathOnly);
        } catch {
          this.dynamicUrls.add(entry.target);
        }
      }
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const mtimeMs = statSync(this.filePath).mtimeMs;
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as { entries?: BlockedEntry[] };
      if (!Array.isArray(data.entries)) return;
      this.entries.length = 0;
      for (const entry of data.entries) {
        if (!entry.target || !entry.type) continue;
        this.entries.push(entry);
      }
      this.rebuildSets();
      this.lastMtimeMs = mtimeMs;
    } catch {}
  }

  private save(): void {
    if (!this.filePath) return;
    const tmpPath = `${this.filePath}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
      this.lastMtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    }
  }
}

function canonicalUrlKeys(url: URL): { exact: string; pathOnly: string; hasQuery: boolean } {
  const normalized = normalizeUrl(url);
  if (normalized.protocol === 'http:') normalized.protocol = 'https:';
  normalized.hostname = stripWww(normalized.hostname.toLowerCase());
  const exact = normalized.toString();
  const hasQuery = normalized.search.length > 0;
  normalized.search = '';
  const pathOnly = normalized.toString();
  return { exact, pathOnly, hasQuery };
}
