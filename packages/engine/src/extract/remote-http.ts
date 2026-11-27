import { MESSAGES, seraError, type SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { readBoundedJson } from '../security/http.js';
import {
  isWildcardProviders,
  nodeSupportsProvider,
  type NodeFeature,
  type NodeStatus,
  type RemoteExtraction,
  type RemoteFile,
  type RemoteProgress,
  type RemoteTask,
} from './remote.js';
import type { NetworkClass } from './router.js';

const MAX_REMOTE_JSON_BYTES = 16 * 1024 * 1024;
const VALID_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class RemoteOverHttp implements RemoteExtraction {
  private nodes: { readonly at: number; readonly value: NodeStatus[] } | undefined;
  private readonly initialRefresh: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;
  private consecutiveFailures = 0;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
    private readonly statusTtlMs = 5_000,
    private readonly pollIntervalMs = 1_000,
  ) {
    this.initialRefresh = this.refresh();
    this.timer = setInterval(() => void this.refresh(), Math.max(1_000, statusTtlMs));
    this.timer.unref();
  }

  async waitForInitialRefresh(timeoutMs = 5_000): Promise<void> {
    if (this.nodes !== undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.initialRefresh,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    clearInterval(this.timer);
  }

  status(): NodeStatus[] {
    const cached = this.nodes;
    if (!cached || Date.now() - cached.at > this.statusTtlMs * 3) void this.refresh();
    return cached?.value ?? [];
  }

  private refreshing: Promise<void> | undefined;

  private readJson<T>(response: Response, detail: string): Promise<T> {
    return readBoundedJson<T>(response, MAX_REMOTE_JSON_BYTES, detail, 'PROVIDER_UNAVAILABLE');
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const response = await this.call('GET', '/internal/extraction/nodes');
        const body = await this.readJson<{ nodes?: NodeStatus[] }>(
          response,
          'invalid node list response',
        );
        this.consecutiveFailures = 0;
        this.nodes = { at: Date.now(), value: body.nodes ?? [] };
      } catch (error) {
        this.consecutiveFailures += 1;
        this.logger.warn({ err: error }, 'could not read the extraction node list');
        if (!this.nodes || this.nodes.value.length === 0 || this.consecutiveFailures >= 3) {
          this.nodes = { at: Date.now(), value: [] };
        } else {
          this.nodes = { at: Date.now(), value: this.nodes.value };
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private live(networkClass?: NetworkClass): NodeStatus[] {
    return this.status().filter(
      (node) => node.healthy && (networkClass === undefined || node.networkClass === networkClass),
    );
  }

  availableProviders(networkClass?: NetworkClass): string[] {
    const live = this.live(networkClass);
    if (!live.length) return [];
    const providers = new Set<string>();
    for (const node of live) {
      if (isWildcardProviders(node.providers)) return ['*'];
      for (const provider of node.providers) providers.add(provider);
    }
    return [...providers];
  }

  hasHealthyNode(networkClass?: NetworkClass): boolean {
    return this.live(networkClass).length > 0;
  }

  hasFeature(feature: NodeFeature, providerId?: string, except: readonly string[] = []): boolean {
    return this.status().some(
      (node) =>
        node.healthy &&
        !except.includes(node.id) &&
        (node.features ?? []).includes(feature) &&
        (providerId === undefined || nodeSupportsProvider(node.providers, providerId)),
    );
  }

  networkClasses(): NetworkClass[] {
    return [...new Set(this.live().map((node) => node.networkClass))];
  }

  async dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<ResolvedMedia> {
    const outcome = await this.run(task, options);
    if (!outcome.media) {
      throw seraError('PROVIDER_UNAVAILABLE', { detail: 'remote: node returned no media' });
    }
    return outcome.media;
  }

  async dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<readonly RemoteFile[]> {
    const outcome = await this.run({ ...task, kind: 'job' }, options);
    if (!outcome.files?.length) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'remote: node produced no files' });
    }
    return outcome.files;
  }

  private async run(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: {
      onProgress?: (progress: RemoteProgress) => void;
      onClaimed?: (nodeId: string) => void;
      onTaskId?: (taskId: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }> {
    if (this.nodes === undefined) {
      await this.waitForInitialRefresh();
      if (options.signal?.aborted) throw seraError('CANCELLED');
    }
    const started = await this.call('POST', '/internal/extraction/dispatch', task, options.signal);
    const { taskId } = await this.readJson<{ taskId?: string }>(
      started,
      'invalid extraction dispatch response',
    );
    if (!taskId || !VALID_TASK_ID.test(taskId)) {
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: 'invalid taskId from extraction dispatch',
      });
    }
    options.onTaskId?.(taskId);

    let seenStep: string | undefined;
    let seenPercent: number | undefined;
    let seenClaimedBy: string | undefined;
    let settledRemotely = false;

    try {
      for (;;) {
        if (options.signal?.aborted) throw seraError('CANCELLED');

        const query = new URLSearchParams({ wait: '20' });
        if (seenStep !== undefined) query.set('seenStep', seenStep);
        if (seenPercent !== undefined) query.set('seenPercent', String(seenPercent));
        query.set('seenClaimedBy', seenClaimedBy ?? '');

        const reqStart = Date.now();
        const response = await this.call(
          'GET',
          `/internal/extraction/dispatch/${taskId}?${query.toString()}`,
          undefined,
          options.signal,
        );
        const reqDuration = Date.now() - reqStart;

        const state = await this.readJson<{
          state: 'pending' | 'done' | 'failed';
          claimedBy?: string;
          progress?: RemoteProgress;
          media?: ResolvedMedia;
          files?: readonly RemoteFile[];
          error?: { code: string; message?: string; detail?: string };
        }>(response, 'invalid extraction status response');

        if (state.claimedBy) {
          seenClaimedBy = state.claimedBy;
          options.onClaimed?.(state.claimedBy);
        }
        if (state.progress) {
          options.onProgress?.(state.progress);
          seenStep = state.progress.step;
          seenPercent = state.progress.percent;
        }
        if (state.state === 'done') {
          settledRemotely = true;
          return { ...state };
        }
        if (state.state === 'failed') {
          settledRemotely = true;
          const failure = state.error;
          const code =
            typeof failure?.code === 'string' && Object.hasOwn(MESSAGES, failure.code)
              ? (failure.code as SeraError['code'])
              : 'PROVIDER_UNAVAILABLE';
          throw seraError(code, {
            ...(failure?.message ? { message: failure.message } : {}),
            ...(failure?.detail ? { detail: failure.detail } : {}),
          });
        }

        if (reqDuration < 200) {
          await new Promise((done) => setTimeout(done, this.pollIntervalMs));
        }
      }
    } catch (error) {
      if (!settledRemotely) {
        const res = await this.call('DELETE', `/internal/extraction/dispatch/${taskId}`).catch(
          () => undefined,
        );
        await res?.body?.cancel().catch(() => undefined);
      }
      throw error;
    }
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combinedSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw seraError('CANCELLED', { cause });
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError' || timeoutSignal.aborted)
      ) {
        throw seraError('TIMEOUT', { detail: `remote: ${method} ${path} timed out`, cause });
      }
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `remote: ${method} ${path} transport error`,
        cause,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `remote: ${method} ${path} answered ${String(response.status)}`,
      });
    }
    return response;
  }
}
