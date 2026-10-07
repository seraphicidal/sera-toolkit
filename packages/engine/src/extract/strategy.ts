import { SeraError, seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { ProviderContext, ResolvedMedia } from '../providers/types.js';
import { classifyFailure, isDefinitive, type FailureClass } from './failure.js';

export interface ExtractionStrategy {
  readonly id: string;
  readonly label: string;
  readonly available?: (context: ProviderContext) => boolean;
  readonly degraded?: boolean;
  readonly answers?: readonly FailureClass[];
  run: (url: URL, context: ProviderContext) => Promise<ResolvedMedia>;
}

export interface StrategyAttempt {
  readonly strategy: string;
  readonly failure: FailureClass;
  readonly detail?: string;
  readonly durationMs: number;
}

export interface StrategyOutcome {
  readonly media: ResolvedMedia;
  readonly strategy: string;
  readonly attempts: readonly StrategyAttempt[];
}

export async function runStrategies(
  strategies: readonly ExtractionStrategy[],
  url: URL,
  context: ProviderContext,
  options: {
    readonly provider: string;
    readonly logger?: Logger;
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
