import type { ProviderCapabilities } from '@sera/contracts/types';
import { SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isDefinitive, isEgressProblem, type FailureClass } from './failure.js';

export type NetworkClass = 'datacenter' | 'residential' | 'unknown';

export interface ExtractionBackend {
  readonly id: string;
  readonly kind: 'local' | 'remote';
  readonly networkClass: NetworkClass;
  readonly providers: readonly string[];

  isHealthy(): boolean;

  resolve(url: URL, providerId: string, signal?: AbortSignal): Promise<ResolvedMedia>;
}

export interface ExtractionOutcome {
  readonly media: ResolvedMedia;
  readonly backend: string;
  readonly networkClass: NetworkClass;
  readonly remote: boolean;
  readonly fallbackUsed: boolean;
  readonly attempts: number;
  readonly firstFailure?: FailureClass;
}

export interface RouterDependencies {
  readonly primary: ExtractionBackend;
  readonly logger: Logger;
  readonly fallbacks: () => readonly ExtractionBackend[];
  readonly capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
  readonly authenticated?: (providerId: string) => ExtractionBackend | undefined;
  readonly lastResort?: (
    url: URL,
    providerId: string,
    signal?: AbortSignal,
  ) => Promise<ResolvedMedia>;
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
          (backend.providers.length === 0 || backend.providers.includes(providerId)),
      );

    const preferRemote =
      !capabilities.cloudExtraction &&
      primary.networkClass === 'datacenter' &&
      remote.some((backend) => backend.networkClass !== 'datacenter');

    return preferRemote ? [...remote, primary] : [primary, ...remote];
  }

  private shouldEscalate(
    failure: FailureClass,
    from: ExtractionBackend,
    to: ExtractionBackend,
  ): boolean {
    if (isEgressProblem(failure)) return to.networkClass !== from.networkClass;
    if (from.kind === 'remote') {
      return failure === 'NETWORK_ERROR' || failure === 'UPSTREAM_TIMEOUT';
    }
    return false;
  }

  private async lastResort(
    url: URL,
    providerId: string,
    failure: FailureClass,
    signal?: AbortSignal,
  ): Promise<ResolvedMedia | undefined> {
    if (!this.deps.lastResort || isDefinitive(failure)) return undefined;
    return this.deps.lastResort(url, providerId, signal).catch(() => undefined);
  }

  private async withAccount(
    url: URL,
    providerId: string,
    failure: FailureClass,
    signal?: AbortSignal,
  ): Promise<{ media: ResolvedMedia; backend: string } | undefined> {
    if (isDefinitive(failure)) return undefined;
    const backend = this.deps.authenticated?.(providerId);
    if (!backend?.isHealthy()) return undefined;
    try {
      const media = await backend.resolve(url, providerId, signal);
      this.deps.logger.info(
        { provider: providerId, backend: backend.id, items: media.items.length },
        'extraction succeeded on a node holding an account',
      );
      return { media, backend: backend.id };
    } catch (error) {
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
      try {
        const media = await backend.resolve(url, providerId, signal);
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
          };
        }
        return {
          media,
          backend: backend.id,
          networkClass: backend.networkClass,
          remote: backend.kind === 'remote',
          fallbackUsed: false,
          attempts: 1,
        };
      } catch (error) {
        const failure = classifyFailure(error);
        if (index === 0) {
          firstError = error;
          firstFailure = failure;
        }

        const next = chain[index + 1];
        if (!next || !this.shouldEscalate(failure, backend, next)) {
          const signedIn = await this.withAccount(url, providerId, failure, signal);
          if (signedIn) {
            return {
              media: signedIn.media,
              backend: signedIn.backend,
              networkClass: 'residential',
              remote: true,
              fallbackUsed: true,
              attempts: index + 2,
              ...(firstFailure ? { firstFailure } : {}),
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
                items: salvaged.items.length,
              },
              'every backend refused; returning a lesser public representation',
            );
            return {
              media: salvaged,
              backend: 'degraded',
              networkClass: backend.networkClass,
              remote: false,
              fallbackUsed: true,
              attempts: index + 2,
              ...(firstFailure ? { firstFailure } : {}),
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
          throw SeraError.from(firstError ?? error);
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
