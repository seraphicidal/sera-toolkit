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

    if (isTerminalJobState(current.state)) return Promise.resolve(current);

    const next: JobRecord = {
      ...current,
      ...patch,
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
    let count = 0;
    for (const record of this.records.values()) {
      if (record.clientKey === clientKey && isActive(record.state)) count += 1;
    }
    return Promise.resolve(count);
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
        this.wake = resolve;
        const timer = setTimeout(resolve, 250);
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

  private scheduleEviction(id: string): void {
    const timer = setTimeout(() => this.records.delete(id), this.retentionMs);
    timer.unref();
  }
}
