import { classifyFailure, isDefinitive } from './failure.js';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  NodeFeature,
  NodeStatus,
  NodeTransport,
  RemoteProgress,
  RemoteTask,
  RemoteTaskItem,
  RemoteTaskKind,
} from '@sera/contracts/types';
import { seraError, type SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import type { ExtractionBackend, NetworkClass } from './router.js';

export type {
  NodeFeature,
  NodeStatus,
  NodeTransport,
  RemoteProgress,
  RemoteTask,
  RemoteTaskItem,
  RemoteTaskKind,
};

export interface NodeMetadata {
  readonly transport?: NodeTransport;
  readonly appVersion?: string;
  readonly ytdlpVersion?: string;
  readonly ffmpegVersion?: string;
}

export function requiredFeatures(
  task: Pick<RemoteTask, 'trim' | 'subtitles' | 'items' | 'requires'>,
): NodeFeature[] {
  const required: NodeFeature[] = [...(task.requires ?? [])];
  if (task.trim) required.push('trim');
  if (task.subtitles) required.push('subtitles');
  if (task.items?.length) required.push('items');
  return required;
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
  transport?: NodeTransport;
  appVersion?: string;
  ytdlpVersion?: string;
  ffmpegVersion?: string;
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
  readonly onTaskId?: (taskId: string) => void;
  readonly timer: NodeJS.Timeout;
  unclaimedTimer?: NodeJS.Timeout;
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

const DEFAULT_LEASE_SECONDS = 60;

function defaultLeaseMs(): number {
  const raw = process.env.SERA_EXTRACTION_LEASE_SECONDS;
  if (!raw) return DEFAULT_LEASE_SECONDS * 1000;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_SECONDS * 1000;
  return parsed * 1000;
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
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ResolvedMedia>;
  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options?: {
      onProgress?: (progress: RemoteProgress) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<readonly RemoteFile[]>;
}

const DEFAULT_UNCLAIMED_TIMEOUT_MS = 30_000;

export class ExtractionNodeRegistry implements RemoteExtraction {
  private readonly queue: RemoteTask[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly cleanupListeners = new Set<(taskId: string) => void>();
  private readonly settled = new Map<
    string,
    { claimedBy?: string; cancelled: boolean; settledAt: number }
  >();
  private readonly unclaimedTimeoutMs: number;

  constructor(
    private readonly logger: Logger,
    private readonly staleAfterMs = 90_000,
    private readonly taskTimeoutMs = 15 * 60_000,
    private readonly leaseMs = defaultLeaseMs(),
    unclaimedTimeoutMs?: number,
  ) {
    this.unclaimedTimeoutMs = Math.min(
      taskTimeoutMs,
      unclaimedTimeoutMs ?? DEFAULT_UNCLAIMED_TIMEOUT_MS,
    );
  }

  getTask(taskId: string): RemoteTask | undefined {
    return this.pending.get(taskId)?.task;
  }

  onTaskCleanup(listener: (taskId: string) => void): () => void {
    this.cleanupListeners.add(listener);
    return () => {
      this.cleanupListeners.delete(listener);
    };
  }

  private emitCleanup(taskId: string): void {
    for (const listener of this.cleanupListeners) {
      try {
        listener(taskId);
      } catch {}
    }
  }

  register(
    nodeId: string,
    providers: readonly string[],
    capacity: number,
    networkClass: NetworkClass = 'residential',
    features: readonly string[] = [],
    metadata?: NodeMetadata,
  ): NodeRecord {
    const known = this.nodes.get(nodeId);
    const transport = metadata?.transport ?? known?.transport;
    const appVersion = metadata?.appVersion ?? known?.appVersion;
    const ytdlpVersion = metadata?.ytdlpVersion ?? known?.ytdlpVersion;
    const ffmpegVersion = metadata?.ffmpegVersion ?? known?.ffmpegVersion;
    const record: NodeRecord = {
      id: nodeId,
      providers: [...providers],
      capacity: Math.max(1, capacity),
      networkClass,
      features: [...features],
      ...(transport ? { transport } : {}),
      ...(appVersion ? { appVersion } : {}),
      ...(ytdlpVersion ? { ytdlpVersion } : {}),
      ...(ffmpegVersion ? { ffmpegVersion } : {}),
      seen: Date.now(),
    };
    this.nodes.set(nodeId, record);
    if (
      known?.features.join() !== record.features.join() ||
      known?.transport !== record.transport
    ) {
      this.logger.info(
        {
          node: nodeId,
          providers,
          capacity,
          networkClass,
          features,
          ...(transport ? { transport } : {}),
          ...(appVersion ? { appVersion } : {}),
          ...(ytdlpVersion ? { ytdlpVersion } : {}),
          ...(ffmpegVersion ? { ffmpegVersion } : {}),
        },
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
    metadata?: NodeMetadata,
  ): Promise<RemoteTask | undefined> {
    const node = this.register(nodeId, providers, capacity, networkClass, features, metadata);

    const ready = this.queue.findIndex((task) => this.accepts(node, task));
    if (ready !== -1) {
      const [task] = this.queue.splice(ready, 1);
      this.markClaimed(task!, node.id);
      return Promise.resolve(task);
    }

    for (let i = this.waiting.length - 1; i >= 0; i -= 1) {
      const existing = this.waiting[i]!;
      if (existing.node.id === nodeId) {
        clearTimeout(existing.timer);
        this.waiting.splice(i, 1);
        existing.resolve(undefined);
      }
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
    if (pending) return pending.cancelled;
    const settled = this.settled.get(taskId);
    if (settled) return settled.cancelled;
    return true;
  }

  claimedBy(taskId: string): string | undefined {
    return this.pending.get(taskId)?.claimedBy ?? this.settled.get(taskId)?.claimedBy;
  }

  private sweepSettled(): void {
    const now = Date.now();
    for (const [id, entry] of this.settled) {
      if (now - entry.settledAt > 60_000) this.settled.delete(id);
    }
    const pruneAfterMs = Math.max(this.staleAfterMs * 10, this.staleAfterMs + 5000);
    for (const [nodeId, node] of this.nodes) {
      if (now - node.seen > pruneAfterMs && this.inFlightFor(nodeId) === 0) {
        this.nodes.delete(nodeId);
      }
    }
  }

  renewLease(taskId: string): boolean {
    const pending = this.pending.get(taskId);
    if (!pending || pending.cancelled) return false;
    this.renew(pending);
    if (pending.claimedBy) {
      const node = this.nodes.get(pending.claimedBy);
      if (node) node.seen = Date.now();
    }
    return true;
  }

  reportProgress(taskId: string, progress: RemoteProgress): void {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    this.renew(pending);
    if (pending.claimedBy) {
      const node = this.nodes.get(pending.claimedBy);
      if (node) node.seen = Date.now();
    }
    pending.onProgress?.(progress);
  }

  completeResolve(taskId: string, media: ResolvedMedia): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    if (pending.task.kind !== 'resolve' || media.provider !== pending.task.providerId) {
      return false;
    }
    pending.settle({ media });
    return true;
  }

  acceptFile(taskId: string, file: RemoteFile): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    this.renew(pending);
    if (pending.claimedBy) {
      const node = this.nodes.get(pending.claimedBy);
      if (node) node.seen = Date.now();
    }
    const existingIndex = pending.files.findIndex(
      (entry) => entry.name.toLowerCase() === file.name.toLowerCase(),
    );
    if (existingIndex !== -1) {
      pending.files[existingIndex] = file;
    } else {
      pending.files.push(file);
    }
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
    this.sweepSettled();
    const now = Date.now();
    return [...this.nodes.values()].map((node) => ({
      id: node.id,
      providers: node.providers,
      networkClass: node.networkClass,
      capacity: node.capacity,
      features: node.features,
      ...(node.transport ? { transport: node.transport } : {}),
      ...(node.appVersion ? { appVersion: node.appVersion } : {}),
      ...(node.ytdlpVersion ? { ytdlpVersion: node.ytdlpVersion } : {}),
      ...(node.ffmpegVersion ? { ffmpegVersion: node.ffmpegVersion } : {}),
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
      onTaskId?: (taskId: string) => void;
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
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<readonly RemoteFile[]> {
    const required = requiredFeatures(task);
    const nodes = this.live(task.networkClass).filter(
      (node) => !node.providers.length || node.providers.includes(task.providerId),
    );
    if (this.nodes.size > 0 && nodes.length === 0) {
      if (required.includes('instagram-session')) {
        return Promise.reject(
          seraError('PROVIDER_AUTH_REQUIRED', {
            message: 'This post needs a connected extraction node with an Instagram session.',
            detail: 'remote: no healthy extraction node available',
          }),
        );
      }
      return Promise.reject(
        seraError('PROVIDER_UNAVAILABLE', {
          detail: 'remote: no healthy extraction node available for this provider',
        }),
      );
    }
    if (
      required.length &&
      nodes.length &&
      !nodes.some((node) => required.every((feature) => node.features.includes(feature)))
    ) {
      if (required.includes('instagram-session')) {
        return Promise.reject(
          seraError('PROVIDER_AUTH_REQUIRED', {
            message: 'This post needs a connected extraction node with an Instagram session.',
            detail: `remote: no connected node declares ${required.join(', ')}`,
          }),
        );
      }
      return Promise.reject(
        seraError('PROVIDER_UNAVAILABLE', {
          message: required.includes('trim')
            ? 'Trimming cannot be done for this source right now. The full download still works.'
            : required.includes('subtitles')
              ? 'Subtitles cannot be done for this source right now. The full download still works.'
              : 'Downloading only some items of this post cannot be done right now. Selecting all of them still works.',
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

  private hasEligibleLiveNode(task: RemoteTask): boolean {
    const needed = requiredFeatures(task);
    return this.live(task.networkClass).some(
      (node) =>
        (!node.providers.length || node.providers.includes(task.providerId)) &&
        !task.avoid?.includes(node.id) &&
        needed.every((feature) => node.features.includes(feature)),
    );
  }

  private armUnclaimed(pending: Pending): void {
    if (pending.unclaimedTimer) clearTimeout(pending.unclaimedTimer);
    if (this.unclaimedTimeoutMs >= this.taskTimeoutMs) return;
    pending.unclaimedTimer = setTimeout(() => {
      pending.unclaimedTimer = undefined;
      if (this.pending.get(pending.task.id) !== pending || pending.claimedBy !== undefined) return;
      if (this.hasEligibleLiveNode(pending.task)) return;
      const queued = this.queue.indexOf(pending.task);
      if (queued !== -1) this.queue.splice(queued, 1);
      pending.settle({
        error: seraError('PROVIDER_UNAVAILABLE', {
          detail: `remote: no healthy node claimed task within ${Math.round(this.unclaimedTimeoutMs / 1000)}s`,
        }),
      });
    }, this.unclaimedTimeoutMs);
    pending.unclaimedTimer.unref();
  }

  private enqueue(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }> {
    if (options.signal?.aborted) {
      return Promise.reject(seraError('CANCELLED'));
    }
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
          options.signal?.removeEventListener('abort', onAbort);
          clearTimeout(pending.timer);
          clearTimeout(pending.unclaimedTimer);
          clearTimeout(pending.leaseTimer);
          this.pending.delete(id);
          this.sweepSettled();
          this.settled.set(id, {
            claimedBy: pending.claimedBy,
            cancelled: pending.cancelled || outcome.error?.code === 'CANCELLED',
            settledAt: Date.now(),
          });
          this.wakeOne();
          if (outcome.error) {
            this.emitCleanup(id);
            cleanupFiles(pending.files);
            pending.files.length = 0;
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
          ...(options.onTaskId ? { onTaskId: options.onTaskId } : {}),
          files: [],
          timer,
          cancelled: false,
        };
        this.pending.set(full.id, pending);
        options.onTaskId?.(full.id);

        const onAbort = () => {
          pending.cancelled = true;
          const queued = this.queue.indexOf(pending.task);
          if (queued !== -1) this.queue.splice(queued, 1);
          finish({ error: seraError('CANCELLED') });
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        this.queue.push(full);
        this.armUnclaimed(pending);
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
      if (pending.unclaimedTimer) {
        clearTimeout(pending.unclaimedTimer);
        pending.unclaimedTimer = undefined;
      }
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
    this.sweepSettled();
    this.settled.set(previous.id, {
      ...(silentNode ? { claimedBy: silentNode } : {}),
      cancelled: true,
      settledAt: Date.now(),
    });
    this.pending.delete(previous.id);

    this.emitCleanup(previous.id);
    cleanupFiles(pending.files);
    const needed = requiredFeatures(previous);
    const hasAlternativeNode =
      silentNode !== undefined &&
      this.live(previous.networkClass).some(
        (node) =>
          node.id !== silentNode &&
          !previous.avoid?.includes(node.id) &&
          (!node.providers.length || node.providers.includes(previous.providerId)) &&
          needed.every((feature) => node.features.includes(feature)),
      );
    const avoid = hasAlternativeNode
      ? [...new Set([...(previous.avoid ?? []), silentNode])]
      : previous.avoid;
    pending.task = {
      ...previous,
      id: newTaskId(),
      ...(avoid?.length ? { avoid } : {}),
    };
    pending.files.length = 0;
    delete pending.claimedAt;
    delete pending.claimedBy;
    delete pending.leaseUntil;
    this.pending.set(pending.task.id, pending);
    pending.onTaskId?.(pending.task.id);

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
    this.armUnclaimed(pending);
    this.wakeOne();
  }
}

function cleanupFiles(files: readonly RemoteFile[]): void {
  const dirs = new Set<string>();
  for (const file of files) {
    if (file.path) dirs.add(dirname(file.path));
  }
  for (const dir of dirs) {
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
  providerId?: string,
): ExtractionBackend {
  return {
    id: feature,
    kind: 'remote',
    networkClass: 'residential',
    get providers() {
      return registry.availableProviders();
    },
    isHealthy: () => registry.hasFeature(feature, providerId),
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
