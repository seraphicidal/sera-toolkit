package dev.sera.toolkit.domain

import dev.sera.toolkit.model.DownloadOption
import dev.sera.toolkit.model.JobState
import dev.sera.toolkit.model.MediaKind
import kotlin.math.roundToInt
import kotlin.math.roundToLong

object Formatters {
    private val units = listOf("B", "KB", "MB", "GB", "TB")

    val PIPELINE_STEPS = listOf("Resolving", "Downloading", "Transcoding", "Tagging", "Done")

    fun formatBytes(bytes: Long?): String {
        if (bytes == null || bytes < 0L) return ""
        var value = bytes.toDouble()
        var unit = 0
        while (value >= 1024.0 && unit < units.lastIndex) {
            value /= 1024.0
            unit += 1
        }
        if (unit < units.lastIndex && value.roundToLong() >= 1024L) {
            value /= 1024.0
            unit += 1
        }
        val digits = if (unit == 0 || (value * 10.0).roundToLong() >= 100L) 0 else 1
        return if (digits == 0) {
            "${value.roundToLong()} ${units[unit]}"
        } else {
            val rounded = (value * 10.0).roundToLong() / 10.0
            "$rounded ${units[unit]}"
        }
    }

    fun formatDuration(seconds: Double?): String {
        if (seconds == null || !seconds.isFinite() || seconds < 0.0) return ""
        return TrimValidator.formatTimecode(seconds)
    }

    fun formatEta(seconds: Double?): String {
        if (seconds == null || !seconds.isFinite() || seconds < 0.0) return ""
        if (seconds < 1.0) return "00:00"
        if (seconds > 86_400.0) return ""
        return formatDuration(seconds).padStart(5, '0')
    }

    fun formatSpeed(bytesPerSecond: Double?): String {
        if (bytesPerSecond == null || !bytesPerSecond.isFinite() || bytesPerSecond <= 0.0) return ""
        return "${formatBytes(bytesPerSecond.roundToLong())}/s"
    }

    fun kindLabel(kind: MediaKind): String = when (kind) {
        MediaKind.VIDEO -> "Video"
        MediaKind.AUDIO -> "Audio"
        MediaKind.IMAGE -> "Image"
        MediaKind.GIF -> "GIF"
        MediaKind.UNKNOWN -> "Video"
    }

    fun pluralize(count: Int, singular: String, plural: String = "${singular}s"): String {
        return "$count ${if (count == 1) singular else plural}"
    }

    fun formatCodecBadge(rawCodec: String?): String? {
        if (rawCodec.isNullOrBlank()) return null
        val normalized = rawCodec.trim().lowercase()
        if (normalized == "none") return null
        return when {
            normalized.startsWith("av01") || normalized == "av1" -> "AV1"
            normalized.startsWith("avc1") ||
                normalized.startsWith("avc3") ||
                normalized == "h264" ||
                normalized == "h.264" ||
                normalized == "x264" -> "H.264"
            normalized.startsWith("hev1") ||
                normalized.startsWith("hvc1") ||
                normalized == "hevc" ||
                normalized == "h265" ||
                normalized == "h.265" ||
                normalized == "x265" -> "HEVC"
            normalized.startsWith("vp09") || normalized == "vp9" -> "VP9"
            normalized.startsWith("vp08") || normalized == "vp8" -> "VP8"
            normalized.contains("opus") -> "Opus"
            normalized.startsWith("mp4a") || normalized == "aac" -> "AAC"
            normalized.startsWith("mp3") -> "MP3"
            normalized == "flac" -> "FLAC"
            normalized == "vorbis" -> "Vorbis"
            normalized == "wav" || normalized.startsWith("pcm") -> "WAV"
            else -> rawCodec.trim().uppercase()
        }
    }

    private val detailTokenPatterns: List<Pair<Regex, String>> = listOf(
        Regex("\\bav1\\b|\\bav01\\b", RegexOption.IGNORE_CASE) to "AV1",
        Regex("\\bh\\.?264\\b|\\bavc1?\\b|\\bx264\\b", RegexOption.IGNORE_CASE) to "H.264",
        Regex("\\bhevc\\b|\\bh\\.?265\\b|\\bhev1\\b|\\bhvc1\\b", RegexOption.IGNORE_CASE) to "HEVC",
        Regex("\\bvp9\\b|\\bvp09\\b", RegexOption.IGNORE_CASE) to "VP9",
        Regex("\\bvp8\\b", RegexOption.IGNORE_CASE) to "VP8",
        Regex("\\bopus\\b", RegexOption.IGNORE_CASE) to "Opus",
        Regex("\\baac\\b|\\bmp4a\\b", RegexOption.IGNORE_CASE) to "AAC",
        Regex("\\bmp3\\b", RegexOption.IGNORE_CASE) to "MP3",
        Regex("\\bflac\\b", RegexOption.IGNORE_CASE) to "FLAC",
        Regex("\\bwav\\b|\\bpcm\\b", RegexOption.IGNORE_CASE) to "WAV",
    )

    private val bitratePattern = Regex("(\\d{2,4})\\s*kbps", RegexOption.IGNORE_CASE)

    fun optionBadges(option: DownloadOption): List<String> {
        val badges = mutableListOf<String>()
        val seen = HashSet<String>()
        fun add(badge: String?) {
            if (badge.isNullOrBlank()) return
            val key = badge.lowercase()
            if (seen.add(key)) badges.add(badge)
        }

        add(formatCodecBadge(option.videoCodec))
        add(formatCodecBadge(option.audioCodec))
        if (option.audioBitrateKbps != null && option.audioBitrateKbps.isFinite() && option.audioBitrateKbps > 0.0) {
            add("${option.audioBitrateKbps.roundToInt()}kbps")
        }
        if (option.fps != null && option.fps >= 50.0) {
            add("${option.fps.roundToInt()}fps")
        }
        val detail = option.detail
        if (!detail.isNullOrBlank()) {
            for ((pattern, label) in detailTokenPatterns) {
                if (pattern.containsMatchIn(detail)) add(label)
            }
            val bitrate = bitratePattern.find(detail)?.groupValues?.getOrNull(1)
            if (!bitrate.isNullOrBlank()) {
                add("${bitrate}kbps")
            }
        }
        return badges
    }

    private val doneTextPattern = Regex("\\bdone\\b|\\bcomplete|\\bfinished\\b")
    private val tagTextPattern = Regex("tag|metadata|embed|packag|finaliz|zip|archiv")
    private val transcodeTextPattern = Regex("transcod|convert|merg|mux|trim|ffmpeg|re-encod")
    private val downloadTextPattern = Regex("download|fetch|receiv|stream")

    fun resolvePipelineStepIndex(state: JobState, step: String?): Int {
        val text = (step ?: "").lowercase()
        return when {
            state == JobState.READY || doneTextPattern.containsMatchIn(text) -> 4
            state == JobState.PACKAGING ||
                state == JobState.FINALIZING ||
                tagTextPattern.containsMatchIn(text) -> 3
            state == JobState.MERGING ||
                state == JobState.CONVERTING ||
                transcodeTextPattern.containsMatchIn(text) -> 2
            state == JobState.DOWNLOADING || downloadTextPattern.containsMatchIn(text) -> 1
            else -> 0
        }
    }

    fun isSafeDownloadPath(path: String?): Boolean {
        if (path.isNullOrBlank() || path.length > 2_048) return false
        if (!path.startsWith("/api/") || path.startsWith("//")) return false
        if (path.contains('\\') || path.contains("..") || path.contains('@')) return false
        return path.none { it.code < 0x20 || it.code == 0x7f }
    }

    fun mediaKindFromFilename(name: String): MediaKind? {
        val lower = name.lowercase()
        return when {
            Regex("\\.(mp4|webm|mov|mkv)$").containsMatchIn(lower) -> MediaKind.VIDEO
            Regex("\\.(mp3|m4a|aac|opus|ogg|wav|flac)$").containsMatchIn(lower) -> MediaKind.AUDIO
            Regex("\\.(jpg|jpeg|png|webp|gif)$").containsMatchIn(lower) -> MediaKind.IMAGE
            else -> null
        }
    }
}
