import { randomUUID } from 'node:crypto';
import { seraError, type SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import type { ExtractionBackend, NetworkClass } from './router.js';

/**
 * Work handed to an extraction node on another network.
 *
 * The node dials out and asks for work; nothing listens on it and nothing routable
 * reaches it. That is the whole security story: a residential machine that accepts no
 * connections cannot be turned into an open proxy, however the credential is handled.
 *
 * Two kinds of work, and it has to be both. A media URL YouTube signs is bound to the
 * address that asked for it — the same URL answers 206 at home and 403 on the server —
 * so a resolution taken on one network and a download taken on another do not compose.
 * A node that resolves a link owns the download too.
 */
export type RemoteTaskKind = 'resolve' | 'job';

export interface RemoteTask {
  readonly id: string;
  readonly kind: RemoteTaskKind;
  readonly url: string;
  readonly providerId: string;
  /** When set, only a node on this kind of connection may take it. */
  readonly networkClass?: NetworkClass;
  /** For a job: which plan to produce, by the same key the local runner uses. */
  readonly planKeys?: readonly string[];
  readonly filename?: string;
  readonly createdAt: number;
}

export interface RemoteProgress {
  readonly percent: number;
  readonly step: string;
  readonly bytesDownloaded?: number;
  readonly bytesTotal?: number;
}

interface Waiter {
  /** Which node is waiting, so a task is only ever handed to a node that accepts it. */
  readonly node: NodeRecord;
  readonly resolve: (task: RemoteTask | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

interface NodeRecord {
  readonly id: string;
  providers: string[];
  capacity: number;
  networkClass: NetworkClass;
  seen: number;
}

interface Pending {
  readonly task: RemoteTask;
  readonly settle: (outcome: {
    media?: ResolvedMedia;
    files?: readonly RemoteFile[];
    error?: SeraError;
  }) => void;
  /** Files uploaded so far for a `job` task, in the order the node sent them. */
  readonly files: RemoteFile[];
  readonly onProgress?: (progress: RemoteProgress) => void;
  readonly timer: NodeJS.Timeout;
  cancelled: boolean;
  claimedAt?: number;
  /** Which node took it, so concurrency is counted per node rather than in total. */
  claimedBy?: string;
}

/** What a completed `job` task produces: files already written to shared storage. */
export interface RemoteFile {
  readonly name: string;
  readonly mimeType: string;
  /** Absolute path under the data directory, written by the upload endpoint. */
  readonly path: string;
}

export interface NodeStatus {
  readonly id: string;
  readonly providers: readonly string[];
  readonly networkClass: NetworkClass;
  readonly capacity: number;
  readonly inFlight: number;
  readonly lastSeenMs: number;
  readonly healthy: boolean;
}

/**
 * What the router and the job runner need from "somewhere a node can be reached".
 *
 * Two things satisfy it. `ExtractionNodeRegistry` is the real one, in the process the
 * node dialled. `RemoteOverHttp` is the same thing seen from another process — which
 * the worker needs, because a node holds one connection to one process and on this
 * deployment that process is the API.
 */
export interface RemoteExtraction {
  status(): NodeStatus[];
  availableProviders(networkClass?: NetworkClass): string[];
  hasHealthyNode(networkClass?: NetworkClass): boolean;
  networkClasses(): NetworkClass[];
  dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options?: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal },
  ): Promise<ResolvedMedia>;
  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options?: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal },
  ): Promise<readonly RemoteFile[]>;
}

/**
 * The dispatch point between the API and however many extraction nodes are connected.
 *
 * Deliberately not a queue in Redis. Remote work is only ever attempted when the local
 * network has already refused, it is bounded by the node's own capacity, and a task that
 * outlives its node should die rather than sit in durable storage waiting to surprise
 * someone. Everything here is in memory and expires.
 */
export class ExtractionNodeRegistry implements RemoteExtraction {
  private readonly queue: RemoteTask[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly nodes = new Map<string, NodeRecord>();

  constructor(
    private readonly logger: Logger,
    /** A node that has not asked for work in this long is not counted as available. */
    private readonly staleAfterMs = 90_000,
    /** How long a task may wait for a node before the caller gives up on it. */
    private readonly taskTimeoutMs = 15 * 60_000,
  ) {}

  /* ----------------------------------------------------------- node side */

  /** Records that a node is alive and asking for work. */
  register(
    nodeId: string,
    providers: readonly string[],
    capacity: number,
    networkClass: NetworkClass = 'residential',
  ): NodeRecord {
    const known = this.nodes.get(nodeId);
    const record: NodeRecord = {
      id: nodeId,
      providers: [...providers],
      capacity: Math.max(1, capacity),
      networkClass,
      seen: Date.now(),
    };
    this.nodes.set(nodeId, record);
    if (!known) {
      this.logger.info(
        { node: nodeId, providers, capacity, networkClass },
        'extraction node connected',
      );
    }
    return record;
  }

  /**
   * Whether this node may take this task.
   *
   * Three questions, and the first two used to be asked in only one of the two places a
   * task can reach a node. A task queued while a node was already waiting went out with
   * neither check, so a node told to do YouTube alone could be handed Instagram.
   */
  private accepts(node: NodeRecord, task: RemoteTask): boolean {
    if (node.providers.length && !node.providers.includes(task.providerId)) return false;
    if (task.networkClass && task.networkClass !== node.networkClass) return false;
    return this.inFlightFor(node.id) < node.capacity;
  }

  private inFlightFor(nodeId: string): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.claimedBy === nodeId) count += 1;
    }
    return count;
  }

  /**
   * Hands out one task, waiting up to `holdMs` for one to appear.
   *
   * The long hold is what makes this a heartbeat as well as a queue: a node that is
   * asking is a node that is alive, and no separate ping is needed.
   */
  claim(
    nodeId: string,
    providers: readonly string[],
    capacity: number,
    holdMs: number,
    networkClass: NetworkClass = 'residential',
  ): Promise<RemoteTask | undefined> {
    const node = this.register(nodeId, providers, capacity, networkClass);

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

  /** Whether the caller has given up, so a node can stop working on it. */
  isCancelled(taskId: string): boolean {
    const pending = this.pending.get(taskId);
    return !pending || pending.cancelled;
  }

  reportProgress(taskId: string, progress: RemoteProgress): void {
    this.pending.get(taskId)?.onProgress?.(progress);
  }

  completeResolve(taskId: string, media: ResolvedMedia): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    pending.settle({ media });
    return true;
  }

  /** Records one uploaded file. Order is preserved, which a carousel depends on. */
  acceptFile(taskId: string, file: RemoteFile): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    pending.files.push(file);
    return true;
  }

  /** Settles a `job` task with everything the node uploaded for it. */
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

  /* ----------------------------------------------------------- API side */

  status(): NodeStatus[] {
    const now = Date.now();
    return [...this.nodes.values()].map((node) => ({
      id: node.id,
      providers: node.providers,
      networkClass: node.networkClass,
      capacity: node.capacity,
      inFlight: this.inFlightFor(node.id),
      lastSeenMs: now - node.seen,
      healthy: now - node.seen < this.staleAfterMs,
    }));
  }

  /** Providers at least one live node will take, optionally on one kind of connection. */
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

  /** The kinds of connection currently represented, so a backend exists per network. */
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

  /** Queues a resolve and waits for a node to answer it. */
  dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<ResolvedMedia> {
    return this.enqueue(task, options).then((outcome) => {
      if (!outcome.media) {
        throw seraError('PROVIDER_UNAVAILABLE', { detail: 'remote: node returned no media' });
      }
      return outcome.media;
    });
  }

  /** Queues a download and waits for the files the node uploads for it. */
  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<readonly RemoteFile[]> {
    return this.enqueue({ ...task, kind: 'job' }, options).then((outcome) => {
      if (!outcome.files?.length) {
        throw seraError('MEDIA_UNAVAILABLE', { detail: 'remote: node produced no files' });
      }
      return outcome.files;
    });
  }

  private enqueue(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }> {
    const full: RemoteTask = { ...task, id: randomUUID().replace(/-/g, ''), createdAt: Date.now() };

    return new Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }>(
      (resolve, reject) => {
        const finish = (outcome: {
          media?: ResolvedMedia;
          files?: readonly RemoteFile[];
          error?: SeraError;
        }): void => {
          const pending = this.pending.get(full.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(full.id);
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
          files: [],
          timer,
          cancelled: false,
        };
        this.pending.set(full.id, pending);

        options.signal?.addEventListener('abort', () => {
          pending.cancelled = true;
          // Remove it if no node has taken it yet; a node that has will see the flag.
          const queued = this.queue.indexOf(full);
          if (queued !== -1) this.queue.splice(queued, 1);
          finish({ error: seraError('CANCELLED') });
        });

        this.queue.push(full);
        this.wakeOne();
      },
    );
  }

  /**
   * Gives queued work to whichever waiting node will take it.
   *
   * Both sides are matched here, not just the front of each list: a node holding a
   * request open for YouTube keeps holding it while an Instagram task goes to a node
   * that wants Instagram, instead of being handed work it declared it would not do.
   */
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
    }
  }
}

/**
 * The router's view of a set of extraction nodes: one backend, however many machines.
 */
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

/** One backend per kind of connection currently connected. */
export function remoteBackends(registry: RemoteExtraction): ExtractionBackend[] {
  return registry.networkClasses().map((networkClass) => remoteBackend(registry, networkClass));
}
