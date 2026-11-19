package dev.sera.toolkit.domain

import dev.sera.toolkit.model.TrimRange
import dev.sera.toolkit.model.TrimRequest
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

sealed interface TrimCheckResult {
    data class Ok(val range: TrimRange) : TrimCheckResult
    data class Error(val message: String) : TrimCheckResult
}

sealed interface TrimSummary {
    data object None : TrimSummary
    data class Invalid(val message: String) : TrimSummary
    data class Valid(
        val request: TrimRequest,
        val keptSeconds: Long? = null,
        val estimatedBytes: Long? = null,
    ) : TrimSummary
}

object TrimValidator {
    private val timecodePattern = Regex("^(?:(\\d{1,2}):)?([0-5]?\\d):([0-5]\\d)$")
    const val MIN_TRIM_SECONDS = 1L

    fun parseTimecode(text: String): Long? {
        val match = timecodePattern.matchEntire(text.trim()) ?: return null
        val hours = match.groupValues[1].takeIf { it.isNotEmpty() }?.toLongOrNull() ?: 0L
        val minutes = match.groupValues[2].toLongOrNull() ?: return null
        val seconds = match.groupValues[3].toLongOrNull() ?: return null
        return hours * 3600L + minutes * 60L + seconds
    }

    fun formatTimecode(totalSeconds: Double): String {
        val whole = max(0L, totalSeconds.roundToLong())
        val hours = whole / 3600L
        val minutes = (whole % 3600L) / 60L
        val seconds = (whole % 60L).toString().padStart(2, '0')
        return if (hours > 0L) {
            "$hours:${minutes.toString().padStart(2, '0')}:$seconds"
        } else {
            "$minutes:$seconds"
        }
    }

    fun checkTrim(trim: TrimRequest, durationSeconds: Double? = null): TrimCheckResult {
        val startRaw = trim.start?.trim().orEmpty()
        val endRaw = trim.end?.trim().orEmpty()
        val start = if (startRaw.isNotEmpty()) parseTimecode(startRaw) else 0L
        val end = if (endRaw.isNotEmpty()) parseTimecode(endRaw) else null

        if (start == null || (endRaw.isNotEmpty() && end == null)) {
            return TrimCheckResult.Error("Use m:ss or h:mm:ss for the trim times.")
        }
        if (startRaw.isEmpty() && endRaw.isEmpty()) {
            return TrimCheckResult.Error("Give a start or an end time to trim.")
        }

        val knownDuration = durationSeconds != null && durationSeconds > 0.0
        val knownWhole = if (knownDuration) floor(durationSeconds!!).toLong().coerceAtLeast(1L) else 0L
        if (knownDuration && start >= durationSeconds!!) {
            return TrimCheckResult.Error(
                "The start is past the end of the media (${formatTimecode(durationSeconds)}).",
            )
        }
        if (knownDuration && end != null && end.toDouble() > ceil(durationSeconds!!) + 1.0) {
            return TrimCheckResult.Error(
                "The end is past the end of the media (${formatTimecode(durationSeconds)}).",
            )
        }

        val clippedEnd = if (knownDuration && end != null) min(end, knownWhole) else end
        val effectiveEnd = clippedEnd ?: if (knownDuration) knownWhole else null

        if (effectiveEnd != null && effectiveEnd - start < MIN_TRIM_SECONDS) {
            return TrimCheckResult.Error("The start has to come before the end.")
        }
        if (start == 0L && (clippedEnd == null || (knownDuration && clippedEnd.toDouble() >= durationSeconds!!))) {
            return TrimCheckResult.Error("That keeps the whole thing; there is nothing to trim.")
        }

        val finalEnd =
            if (clippedEnd != null && !(knownDuration && clippedEnd.toDouble() >= durationSeconds!!)) {
                clippedEnd
            } else {
                null
            }
        return TrimCheckResult.Ok(TrimRange(start = start, end = finalEnd))
    }

    fun summarizeTrim(
        start: String,
        end: String,
        durationSeconds: Double?,
        totalBytes: Long?,
    ): TrimSummary {
        val cleanStart = start.trim()
        val cleanEnd = end.trim()
        if (cleanStart.isEmpty() && cleanEnd.isEmpty()) return TrimSummary.None

        val request = TrimRequest(
            start = cleanStart.takeIf { it.isNotEmpty() },
            end = cleanEnd.takeIf { it.isNotEmpty() },
        )
        return when (val checked = checkTrim(request, durationSeconds)) {
            is TrimCheckResult.Error -> TrimSummary.Invalid(checked.message)
            is TrimCheckResult.Ok -> {
                val stopSeconds = checked.range.end?.toDouble() ?: durationSeconds
                val kept = stopSeconds?.let { max(0L, (it - checked.range.start).roundToLong()) }
                val estimatedBytes =
                    if (kept != null && totalBytes != null && durationSeconds != null && durationSeconds > 0.0) {
                        (totalBytes.toDouble() * (kept.toDouble() / durationSeconds)).roundToLong()
                    } else {
                        null
                    }
                TrimSummary.Valid(
                    request = request,
                    keptSeconds = kept,
                    estimatedBytes = estimatedBytes,
                )
            }
        }
    }

    fun endPlaceholder(durationSeconds: Double?): String {
        return if (durationSeconds != null && durationSeconds > 0.0) {
            formatTimecode(durationSeconds)
        } else {
            "End"
        }
    }

    fun trimSuffix(range: TrimRange, durationSeconds: Double? = null): String {
        fun part(seconds: Long): String {
            val h = seconds / 3600L
            val m = (seconds % 3600L) / 60L
            val s = seconds % 60L
            return if (h > 0L) {
                "${h}h${m.toString().padStart(2, '0')}m${s.toString().padStart(2, '0')}s"
            } else {
                "${m}m${s.toString().padStart(2, '0')}s"
            }
        }
        val endSeconds = range.end ?: durationSeconds?.roundToLong()
        return "-trim-${part(range.start)}${if (endSeconds != null) "-${part(endSeconds)}" else "-end"}"
    }
}
