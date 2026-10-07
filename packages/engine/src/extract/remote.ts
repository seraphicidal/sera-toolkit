import { classifyFailure, isDefinitive } from './failure.js';
import { randomUUID } from 'node:crypto';
import type { TrimRange } from '@sera/contracts/types';
import { seraError, type SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import type { ExtractionBackend, NetworkClass } from './router.js';

export type RemoteTaskKind = 'resolve' | 'job';

export interface RemoteTask {
  readonly id: string;
  readonly kind: RemoteTaskKind;
  readonly url: string;
  readonly providerId: string;
  readonly networkClass?: NetworkClass;
  readonly planKeys?: readonly string[];
  readonly filename?: string;
  readonly trim?: TrimRange;
  readonly requires?: readonly NodeFeature[];
  readonly avoid?: readonly string[];
  readonly subtitles?: {
    readonly lang: string;
    readonly auto: boolean;
    readonly format: 'srt' | 'vtt' | 'embed';
    readonly only: boolean;
  };
  readonly createdAt: number;
}

export type NodeFeature = 'trim' | 'subtitles' | 'instagram-session';

export function requiredFeatures(
  task: Pick<RemoteTask, 'trim' | 'subtitles' | 'requires'>,
): NodeFeature[] {
  const required: NodeFeature[] = [...(task.requires ?? [])];
  if (task.trim) required.push('trim');
  if (task.subtitles) required.push('subtitles');
  return required;
}

export interface RemoteProgress {
  readonly percent: number;
  readonly step: string;
  readonly bytesDownloaded?: number;
  readonly bytesTotal?: number;
}

interface Waiter {
  readonly node: NodeRecord;
  readonly resolve: (task: RemoteTask | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

interface NodeRecord {
  readonly id: string;
  providers: string[];
  capacity: number;
  networkClass: NetworkClass;
  features: string[];
  seen: number;
}

interface Pending {
  task: RemoteTask;
  readonly settle: (outcome: {
    media?: ResolvedMedia;
    files?: readonly RemoteFile[];
    error?: SeraError;
  }) => void;
  readonly files: RemoteFile[];
  readonly onProgress?: (progress: RemoteProgress) => void;
  readonly onClaimed?: (nodeId: string) => void;
  readonly timer: NodeJS.Timeout;
  cancelled: boolean;
  claimedAt?: number;
  claimedBy?: string;
  leaseUntil?: number;
  leaseTimer?: NodeJS.Timeout;
}

export interface RemoteFile {
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
}

export interface NodeStatus {
  readonly id: string;
  readonly providers: readonly string[];
  readonly networkClass: NetworkClass;
  readonly capacity: number;
  readonly features?: readonly string[];
  readonly inFlight: number;
  readonly lastSeenMs: number;
  readonly healthy: boolean;
}

export interface RemoteExtraction {
  status(): NodeStatus[];
  availableProviders(networkClass?: NetworkClass): string[];
  hasHealthyNode(networkClass?: NetworkClass): boolean;
  networkClasses(): NetworkClass[];
  hasFeature(feature: NodeFeature, providerId?: string, except?: readonly string[]): boolean;
  dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options?: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ResolvedMedia>;
  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options?: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal },
  ): Promise<readonly RemoteFile[]>;
}

export class ExtractionNodeRegistry implements RemoteExtraction {
  private readonly queue: RemoteTask[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly nodes = new Map<string, NodeRecord>();

  constructor(
    private readonly logger: Logger,
    private readonly staleAfterMs = 90_000,
    private readonly taskTimeoutMs = 15 * 60_000,
    private readonly leaseMs = 45_000,
  ) {}

  register(
    nodeId: string,
    providers: readonly string[],
    capacity: number,
    networkClass: NetworkClass = 'residential',
    features: readonly string[] = [],
  ): NodeRecord {
    const known = this.nodes.get(nodeId);
    const record: NodeRecord = {
      id: nodeId,
      providers: [...providers],
      capacity: Math.max(1, capacity),
      networkClass,
      features: [...features],
      seen: Date.now(),
    };
    this.nodes.set(nodeId, record);
    if (known?.features.join() !== record.features.join()) {
      this.logger.info(
        { node: nodeId, providers, capacity, networkClass, features },
        'extraction node connected',
      );
    }
    return record;
  }

  private accepts(node: NodeRecord, task: RemoteTask): boolean {
    if (node.providers.length && !node.providers.includes(task.providerId)) return false;
    if (task.networkClass && task.networkClass !== node.networkClass) return false;
    if (task.avoid?.includes(node.id)) return false;
    if (!requiredFeatures(task).every((feature) => node.features.includes(feature))) return false;
    return this.inFlightFor(node.id) < node.capacity;
  }

  private inFlightFor(nodeId: string): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.claimedBy === nodeId) count += 1;
    }
    return count;
  }

  claim(
    nodeId: string,
    providers: readonly string[],
    capacity: number,
    holdMs: number,
    networkClass: NetworkClass = 'residential',
    features: readonly string[] = [],
  ): Promise<RemoteTask | undefined> {
    const node = this.register(nodeId, providers, capacity, networkClass, features);

    const ready = this.queue.findIndex((task) => this.accepts(node, task));
    if (ready !== -1) {
      const [task] = this.queue.splice(ready, 1);
      this.markClaimed(task!, node.id);
      return Promise.resolve(task);
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        node,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          resolve(undefined);
        }, holdMs),
      };
      waiter.timer.unref();
      this.waiting.push(waiter);
    });
  }

  isCancelled(taskId: string): boolean {
    const pending = this.pending.get(taskId);
    return !pending || pending.cancelled;
  }

  reportProgress(taskId: string, progress: RemoteProgress): void {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    this.renew(pending);
    pending.onProgress?.(progress);
  }

  completeResolve(taskId: string, media: ResolvedMedia): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    pending.settle({ media });
    return true;
  }

  acceptFile(taskId: string, file: RemoteFile): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    this.renew(pending);
    pending.files.push(file);
    return true;
  }

  completeJob(taskId: string): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    if (!pending.files.length) {
      pending.settle({
        error: seraError('MEDIA_UNAVAILABLE', { detail: 'remote: node uploaded no files' }),
      });
      return true;
    }
    pending.settle({ files: [...pending.files] });
    return true;
  }

  fail(taskId: string, error: SeraError): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    pending.settle({ error });
    return true;
  }

  status(): NodeStatus[] {
    const now = Date.now();
    return [...this.nodes.values()].map((node) => ({
      id: node.id,
      providers: node.providers,
      networkClass: node.networkClass,
      capacity: node.capacity,
      features: node.features,
      inFlight: this.inFlightFor(node.id),
      lastSeenMs: now - node.seen,
      healthy: now - node.seen < this.staleAfterMs,
    }));
  }

  hasFeature(feature: NodeFeature, providerId?: string, except: readonly string[] = []): boolean {
    return this.live().some(
      (node) =>
        !except.includes(node.id) &&
        node.features.includes(feature) &&
        (providerId === undefined || !node.providers.length || node.providers.includes(providerId)),
    );
  }

  availableProviders(networkClass?: NetworkClass): string[] {
    const providers = new Set<string>();
    for (const node of this.live(networkClass)) {
      for (const provider of node.providers) providers.add(provider);
    }
    return [...providers];
  }

  hasHealthyNode(networkClass?: NetworkClass): boolean {
    return this.live(networkClass).length > 0;
  }

  networkClasses(): NetworkClass[] {
    return [...new Set(this.live().map((node) => node.networkClass))];
  }

  private live(networkClass?: NetworkClass): NodeRecord[] {
    const now = Date.now();
    return [...this.nodes.values()].filter(
      (node) =>
        now - node.seen < this.staleAfterMs &&
        (networkClass === undefined || node.networkClass === networkClass),
    );
  }

  dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<ResolvedMedia> {
    return this.enqueue(task, options).then((outcome) => {
      if (!outcome.media) {
        throw seraError('PROVIDER_UNAVAILABLE', { detail: 'remote: node returned no media' });
      }
      return outcome.media;
    });
  }

  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<readonly RemoteFile[]> {
    const required = requiredFeatures(task);
    const nodes = this.live(task.networkClass).filter(
      (node) => !node.providers.length || node.providers.includes(task.providerId),
    );
    if (
      required.length &&
      nodes.length &&
      !nodes.some((node) => required.every((feature) => node.features.includes(feature)))
    ) {
      return Promise.reject(
        seraError('PROVIDER_UNAVAILABLE', {
          message: `${required.includes('trim') ? 'Trimming' : 'Subtitles'} cannot be done for this source right now. The full download still works.`,
          detail: `remote: no connected node declares ${required.join(', ')}`,
        }),
      );
    }
    return this.enqueue({ ...task, kind: 'job' }, options).then((outcome) => {
      if (!outcome.files?.length) {
        throw seraError('MEDIA_UNAVAILABLE', { detail: 'remote: node produced no files' });
      }
      return outcome.files;
    });
  }

  private enqueue(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }> {
    const full: RemoteTask = { ...task, id: newTaskId(), createdAt: Date.now() };

    return new Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }>(
      (resolve, reject) => {
        const finish = (outcome: {
          media?: ResolvedMedia;
          files?: readonly RemoteFile[];
          error?: SeraError;
        }): void => {
          const id = pending.task.id;
          if (this.pending.get(id) !== pending) return;
          clearTimeout(pending.timer);
          clearTimeout(pending.leaseTimer);
          this.pending.delete(id);
          if (outcome.error) {
            reject(outcome.error);
            return;
          }
          resolve({
            ...(outcome.media ? { media: outcome.media } : {}),
            ...(outcome.files ? { files: outcome.files } : {}),
          });
        };

        const timer = setTimeout(() => {
          finish({
            error: seraError('TIMEOUT', {
              detail: `remote: no node answered within ${Math.round(this.taskTimeoutMs / 1000)}s`,
            }),
          });
        }, this.taskTimeoutMs);
        timer.unref();

        const pending: Pending = {
          task: full,
          settle: finish,
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          ...(options.onClaimed ? { onClaimed: options.onClaimed } : {}),
          files: [],
          timer,
          cancelled: false,
        };
        this.pending.set(full.id, pending);

        options.signal?.addEventListener('abort', () => {
          pending.cancelled = true;
          const queued = this.queue.indexOf(pending.task);
          if (queued !== -1) this.queue.splice(queued, 1);
          finish({ error: seraError('CANCELLED') });
        });

        this.queue.push(full);
        this.wakeOne();
      },
    );
  }

  private wakeOne(): void {
    for (const waiter of [...this.waiting]) {
      const index = this.queue.findIndex((task) => this.accepts(waiter.node, task));
      if (index === -1) continue;

      const [task] = this.queue.splice(index, 1);
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      this.markClaimed(task!, waiter.node.id);
      waiter.resolve(task);
      return;
    }
  }

  private markClaimed(task: RemoteTask, nodeId: string): void {
    const pending = this.pending.get(task.id);
    if (pending) {
      pending.claimedAt = Date.now();
      pending.claimedBy = nodeId;
      pending.onClaimed?.(nodeId);
      this.renew(pending);
    }
  }

  private renew(pending: Pending): void {
    if (pending.claimedBy === undefined) return;
    pending.leaseUntil = Date.now() + this.leaseMs;
    if (!pending.leaseTimer) this.armLease(pending, this.leaseMs);
  }

  private armLease(pending: Pending, delayMs: number): void {
    pending.leaseTimer = setTimeout(() => {
      pending.leaseTimer = undefined;
      if (this.pending.get(pending.task.id) !== pending || pending.claimedBy === undefined) return;
      const left = (pending.leaseUntil ?? 0) - Date.now();
      if (left > 0) {
        this.armLease(pending, left);
        return;
      }
      this.requeue(pending);
    }, delayMs);
    pending.leaseTimer.unref();
  }

  private requeue(pending: Pending): void {
    const previous = pending.task;
    const silentNode = pending.claimedBy;
    this.pending.delete(previous.id);

    pending.task = { ...previous, id: newTaskId() };
    pending.files.length = 0;
    delete pending.claimedAt;
    delete pending.claimedBy;
    delete pending.leaseUntil;
    this.pending.set(pending.task.id, pending);

    this.logger.warn(
      {
        task: previous.id,
        requeuedAs: pending.task.id,
        node: silentNode,
        kind: previous.kind,
        provider: previous.providerId,
        leaseSeconds: Math.round(this.leaseMs / 1000),
      },
      'extraction node went silent on a task; offering it again',
    );

    this.queue.unshift(pending.task);
    this.wakeOne();
  }
}

function newTaskId(): string {
  return randomUUID().replace(/-/g, '');
}

export function remoteBackend(
  registry: RemoteExtraction,
  networkClass: NetworkClass = 'residential',
): ExtractionBackend {
  return {
    id: networkClass,
    kind: 'remote',
    networkClass,
    get providers() {
      return registry.availableProviders(networkClass);
    },
    isHealthy: () => registry.hasHealthyNode(networkClass),
    resolve: (url, providerId, signal) =>
      registry.dispatch(
        { kind: 'resolve', url: url.toString(), providerId, networkClass },
        signal ? { signal } : {},
      ),
  };
}

export function remoteBackends(registry: RemoteExtraction): ExtractionBackend[] {
  return registry.networkClasses().map((networkClass) => remoteBackend(registry, networkClass));
}

export function sessionBackend(
  registry: RemoteExtraction,
  feature: NodeFeature,
): ExtractionBackend {
  return {
    id: feature,
    kind: 'remote',
    networkClass: 'residential',
    get providers() {
      return registry.availableProviders();
    },
    isHealthy: () => registry.hasFeature(feature),
    resolve: async (url, providerId, signal) => {
      const tried: string[] = [];
      for (;;) {
        let claimedBy: string | undefined;
        try {
          return await registry.dispatch(
            {
              kind: 'resolve',
              url: url.toString(),
              providerId,
              requires: [feature],
              ...(tried.length ? { avoid: [...tried] } : {}),
            },
            { onClaimed: (nodeId) => (claimedBy = nodeId), ...(signal ? { signal } : {}) },
          );
        } catch (error) {
          if (!claimedBy || isDefinitive(classifyFailure(error))) throw error;
          tried.push(claimedBy);
          if (!registry.hasFeature(feature, providerId, tried)) throw error;
        }
      }
    },
  };
}
