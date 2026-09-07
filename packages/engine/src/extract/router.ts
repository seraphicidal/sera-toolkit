import type { ProviderCapabilities } from '@sera/contracts/types';
import { SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isEgressProblem, type FailureClass } from './failure.js';

/**
 * The kind of connection an extraction runs on.
 *
 * This is the only property of a backend the routing decisions actually turn on. `local`
 * versus `remote` says who owns the machine; this says whether the platform on the other
 * end is likely to answer it, which is the question.
 *
 * `unknown` is the honest default and means "do not reorder anything on my account" — an
 * operator running SERA on a home connection has a primary backend that is not a
 * datacentre, and a matrix measured on Oracle must not quietly demote it.
 */
export type NetworkClass = 'datacenter' | 'residential' | 'unknown';

/**
 * Where an extraction actually runs.
 *
 * SERA has one network by default and that network is a datacentre, which several
 * platforms refuse on sight. Measured on this deployment: YouTube answers the *player*
 * request with a bot challenge from Oracle and resolves normally from a residential
 * connection, and its signed media URLs are bound to the address that asked for them —
 * the same URL returns 206 at home and 403 on the server. So a second network cannot be
 * bolted on at the download step alone; a backend either does the whole job or none of it.
 */
export interface ExtractionBackend {
  /** Stable name, used in diagnostics and in the health endpoint. */
  readonly id: string;
  /** `local` is this worker. `remote` is an authorized node on another network. */
  readonly kind: 'local' | 'remote';
  readonly networkClass: NetworkClass;
  /** Providers this backend is willing to run. Empty means all of them. */
  readonly providers: readonly string[];

  /** Whether it is worth sending work to right now. */
  isHealthy(): boolean;

  resolve(url: URL, providerId: string, signal?: AbortSignal): Promise<ResolvedMedia>;
}

export interface ExtractionOutcome {
  readonly media: ResolvedMedia;
  readonly backend: string;
  readonly fallbackUsed: boolean;
  /** Why the first backend was abandoned, when one was. */
  readonly firstFailure?: FailureClass;
}

export interface RouterDependencies {
  readonly primary: ExtractionBackend;
  readonly logger: Logger;
  /** Consulted at call time, so a node that connects later is picked up without a restart. */
  readonly fallbacks: () => readonly ExtractionBackend[];
  /**
   * What the provider says it can do and where. Undefined for a provider the registry
   * does not know, which is treated as the conservative answer: local only.
   */
  readonly capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
}

/**
 * Chooses backends, in order, and knows when to stop choosing.
 *
 * Two things decide, and both have to agree. The failure class says whether the attempt
 * was refused for a reason an address could change; the provider's capability matrix says
 * whether a different address is the sort of thing that helps *this* platform. A bot
 * challenge on YouTube earns another network. The same class from the generic provider
 * does not, because its URL is whatever the visitor typed and a home connection is not
 * there to fetch arbitrary addresses.
 *
 * The rule that matters is still the negative one. A private video, a deleted post and an
 * unsupported link are identical from every connection; sending those to a scarce node
 * would spend someone's bandwidth to arrive at the same answer more slowly.
 */
export class ExtractionRouter {
  constructor(private readonly deps: RouterDependencies) {}

  /** Backends that could take work right now, for the health endpoint. */
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

  /**
   * The backends to try, in the order to try them.
   *
   * Reordering happens for one measured reason: a provider that declares no datacentre
   * extraction, on a deployment that has declared itself a datacentre, with a node
   * already connected. YouTube from Oracle is refused on every player client yt-dlp
   * offers, so paying for that refusal before asking the node is a delay with a known
   * outcome. Every other case keeps the primary first — including when the operator has
   * not said what their network is, because a guess must never cost someone a download.
   */
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

  /**
   * Whether the next backend in the chain deserves the attempt.
   *
   * Two reasons, and no others. An address-shaped refusal is worth retrying somewhere
   * with a different address. And a remote node that answered with a network error may
   * simply have gone away mid-request, which is the deployment's problem rather than the
   * visitor's — one attempt closer to home is cheap and is the difference between a
   * download and an error nobody could have acted on.
   */
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
            fallbackUsed: true,
            ...(firstFailure ? { firstFailure } : {}),
          };
        }
        return { media, backend: backend.id, fallbackUsed: false };
      } catch (error) {
        const failure = classifyFailure(error);
        if (index === 0) {
          firstError = error;
          firstFailure = failure;
        }

        const next = chain[index + 1];
        if (!next || !this.shouldEscalate(failure, backend, next)) {
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
          // The first answer is the one to give: it describes the path the deployment
          // is configured to take, not the last thing that happened to be tried.
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

    // Unreachable: the chain always contains the primary, and every path above returns
    // or throws. Kept explicit so a future edit to `plan` cannot silently return nothing.
    throw SeraError.from(firstError ?? new Error('no extraction backend was available'));
  }
}
