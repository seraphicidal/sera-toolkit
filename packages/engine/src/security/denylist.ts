import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostMatchesAny, normalizeUrl, stripWww } from './url.js';

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
}

export class Denylist {
  private readonly staticHosts: readonly string[];
  private readonly filePath?: string;
  private readonly dynamicHosts = new Set<string>();
  private readonly dynamicUrls = new Set<string>();
  private readonly entries: BlockedEntry[] = [];

  constructor(options: DenylistOptions = {}) {
    this.staticHosts = (options.staticHosts ?? []).map((h) => stripWww(h.toLowerCase()));
    this.filePath = options.filePath;
    this.load();
  }

  isBlocked(target: string | URL): { readonly blocked: boolean; readonly reason?: string } {
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

    if (this.dynamicHosts.size > 0 && hostMatchesAny(host, [...this.dynamicHosts])) {
      return { blocked: true, reason: 'host is blocked' };
    }

    const normalized = normalizeUrl(url).toString();
    if (this.dynamicUrls.has(normalized)) {
      return { blocked: true, reason: 'url is blocked' };
    }

    return { blocked: false };
  }

  blockHost(host: string, reason = 'Report mitigation'): BlockedEntry | undefined {
    const cleanHost = stripWww(host.toLowerCase());
    if (!cleanHost) return undefined;
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
    return entry;
  }

  blockUrl(rawUrl: string, reason = 'Report mitigation'): BlockedEntry | undefined {
    let normalized: string;
    try {
      normalized = normalizeUrl(new URL(rawUrl)).toString();
    } catch {
      return undefined;
    }
    if (this.dynamicUrls.has(normalized)) {
      return this.entries.find((e) => e.type === 'url' && e.target === normalized);
    }

    this.dynamicUrls.add(normalized);
    const entry: BlockedEntry = {
      id: `blk_url_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'url',
      target: normalized,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  unblock(id: string): boolean {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    const [removed] = this.entries.splice(index, 1);
    if (removed) {
      if (removed.type === 'host') {
        this.dynamicHosts.delete(stripWww(removed.target.toLowerCase()));
      } else if (removed.type === 'url') {
        this.dynamicUrls.delete(removed.target);
      }
    }
    this.save();
    return true;
  }

  listBlocked(): readonly BlockedEntry[] {
    return [...this.entries];
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as { entries?: BlockedEntry[] };
      if (!Array.isArray(data.entries)) return;
      for (const entry of data.entries) {
        if (!entry.target || !entry.type) continue;
        this.entries.push(entry);
        if (entry.type === 'host') {
          this.dynamicHosts.add(stripWww(entry.target.toLowerCase()));
        } else if (entry.type === 'url') {
          this.dynamicUrls.add(entry.target);
        }
      }
    } catch {}
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
    } catch {}
  }
}
