package dev.sera.node.extractor

import dev.sera.node.model.ResolvedMedia
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

data class ExtractionStrategy(
    val id: String,
    val label: String,
    val available: () -> Boolean = { true },
    val degraded: Boolean = false,
    val answers: Set<FailureClass>? = null,
    val run: suspend () -> ResolvedMedia,
)

data class StrategyAttempt(
    val strategy: String,
    val failure: FailureClass,
    val detail: String? = null,
    val durationMs: Long,
)

data class StrategyOutcome(
    val media: ResolvedMedia,
    val strategy: String,
    val attempts: List<StrategyAttempt>,
)

suspend fun runStrategies(
    strategies: List<ExtractionStrategy>,
    provider: String,
    includeDegraded: Boolean = false,
    isCancelled: () -> Boolean = { false },
): StrategyOutcome {
    val usable = strategies.filter { strategy ->
        strategy.available() && (includeDegraded || !strategy.degraded)
    }

    if (usable.isEmpty()) {
        throw seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            detail = "$provider: no extraction strategy is available",
        )
    }

    val attempts = ArrayList<StrategyAttempt>()
    var firstError: Throwable? = null
    val seenFailures = HashSet<FailureClass>()

    for ((index, strategy) in usable.withIndex()) {
        currentCoroutineContext().ensureActive()
        if (isCancelled()) {
            throw withLadder(seraError(SeraErrorCode.CANCELLED), attempts)
        }
        if (seenFailures.isNotEmpty() && strategy.answers != null) {
            val answersAny = strategy.answers.any { it in seenFailures }
            if (!answersAny) continue
        }

        val started = System.currentTimeMillis()
        try {
            val media = strategy.run()
            return StrategyOutcome(media = media, strategy = strategy.id, attempts = attempts)
        } catch (error: Throwable) {
            val sera = SeraException.from(error)
            if (isCancelled() || sera.code == SeraErrorCode.CANCELLED) {
                throw withLadder(
                    if (sera.code == SeraErrorCode.CANCELLED) sera else seraError(SeraErrorCode.CANCELLED, cause = error),
                    attempts,
                )
            }
            val failure = classifyFailure(error)
            attempts.add(
                StrategyAttempt(
                    strategy = strategy.id,
                    failure = failure,
                    detail = sera.detail,
                    durationMs = System.currentTimeMillis() - started,
                ),
            )
            if (firstError == null) firstError = error
            seenFailures.add(failure)

            val hasNext = usable.drop(index + 1).any { candidate ->
                candidate.answers == null || candidate.answers.any { it in seenFailures }
            }
            if (isDefinitive(failure) || !hasNext) {
                val chosen = if (isDefinitive(failure)) error else (firstError ?: error)
                throw withLadder(chosen, attempts)
            }
        }
    }

    throw SeraException.from(firstError ?: IllegalStateException("no extraction strategy ran"))
}

private fun withLadder(error: Throwable, attempts: List<StrategyAttempt>): SeraException {
    val sera = SeraException.from(error)
    if (attempts.size < 2) return sera
    val ladder = attempts.joinToString(" -> ") { "${it.strategy}=${it.failure.name}" }
    val detail = if (!sera.detail.isNullOrEmpty()) {
        "${sera.detail} [tried $ladder]"
    } else {
        "tried $ladder"
    }
    return SeraException(
        code = sera.code,
        message = sera.message,
        hint = sera.hint,
        retryable = sera.retryable,
        detail = detail,
        cause = sera.cause,
    )
}
