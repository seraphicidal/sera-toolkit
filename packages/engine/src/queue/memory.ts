import { EventEmitter } from 'node:events';
import { isTerminalJobState } from '@sera/contracts/types';
import type { Logger } from '../logging.js';
import {
  isActive,
  type JobBackend,
  type JobHandler,
  type JobPatch,
  type JobRecord,
  type WorkerHandle,
} from './types.js';

export class MemoryJobBackend implements JobBackend {
  readonly driver = 'memory' as const;

  private readonly records = new Map<string, JobRecord>();
  private readonly waiting: string[] = [];
  private readonly events = new EventEmitter();
  private readonly running = new Set<string>();
  private readonly activeByClient = new Map<string, Set<string>>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private handler: JobHandler | undefined;
  private concurrency = 1;
  private closed = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly retentionMs = 60 * 60_000,
  ) {
    this.events.setMaxListeners(0);
  }

  async submit(record: JobRecord): Promise<void> {
    this.records.set(record.id, record);
    if (isActive(record.state)) this.trackActive(record.clientKey, record.id);
    this.waiting.push(record.id);
    this.wake?.();
    return Promise.resolve();
  }

  get(id: string): Promise<JobRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  patch(id: string, patch: JobPatch): Promise<JobRecord | undefined> {
    const current = this.records.get(id);
    if (!current) return Promise.resolve(undefined);

    const allowingExpiration = current.state === 'ready' && patch.state === 'expired';
    if (isTerminalJobState(current.state) && !allowingExpiration) return Promise.resolve(current);

    const cleanedSpec = current.spec
      ? {
          ...current.spec,
          resolvedMedia: undefined,
          rawInfoJson: undefined,
        }
      : current.spec;

    const next: JobRecord = {
      ...current,
      ...patch,
      ...(cleanedSpec ? { spec: cleanedSpec } : {}),
      ...(patch.progress
        ? {
            progress: {
              ...patch.progress,
              percent: Math.max(current.progress.percent, patch.progress.percent),
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    if (!isActive(next.state)) {
      this.untrackActive(next.clientKey, id);
    }
    this.events.emit(id, next);

    if (!isActive(next.state)) this.scheduleEviction(id);
    return Promise.resolve(next);
  }

  subscribe(id: string, listener: (record: JobRecord) => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  waitingCount(): Promise<number> {
    return Promise.resolve(this.waiting.length);
  }

  activeCountFor(clientKey: string): Promise<number> {
    return Promise.resolve(this.activeByClient.get(clientKey)?.size ?? 0);
  }

  startWorker(handler: JobHandler, concurrency: number): WorkerHandle {
    this.handler = handler;
    this.concurrency = Math.max(1, concurrency);
    const loop = this.dispatchLoop();

    return {
      close: async () => {
        this.closed = true;
        this.wake?.();
        await loop;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    this.events.removeAllListeners();
    return Promise.resolve();
  }

  private async dispatchLoop(): Promise<void> {
    while (!this.closed) {
      while (this.running.size < this.concurrency && this.waiting.length > 0) {
        const id = this.waiting.shift()!;
        void this.process(id);
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        this.wake = done;
        const timer = setTimeout(done, 250);
        timer.unref();
      });
      this.wake = undefined;
    }
    while (this.running.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref();
      });
    }
  }

  private async process(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.handler) return;

    this.running.add(id);
    try {
      await this.handler(record);
    } catch (error) {
      this.logger.error({ err: error, jobId: id }, 'job handler threw');
    } finally {
      this.running.delete(id);
      this.wake?.();
    }
  }

  private trackActive(clientKey: string, id: string): void {
    let ids = this.activeByClient.get(clientKey);
    if (!ids) {
      ids = new Set();
      this.activeByClient.set(clientKey, ids);
    }
    ids.add(id);
  }

  private untrackActive(clientKey: string, id: string): void {
    const ids = this.activeByClient.get(clientKey);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.activeByClient.delete(clientKey);
  }

  private scheduleEviction(id: string): void {
    const prev = this.evictionTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.evictionTimers.delete(id);
      const record = this.records.get(id);
      if (record) this.untrackActive(record.clientKey, id);
      this.records.delete(id);
    }, this.retentionMs);
    timer.unref();
    this.evictionTimers.set(id, timer);
  }
}
