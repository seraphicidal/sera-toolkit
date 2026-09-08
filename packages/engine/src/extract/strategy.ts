import { SeraError, seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ProviderContext, ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isDefinitive, type FailureClass } from './failure.js';

/**
 * One way of asking a platform for its media.
 *
 * A provider is rarely a single extractor. YouTube is yt-dlp, and yt-dlp with a
 * different player client, and a thumbnail that is published whatever else fails.
 * Instagram is yt-dlp, an operator's session, and the oEmbed endpoint Instagram
 * publishes for anyone embedding a post. X is the syndication endpoint the embed widget
 * uses, and yt-dlp behind it.
 *
 * Before this existed, each provider's `resolve` was one of those and the rest were
 * unreachable — so a platform changing one endpoint took the whole provider down, and
 * the visitor was told the link was unsupported when three other published routes to
 * the same public post were sitting there untried.
 */
export interface ExtractionStrategy {
  /** Stable, and it goes in the log and the failure detail. */
  readonly id: string;
  /** What it does, in the words a report should use. */
  readonly label: string;
  /**
   * Whether it can run at all right now. A strategy that needs a credential this
   * installation does not have says so here instead of failing at the end of a request.
   */
  readonly available?: (context: ProviderContext) => boolean;
  /**
   * True when this produces less than the provider's main route does.
   *
   * The published cover image of an Instagram post is real, public, and not the post.
   * A rung like that has to be last, and it has to be last *globally* — a degraded
   * answer found on this machine would otherwise pre-empt an extraction node that could
   * have returned the whole thing, which is the opposite of a fallback. The router asks
   * for these only when every backend it knows about has already refused.
   */
  readonly degraded?: boolean;
  /**
   * The failures this rung is an answer to. Omitted means "anything not definitive".
   *
   * This is the difference between a ladder and a retry loop. Asking YouTube as a
   * different player client answers "that client's list did not contain the format" and
   * answers nothing at all about a bot challenge — on a datacentre where every client is
   * challenged, running it anyway would spend three round trips to learn what the first
   * one said, and delay the extraction node that actually fixes it.
   */
  readonly answers?: readonly FailureClass[];
  run: (url: URL, context: ProviderContext) => Promise<ResolvedMedia>;
}

/** What one rung of the ladder did, for the log and for the error that comes back. */
export interface StrategyAttempt {
  readonly strategy: string;
  readonly failure: FailureClass;
  readonly detail?: string;
  readonly durationMs: number;
}

export interface StrategyOutcome {
  readonly media: ResolvedMedia;
  /** Which one answered. */
  readonly strategy: string;
  /** Everything tried before it, in order. Empty when the first one worked. */
  readonly attempts: readonly StrategyAttempt[];
}

/**
 * Walks the ladder, and knows when to stop walking.
 *
 * Two rules, and the second is the one that keeps this honest:
 *
 * - Each strategy is attempted **once**. This is not a retry loop. Asking a platform
 *   the same question five times is how a service spends fifteen minutes arriving at
 *   the answer it had in the first second.
 * - A definitive failure ends it immediately. Private, deleted, geo-fenced and
 *   cancelled are the same from every route, so trying four more spends time to reach
 *   the same sentence — and replaces a precise answer with a vague one, which is worse
 *   than slow.
 *
 * What comes back on total failure is the **first** error, because it describes the path
 * the provider considers its main one; the rest of the ladder is recorded in its detail
 * so a report can show what was tried without the visitor reading it.
 */
export async function runStrategies(
  strategies: readonly ExtractionStrategy[],
  url: URL,
  context: ProviderContext,
  options: {
    readonly provider: string;
    readonly logger?: Logger;
    /** Let the lesser representations run. Only the router's last resort says yes. */
    readonly includeDegraded?: boolean;
  } = { provider: 'unknown' },
): Promise<StrategyOutcome> {
  const logger = options.logger ?? context.logger;
  const usable = strategies.filter(
    (strategy) =>
      strategy.available?.(context) !== false &&
      (options.includeDegraded === true || strategy.degraded !== true),
  );

  if (!usable.length) {
    throw seraError('UNSUPPORTED_SOURCE', {
      detail: `${options.provider}: no extraction strategy is available`,
    });
  }

  const attempts: StrategyAttempt[] = [];
  let firstError: unknown;
  let previous: FailureClass | undefined;

  for (const [index, strategy] of usable.entries()) {
    if (previous && strategy.answers && !strategy.answers.includes(previous)) {
      logger.info(
        { provider: options.provider, strategy: strategy.id, failureClass: previous },
        'skipping a strategy that does not answer this failure',
      );
      continue;
    }
    const started = Date.now();
    try {
      const media = await strategy.run(url, context);
      if (index > 0) {
        logger.info(
          {
            provider: options.provider,
            strategy: strategy.id,
            attempt: index + 1,
            tried: attempts.map((entry) => `${entry.strategy}:${entry.failure}`),
            items: media.items.length,
            durationMs: Date.now() - started,
          },
          'extraction succeeded on a later strategy',
        );
      }
      return { media, strategy: strategy.id, attempts };
    } catch (error) {
      const failure = classifyFailure(error);
      const detail = SeraError.from(error).detail;
      attempts.push({
        strategy: strategy.id,
        failure,
        durationMs: Date.now() - started,
        ...(detail ? { detail } : {}),
      });
      if (index === 0) firstError = error;
      previous = failure;

      const next = usable
        .slice(index + 1)
        .find((candidate) => !candidate.answers || candidate.answers.includes(failure));
      if (isDefinitive(failure) || !next) {
        logger.info(
          {
            provider: options.provider,
            strategy: strategy.id,
            attempt: index + 1,
            failureClass: failure,
            definitive: isDefinitive(failure),
            remaining: usable.length - index - 1,
            noneAnswers: !isDefinitive(failure),
          },
          'extraction stopped',
        );
        // A definitive failure found on a later rung is the truest thing anyone learned,
        // so it replaces the first one. Otherwise the first stands: it describes the
        // route this provider considers its own.
        throw withLadder(isDefinitive(failure) ? error : (firstError ?? error), attempts);
      }

      logger.info(
        {
          provider: options.provider,
          strategy: strategy.id,
          attempt: index + 1,
          failureClass: failure,
          escalatingTo: next.id,
        },
        'extraction failed, trying another strategy',
      );
    }
  }

  /* istanbul ignore next -- the loop above always returns or throws. */
  throw SeraError.from(firstError ?? new Error('no extraction strategy ran'));
}

/**
 * Records the ladder on the error, without changing what the visitor is told.
 *
 * The message and the code are the provider's; this only appends to `detail`, which is
 * the operator-facing half and never reaches the browser on its own.
 */
function withLadder(error: unknown, attempts: readonly StrategyAttempt[]): SeraError {
  const sera = SeraError.from(error);
  if (attempts.length < 2) return sera;
  const ladder = attempts.map((entry) => `${entry.strategy}=${entry.failure}`).join(' → ');
  return new SeraError(sera.code, sera.message, {
    ...(sera.hint ? { hint: sera.hint } : {}),
    retryable: sera.retryable,
    httpStatus: sera.httpStatus,
    detail: sera.detail ? `${sera.detail} [tried ${ladder}]` : `tried ${ladder}`,
    cause: sera.cause,
  });
}
