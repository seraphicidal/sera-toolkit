import { SeraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isEgressProblem, type FailureClass } from './failure.js';

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
}

/**
 * Chooses a backend, and knows when not to bother choosing another.
 *
 * The rule that matters is the negative one. A private video, a deleted post and an
 * unsupported link are identical from every address; sending those to a scarce
 * residential node would spend someone's home connection to arrive at the same answer
 * more slowly. Only the two network-shaped failures earn a second attempt.
 */
export class ExtractionRouter {
  constructor(private readonly deps: RouterDependencies) {}

  /** Backends that could take work right now, for the health endpoint. */
  describe(): { id: string; kind: string; healthy: boolean; providers: readonly string[] }[] {
    return [this.deps.primary, ...this.deps.fallbacks()].map((backend) => ({
      id: backend.id,
      kind: backend.kind,
      healthy: backend.isHealthy(),
      providers: backend.providers,
    }));
  }

  async resolve(url: URL, providerId: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
    const { primary, logger } = this.deps;

    try {
      const media = await primary.resolve(url, providerId, signal);
      return { media, backend: primary.id, fallbackUsed: false };
    } catch (error) {
      const failure = classifyFailure(error);
      const candidates = this.deps
        .fallbacks()
        .filter(
          (backend) =>
            backend.isHealthy() &&
            (backend.providers.length === 0 || backend.providers.includes(providerId)),
        );

      if (!isEgressProblem(failure) || !candidates.length) {
        logger.info(
          {
            provider: providerId,
            backend: primary.id,
            failureClass: failure,
            fallbackUsed: false,
            fallbackAvailable: candidates.length > 0,
          },
          'extraction failed with no useful alternative',
        );
        throw error;
      }

      for (const backend of candidates) {
        try {
          const media = await backend.resolve(url, providerId, signal);
          logger.info(
            {
              provider: providerId,
              backend: backend.id,
              firstFailure: failure,
              fallbackUsed: true,
              items: media.items.length,
            },
            'extraction succeeded on a fallback backend',
          );
          return { media, backend: backend.id, fallbackUsed: true, firstFailure: failure };
        } catch (fallbackError) {
          logger.warn(
            {
              provider: providerId,
              backend: backend.id,
              failureClass: classifyFailure(fallbackError),
              fallbackUsed: true,
            },
            'fallback backend also failed',
          );
        }
      }

      // Every backend refused. The first answer is the one to give: it describes the
      // path the deployment is actually configured to take.
      throw SeraError.from(error);
    }
  }
}
