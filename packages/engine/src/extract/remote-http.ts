import { SeraError, seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import type {
  NodeStatus,
  RemoteExtraction,
  RemoteFile,
  RemoteProgress,
  RemoteTask,
} from './remote.js';
import type { NetworkClass } from './router.js';

/**
 * The node registry, reached over HTTP because it lives in another process.
 *
 * A node dials one address and holds one connection open, so exactly one process can own
 * it — and on a deployment where the API and the worker are separate containers, that
 * process is the API. The worker is the one that needs the node most: it does the
 * downloads. Left as it was, the split produced a deployment where a YouTube link
 * resolved through the node and then failed at the download step with the datacentre
 * block, because the worker had no idea a node existed. Measured on the live
 * deployment: `fallbackAvailable: false` in the worker while the API logged the node
 * connecting.
 *
 * So the worker asks the API. Same token the node uses, over the compose network, and
 * the finished file needs no transfer at all — both containers mount the same data
 * volume, so the worker renames the file the node uploaded straight into the job.
 *
 * Polling rather than one long request: a job can take minutes, and a poll that returns
 * progress is also how the visitor's progress bar keeps moving.
 */
export class RemoteOverHttp implements RemoteExtraction {
  private nodes: { readonly at: number; readonly value: NodeStatus[] } | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
    /** How often the node list is re-read. Short: a node can connect at any moment. */
    private readonly statusTtlMs = 5_000,
    private readonly pollIntervalMs = 1_000,
  ) {
    // Primed immediately, and kept warm on a timer.
    //
    // The router asks whether a fallback exists from a synchronous path, so this cannot
    // go and look on demand — and a purely lazy cache answers the *first* question with
    // "no nodes" and only then starts looking. On a worker that is the first job after
    // it boots, and on a long-idle worker it is the first job after a node connects.
    // Both are exactly when the answer matters, so the value refreshes on its own
    // schedule rather than on being asked.
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), Math.max(1_000, statusTtlMs));
    // Never the reason the process stays alive.
    timer.unref();
  }

  /* --------------------------------------------------------------- status */

  /**
   * The node list as of the last refresh.
   *
   * Read synchronously by the router when it builds a chain, so it never blocks on a
   * network call. The timer above is what keeps it current; this only catches up if the
   * value has gone unusually stale, which would mean the timer is not running.
   */
  status(): NodeStatus[] {
    const cached = this.nodes;
    if (!cached || Date.now() - cached.at > this.statusTtlMs * 3) void this.refresh();
    return cached?.value ?? [];
  }

  private refreshing: Promise<void> | undefined;

  private async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const response = await this.call('GET', '/internal/extraction/nodes');
        const body = (await response.json()) as { nodes?: NodeStatus[] };
        this.nodes = { at: Date.now(), value: body.nodes ?? [] };
      } catch (error) {
        // A control plane that cannot be reached is reported as no nodes, which is the
        // conservative answer: work stays local rather than waiting on a machine that
        // may not be there.
        this.logger.warn({ err: error }, 'could not read the extraction node list');
        this.nodes = { at: Date.now(), value: [] };
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

  /* -------------------------------------------------------------- dispatch */

  async dispatch(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<ResolvedMedia> {
    const outcome = await this.run(task, options);
    if (!outcome.media) {
      throw seraError('PROVIDER_UNAVAILABLE', { detail: 'remote: node returned no media' });
    }
    return outcome.media;
  }

  async dispatchJob(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal } = {},
  ): Promise<readonly RemoteFile[]> {
    const outcome = await this.run({ ...task, kind: 'job' }, options);
    if (!outcome.files?.length) {
      throw seraError('MEDIA_UNAVAILABLE', { detail: 'remote: node produced no files' });
    }
    return outcome.files;
  }

  private async run(
    task: Omit<RemoteTask, 'id' | 'createdAt'>,
    options: { onProgress?: (progress: RemoteProgress) => void; signal?: AbortSignal },
  ): Promise<{ media?: ResolvedMedia; files?: readonly RemoteFile[] }> {
    const started = await this.call('POST', '/internal/extraction/dispatch', task);
    const { taskId } = (await started.json()) as { taskId: string };

    try {
      for (;;) {
        if (options.signal?.aborted) throw seraError('CANCELLED');

        const response = await this.call('GET', `/internal/extraction/dispatch/${taskId}`);
        const state = (await response.json()) as {
          state: 'pending' | 'done' | 'failed';
          progress?: RemoteProgress;
          media?: ResolvedMedia;
          files?: readonly RemoteFile[];
          error?: { code: string; message?: string; detail?: string };
        };

        if (state.progress) options.onProgress?.(state.progress);
        if (state.state === 'done') return { ...state };
        if (state.state === 'failed') {
          const failure = state.error;
          throw new SeraError(
            (failure?.code ?? 'PROVIDER_UNAVAILABLE') as SeraError['code'],
            failure?.message ?? 'The extraction node could not complete this.',
            failure?.detail ? { detail: failure.detail } : {},
          );
        }
        await new Promise((done) => setTimeout(done, this.pollIntervalMs));
      }
    } catch (error) {
      // Tell the control plane to stop, so a node is not left working for nobody.
      if (options.signal?.aborted || SeraError.from(error).code === 'CANCELLED') {
        await this.call('DELETE', `/internal/extraction/dispatch/${taskId}`).catch(() => undefined);
      }
      throw error;
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `remote: ${method} ${path} answered ${String(response.status)}`,
      });
    }
    return response;
  }
}
