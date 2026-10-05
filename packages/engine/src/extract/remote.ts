import { classifyFailure, isDefinitive } from './failure.js';
import { randomUUID } from 'node:crypto';
import type { TrimRange } from '@sera/contracts/types';
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
  /**
   * For a job: the item each plan key belongs to, in the same order. Without it a node takes
   * the n-th key as the n-th item, so the last slide of a carousel, picked on its own, came
   * back as the first.
   */
  readonly items?: readonly RemoteTaskItem[];
  readonly filename?: string;
  /** For a job: the part of its one item to keep, in seconds. The node does the cutting. */
  readonly trim?: TrimRange;
  /**
   * What the node must hold beyond the code to run the task: `instagram-session` for a post
   * only an account can read. Sent as a requirement, never as the credential itself, which
   * stays on the node.
   */
  readonly requires?: readonly NodeFeature[];
  /** Nodes not to give it to: those that already tried it and could not. */
  readonly avoid?: readonly string[];
  /** For a job: a subtitle track to embed or deliver, fetched by the node with the media. */
  readonly subtitles?: {
    readonly lang: string;
    readonly auto: boolean;
    readonly format: 'srt' | 'vtt' | 'embed';
    readonly only: boolean;
  };
  readonly createdAt: number;
}

/** One selected item of a job, as the resolution that offered it numbered it. */
export interface RemoteTaskItem {
  readonly index: number;
  readonly sourceId?: string;
}

/**
 * What a job can ask of a node beyond downloading, each a field a node from before it was
 * added would not know to read. Such a node would not refuse the task; it would ignore the
 * field and deliver the wrong file — the whole video for a trim, no subtitles for an embed —
 * so a node says which it understands, and a task needing one only goes to a node that does.
 */
export type NodeFeature = 'trim' | 'subtitles' | 'items' | 'instagram-session';

/** The features a task cannot be done correctly without. */
export function requiredFeatures(
  task: Pick<RemoteTask, 'trim' | 'subtitles' | 'items' | 'requires'>,
): NodeFeature[] {
  const required: NodeFeature[] = [...(task.requires ?? [])];
  if (task.trim) required.push('trim');
  if (task.subtitles) required.push('subtitles');
  // A node that does not read `items` pairs the n-th key with the n-th item, which is right
  // exactly when that is what was picked: one video, or every slide in order.
  if (task.items?.some((item, position) => item.index !== position)) required.push('items');
  return required;
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
  /** What the node said it understands; none for a node from before features existed. */
  features: string[];
  seen: number;
}

interface Pending {
  /**
   * The task as it is currently offered. Replaced, under a new id, when a lease lapses:
   * the id is what a node reports against, so the old one going dead is what makes a late
   * report from a node that went silent land nowhere.
   */
  task: RemoteTask;
  readonly settle: (outcome: {
    media?: ResolvedMedia;
    files?: readonly RemoteFile[];
    error?: SeraError;
  }) => void;
  /** Files uploaded so far for a `job` task, in the order the node sent them. */
  readonly files: RemoteFile[];
  readonly onProgress?: (progress: RemoteProgress) => void;
  /** Told which node took it, so a caller can try another if this one fails. */
  readonly onClaimed?: (nodeId: string) => void;
  readonly timer: NodeJS.Timeout;
  cancelled: boolean;
  claimedAt?: number;
  /** Which node took it, so concurrency is counted per node rather than in total. */
  claimedBy?: string;
  /** Until when the claiming node holds it without being heard from again. */
  leaseUntil?: number;
  leaseTimer?: NodeJS.Timeout;
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
  readonly features?: readonly string[];
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
  /** Whether a live node declared this feature — and, given one, takes this provider. */
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
    /**
     * How long a node may hold a task it claimed without being heard from about it.
     *
     * A claim is answered over a long-poll, and a connection that dies at that moment
     * takes the task with it: the node never sees it, and the task used to sit claimed
     * until the fifteen-minute timeout, holding that node's only slot. Silence for this
     * long puts it back in the queue for any live node.
     *
     * 45 seconds. A working node reports on a task within a second of taking it and every
     * second after (its heartbeat), and each of those reports is given 30 seconds before
     * the node abandons the request — so one heartbeat lost to a slow or dropped request,
     * and the next one landing, both fit inside it. It is also comfortably under the 90
     * seconds after which a node stops being offered work at all, so a task stuck on a dead
     * node moves before that node is written off, rather than minutes later.
     */
    private readonly leaseMs = 45_000,
  ) {}

  /* ----------------------------------------------------------- node side */

  /** Records that a node is alive and asking for work. */
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

  /**
   * Whether this node may take this task.
   *
   * Four questions — the fourth, whether it understands everything the task asks for, came
   * later: an outdated phone node took trimmed and subtitled jobs and ignored both. Three
   * questions and the first two used to be asked in only one of the two places a
   * task can reach a node. A task queued while a node was already waiting went out with
   * neither check, so a node told to do YouTube alone could be handed Instagram.
   */
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

  /** Whether the caller has given up, so a node can stop working on it. */
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

  /** Records one uploaded file. Order is preserved, which a carousel depends on. */
  acceptFile(taskId: string, file: RemoteFile): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;
    this.renew(pending);
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

  /** Queues a download and waits for the files the node uploads for it. */
  dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<readonly RemoteFile[]> {
    // Nodes are connected, but none can do what this job asks: say so now, rather than
    // after the task timeout spent waiting for a node that is not coming.
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
          // By the task's current id: a lapsed lease will have given it a new one.
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
          // Remove it if no node has taken it yet; a node that has will see the flag.
          const queued = this.queue.indexOf(pending.task);
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
      pending.onClaimed?.(nodeId);
      this.renew(pending);
    }
  }

  /** The claiming node has been heard from about this task; it keeps it a while longer. */
  private renew(pending: Pending): void {
    if (pending.claimedBy === undefined) return;
    pending.leaseUntil = Date.now() + this.leaseMs;
    // One timer per task, re-armed for what is left when it fires early, rather than
    // cleared and set again on every heartbeat.
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

  /**
   * Takes a task back from a node that went quiet and offers it again.
   *
   * It goes back under a new id. Everything a node sends is addressed by task id, so the
   * old id simply stops existing: a late progress report is told the task is cancelled,
   * which stops that node working on it; a late upload is refused and deleted; a late
   * result or failure is not accepted. None of it can reach the visitor's job, which only
   * the node holding the new id can now settle. Files the silent node did upload are
   * dropped from the task — the next node produces a whole set — and their upload
   * directory is left to the workspace reaper.
   */
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

    // To the front: it has waited longer than anything queued behind it.
    this.queue.unshift(pending.task);
    this.wakeOne();
  }
}

/** Task ids double as the node's capability for a task, so they are random and unguessable. */
function newTaskId(): string {
  return randomUUID().replace(/-/g, '');
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

/**
 * A node holding an account for a provider, as a backend the router can ask.
 *
 * For a post the server cannot read without one — an Instagram photo post — and no node of
 * this deployment holds it either unless its operator put a session in that node's own
 * environment. The task names the feature; whichever live node declared it takes the task,
 * so a laptop that is off leaves the work to the phone, and the other way round.
 */
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
    // A node that fails without a final answer — out of date, or its session expired — is
    // not asked again for this post; the next node holding the session is, while there is
    // one. A phone on old code must not stand between a post and a laptop that can read it.
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
