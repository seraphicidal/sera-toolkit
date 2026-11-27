package dev.sera.node.service

import dev.sera.node.data.ApiStatusException
import dev.sera.node.data.FatalAuthException
import dev.sera.node.data.NonRetryableUploadException
import dev.sera.node.data.TaskCancelledException
import dev.sera.node.data.UploadOffsetMismatchException
import dev.sera.node.model.NetworkState
import kotlinx.coroutines.CancellationException
import java.io.IOException
import kotlin.math.max
import kotlin.math.min

object NodeServicePolicy {
    const val IDLE_SLEEP_THRESHOLD_MS = 5_000L
    const val IDLE_SLEEP_MS = 2_000L
    const val BASE_ERROR_BACKOFF_MS = 5_000L
    const val MAX_ERROR_BACKOFF_MS = 60_000L
    const val AUTH_BACKOFF_MS = 30_000L
    const val MAX_AUTH_FAILURES = 3
    const val PROGRESS_HEARTBEAT_MS = 2_000L
    const val PROGRESS_THROTTLE_MS = 1_000L
    const val PROGRESS_PER_TASK_BUDGET_MS = 250L
    const val PROGRESS_429_BASE_BACKOFF_MS = 2_000L
    const val PROGRESS_429_MAX_BACKOFF_MS = 15_000L
    const val MAX_UPLOAD_RETRIES = 4

    fun effectiveProgressThrottleMs(activeTaskCount: Int): Long {
        val scaled = activeTaskCount.coerceAtLeast(1).toLong() * PROGRESS_PER_TASK_BUDGET_MS
        return max(PROGRESS_THROTTLE_MS, scaled)
    }

    fun computeProgressRateLimitBackoffMs(
        previousBackoffMs: Long,
        retryAfterSeconds: Long? = null,
    ): Long {
        if (retryAfterSeconds != null && retryAfterSeconds > 0L) {
            return (retryAfterSeconds * 1_000L).coerceIn(PROGRESS_429_BASE_BACKOFF_MS, PROGRESS_429_MAX_BACKOFF_MS)
        }
        val next = if (previousBackoffMs <= 0L) PROGRESS_429_BASE_BACKOFF_MS else previousBackoffMs * 2L
        return min(next, PROGRESS_429_MAX_BACKOFF_MS)
    }

    fun shouldStopOnStickyRestart(serviceEnabled: Boolean): Boolean = !serviceEnabled

    fun buildNodeFeatures(instagramSessionId: String?): List<String> {
        val features = mutableListOf("trim", "subtitles", "items")
        if (!instagramSessionId.isNullOrBlank()) {
            features += "instagram-session"
        }
        return features
    }

    fun shouldIdleSleepMs(elapsedMs: Long): Long {
        return if (elapsedMs < IDLE_SLEEP_THRESHOLD_MS) IDLE_SLEEP_MS else 0L
    }

    fun computeRetryBackoffMs(
        consecutiveErrors: Int,
        baseMs: Long = BASE_ERROR_BACKOFF_MS,
        maxMs: Long = MAX_ERROR_BACKOFF_MS,
    ): Long {
        if (consecutiveErrors <= 1) return baseMs
        val shift = min(consecutiveErrors - 1, 10)
        val multiplied = baseMs * (1L shl shift)
        return min(multiplied, maxMs)
    }

    fun isRetryableUploadFailure(error: Throwable): Boolean {
        return when (error) {
            is CancellationException -> false
            is TaskCancelledException -> false
            is FatalAuthException -> false
            is NonRetryableUploadException -> false
            is UploadOffsetMismatchException -> true
            is ApiStatusException -> error.statusCode >= 500 || error.statusCode == 408 || error.statusCode == 429
            is IOException -> true
            else -> false
        }
    }

    fun evaluateBlockingCondition(
        isConfigured: Boolean,
        isPaused: Boolean,
        networkState: NetworkState,
        allowWifi: Boolean,
        allowCellular: Boolean,
        onlyWhileCharging: Boolean,
        isCharging: Boolean,
    ): NodeServiceState? {
        if (!isConfigured) return NodeServiceState.UNCONFIGURED
        if (isPaused) return NodeServiceState.PAUSED
        if (onlyWhileCharging && !isCharging) return NodeServiceState.WAITING_CHARGING
        if (!networkState.isAllowed(allowWifi, allowCellular)) return NodeServiceState.WAITING_NETWORK
        return null
    }
}
