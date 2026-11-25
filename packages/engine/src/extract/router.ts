import type { NodeNetworkClass, ProviderCapabilities } from '@sera/contracts/types';
import { SeraError, seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isDefinitive, isEgressProblem, type FailureClass } from './failure.js';

export type NetworkClass = NodeNetworkClass;

const NETWORK_RANK: Record<NetworkClass, number> = {
  residential: 0,
  unknown: 1,
  datacenter: 2,
};

export interface ExtractionBackend {
  readonly id: string;
  readonly kind: 'local' | 'remote';
  readonly networkClass: NetworkClass;
  readonly providers: readonly string[];

  isHealthy(): boolean;

  resolve(
    url: URL,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<
    | ResolvedMedia
    | {
        readonly media: ResolvedMedia;
        readonly rawInfoJson?: string;
        readonly networkClass?: NetworkClass;
      }
  >;
}

export interface ExtractionOutcome {
  readonly media: ResolvedMedia;
  readonly backend: string;
  readonly networkClass: NetworkClass;
  readonly remote: boolean;
  readonly fallbackUsed: boolean;
  readonly attempts: number;
  readonly firstFailure?: FailureClass;
  readonly rawInfoJson?: string;
  readonly resolvedAt?: number;
}

export interface RouterDependencies {
  readonly primary: ExtractionBackend;
  readonly logger: Logger;
  readonly fallbacks: () => readonly ExtractionBackend[];
  readonly capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
  readonly preferRemote?: boolean;
  readonly authenticated?: (providerId: string) => ExtractionBackend | undefined;
  readonly lastResort?: (
    url: URL,
    providerId: string,
    signal?: AbortSignal,
  ) => Promise<ResolvedMedia | { readonly media: ResolvedMedia; readonly rawInfoJson?: string }>;
}

export class ExtractionRouter {
  constructor(private readonly deps: RouterDependencies) {}

  describe(): {
    id: string;
    kind: string;
    networkClass: NetworkClass;
    healthy: boolean;
    providers: readonly string[];
  }[] {
    return [this.deps.primary, ...this.deps.fallbacks()].map((backend) => ({
      id: backend.id,
      kind: backend.kind,
      networkClass: backend.networkClass,
      healthy: backend.isHealthy(),
      providers: backend.providers,
    }));
  }

  private plan(providerId: string): ExtractionBackend[] {
    const { primary } = this.deps;
    const capabilities = this.deps.capabilitiesOf(providerId);

    if (!capabilities?.residentialFallback) return [primary];

    const remote = this.deps
      .fallbacks()
      .filter(
        (backend) =>
          backend.isHealthy() &&
          (backend.providers.length === 0 ||
            backend.providers.includes('*') ||
            backend.providers.includes('all') ||
            backend.providers.includes(providerId)),
      )
      .sort((a, b) => NETWORK_RANK[a.networkClass] - NETWORK_RANK[b.networkClass]);

    if (!remote.length) return [primary];

    const preferRemote =
      this.deps.preferRemote === false
        ? !capabilities.cloudExtraction &&
          primary.networkClass === 'datacenter' &&
          remote.some((backend) => backend.networkClass !== 'datacenter')
        : true;

    return preferRemote ? [...remote, primary] : [primary, ...remote];
  }

  private shouldEscalate(
    failure: FailureClass,
    from: ExtractionBackend,
    to: ExtractionBackend,
    errorCode?: string,
  ): boolean {
    if (isEgressProblem(failure)) return to.networkClass !== from.networkClass;
    if (failure === 'STREAM_403') {
      return to.networkClass === 'residential' && from.networkClass !== 'residential';
    }
    if (
      from.kind === 'local' &&
      from.networkClass !== 'residential' &&
      to.networkClass === 'residential' &&
      (failure === 'RATE_LIMITED' ||
        (failure === 'LOGIN_REQUIRED' && errorCode !== 'PROVIDER_AUTH_REQUIRED') ||
        failure === 'EXTRACTOR_BUG')
    ) {
      return true;
    }
    if (from.kind === 'remote') {
      return (
        failure === 'NETWORK_ERROR' ||
        failure === 'UPSTREAM_TIMEOUT' ||
        errorCode === 'PROVIDER_UNAVAILABLE'
      );
    }
    return false;
  }

  private async lastResort(
    url: URL,
    providerId: string,
    failure: FailureClass,
    signal?: AbortSignal,
  ): Promise<{ media: ResolvedMedia; rawInfoJson?: string } | undefined> {
    if (!this.deps.lastResort || isDefinitive(failure)) return undefined;
    try {
      const res = await this.deps.lastResort(url, providerId, signal);
      if (!res) return undefined;
      return 'media' in res ? { media: res.media, rawInfoJson: res.rawInfoJson } : { media: res };
    } catch (error) {
      if (signal?.aborted || SeraError.from(error).code === 'CANCELLED') {
        throw SeraError.from(error);
      }
      return undefined;
    }
  }

  private async withAccount(
    url: URL,
    providerId: string,
    failure: FailureClass,
    signal?: AbortSignal,
  ): Promise<
    | {
        media: ResolvedMedia;
        backend: string;
        networkClass: NetworkClass;
        rawInfoJson?: string;
      }
    | undefined
  > {
    if (isDefinitive(failure)) return undefined;
    const backend = this.deps.authenticated?.(providerId);
    if (!backend?.isHealthy()) return undefined;
    try {
      const outcome = await backend.resolve(url, providerId, signal);
      const media = 'media' in outcome ? outcome.media : outcome;
      const rawInfoJson = 'rawInfoJson' in outcome ? outcome.rawInfoJson : undefined;
      const networkClass =
        'networkClass' in outcome && outcome.networkClass
          ? outcome.networkClass
          : backend.networkClass;
      this.deps.logger.info(
        { provider: providerId, backend: backend.id, items: media.items.length },
        'extraction succeeded on a node holding an account',
      );
      return {
        media,
        backend: backend.id,
        networkClass,
        ...(rawInfoJson ? { rawInfoJson } : {}),
      };
    } catch (error) {
      rethrowIfCancelled(error, signal);
      const failed = classifyFailure(error);
      this.deps.logger.warn(
        { provider: providerId, backend: backend.id, failureClass: failed },
        'the node holding an account could not read it either',
      );
      if (isDefinitive(failed)) throw SeraError.from(error);
      return undefined;
    }
  }

  async resolve(url: URL, providerId: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
    const { logger } = this.deps;
    const chain = this.plan(providerId);

    let firstError: unknown;
    let firstFailure: FailureClass | undefined;

    for (const [index, backend] of chain.entries()) {
      if (signal?.aborted) throw seraError('CANCELLED');
      try {
        const outcome = await backend.resolve(url, providerId, signal);
        const media = 'media' in outcome ? outcome.media : outcome;
        const rawInfoJson = 'rawInfoJson' in outcome ? outcome.rawInfoJson : undefined;
        if (index > 0) {
          logger.info(
            {
              provider: providerId,
              backend: backend.id,
              networkClass: backend.networkClass,
              firstFailure,
              fallbackUsed: true,
              items: media.items.length,
            },
            'extraction succeeded on a fallback backend',
          );
          return {
            media,
            backend: backend.id,
            networkClass: backend.networkClass,
            remote: backend.kind === 'remote',
            fallbackUsed: true,
            attempts: index + 1,
            ...(firstFailure ? { firstFailure } : {}),
            ...(rawInfoJson ? { rawInfoJson } : {}),
            resolvedAt: Date.now(),
          };
        }
        return {
          media,
          backend: backend.id,
          networkClass: backend.networkClass,
          remote: backend.kind === 'remote',
          fallbackUsed: false,
          attempts: 1,
          ...(rawInfoJson ? { rawInfoJson } : {}),
          resolvedAt: Date.now(),
        };
      } catch (error) {
        rethrowIfCancelled(error, signal);
        const failure = classifyFailure(error);
        const errorCode = SeraError.from(error).code;
        if (index === 0) {
          firstError = error;
          firstFailure = failure;
        }

        const next = chain[index + 1];
        if (!next || !this.shouldEscalate(failure, backend, next, errorCode)) {
          const signedIn = await this.withAccount(url, providerId, failure, signal);
          if (signedIn) {
            return {
              media: signedIn.media,
              backend: signedIn.backend,
              networkClass: signedIn.networkClass,
              remote: true,
              fallbackUsed: true,
              attempts: index + 2,
              ...(firstFailure ? { firstFailure } : {}),
              ...(signedIn.rawInfoJson ? { rawInfoJson: signedIn.rawInfoJson } : {}),
              resolvedAt: Date.now(),
            };
          }
          const salvaged = await this.lastResort(url, providerId, failure, signal);
          if (salvaged) {
            logger.info(
              {
                provider: providerId,
                backend: 'degraded',
                firstFailure,
                fallbackUsed: true,
                items: salvaged.media.items.length,
              },
              'every backend refused; returning a lesser public representation',
            );
            return {
              media: salvaged.media,
              backend: 'degraded',
              networkClass: backend.networkClass,
              remote: false,
              fallbackUsed: true,
              attempts: index + 2,
              ...(firstFailure ? { firstFailure } : {}),
              ...(salvaged.rawInfoJson ? { rawInfoJson: salvaged.rawInfoJson } : {}),
              resolvedAt: Date.now(),
            };
          }

          logger.info(
            {
              provider: providerId,
              backend: backend.id,
              networkClass: backend.networkClass,
              failureClass: failure,
              fallbackUsed: index > 0,
              fallbackAvailable: chain.length > 1,
            },
            'extraction failed with no useful alternative',
          );
          throw SeraError.from(isDefinitive(failure) ? error : (firstError ?? error));
        }

        logger.warn(
          {
            provider: providerId,
            backend: backend.id,
            networkClass: backend.networkClass,
            failureClass: failure,
            escalatingTo: next.id,
          },
          'extraction failed, escalating to another network',
        );
      }
    }

    throw SeraError.from(firstError ?? new Error('no extraction backend was available'));
  }
}

function rethrowIfCancelled(error: unknown, signal?: AbortSignal): void {
  const sera = SeraError.from(error);
  if (sera.code === 'CANCELLED') throw sera;
  if (signal?.aborted) throw seraError('CANCELLED', { cause: error });
}
