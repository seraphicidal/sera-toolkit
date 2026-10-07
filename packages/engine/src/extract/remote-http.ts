import { SeraError, seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import type {
  NodeFeature,
  NodeStatus,
  RemoteExtraction,
  RemoteFile,
  RemoteProgress,
  RemoteTask,
} from './remote.js';
import type { NetworkClass } from './router.js';

export class RemoteOverHttp implements RemoteExtraction {
  private nodes: { readonly at: number; readonly value: NodeStatus[] } | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
    private readonly statusTtlMs = 5_000,
    private readonly pollIntervalMs = 1_000,
  ) {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), Math.max(1_000, statusTtlMs));
    timer.unref();
  }

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

  hasFeature(feature: NodeFeature, providerId?: string, except: readonly string[] = []): boolean {
    return this.status().some(
      (node) =>
        node.healthy &&
        !except.includes(node.id) &&
        (node.features ?? []).includes(feature) &&
        (providerId === undefined || !node.providers.length || node.providers.includes(providerId)),
    );
  }

  networkClasses(): NetworkClass[] {
    return [...new Set(this.live().map((node) => node.networkClass))];
  }

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
