package dev.sera.toolkit.domain

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Serializable
data class HistoryEntry(
    val jobId: String,
    val title: String,
    val source: String,
    val url: String,
    val filename: String,
    val downloadPath: String,
    val savedAt: String,
    val expiresAt: String,
    val localUri: String? = null,
    val mimeType: String? = null,
)

object HistoryModel {
    const val HISTORY_LIMIT = 10

    fun addEntry(entries: List<HistoryEntry>, entry: HistoryEntry): List<HistoryEntry> {
        return (listOf(entry) + entries.filterNot { it.jobId == entry.jobId }).take(HISTORY_LIMIT)
    }

    fun attachLocalUri(
        entries: List<HistoryEntry>,
        jobId: String,
        localUri: String,
        mimeType: String? = null,
    ): List<HistoryEntry> {
        return entries.map { entry ->
            if (entry.jobId == jobId) {
                entry.copy(localUri = localUri, mimeType = mimeType ?: entry.mimeType)
            } else {
                entry
            }
        }
    }

    fun isExpired(entry: HistoryEntry, nowMillis: Long = System.currentTimeMillis()): Boolean {
        return try {
            val expires = Instant.parse(entry.expiresAt).toEpochMilli()
            expires <= nowMillis
        } catch (_: Exception) {
            true
        }
    }

    fun minutesUntilExpiry(expiresAt: String, nowMillis: Long = System.currentTimeMillis()): Int {
        return try {
            val expires = Instant.parse(expiresAt).toEpochMilli()
            val diff = expires - nowMillis
            if (diff <= 0L) 0 else kotlin.math.round(diff / 60_000.0).toInt()
        } catch (_: Exception) {
            0
        }
    }

    fun timeAgo(iso: String, nowMillis: Long = System.currentTimeMillis()): String {
        val then = try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            return ""
        }
        val minutes = (nowMillis - then) / 60_000L
        if (minutes < 1L) return "just now"
        if (minutes < 60L) return "$minutes min ago"
        val hours = minutes / 60L
        if (hours < 24L) return "$hours h ago"
        if (hours < 48L) return "yesterday"
        val formatter = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
            .withZone(ZoneId.systemDefault())
        return formatter.format(Instant.ofEpochMilli(then))
    }
}
