package dev.sera.node.extractor

import dev.sera.node.model.SeraJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.roundToInt

@Serializable
data class YtdlpThumbnail(
    val url: String? = null,
    val width: JsonElement? = null,
    val height: JsonElement? = null,
    val preference: JsonElement? = null,
    val id: String? = null,
)

@Serializable
data class YtdlpSubtitle(
    val ext: String? = null,
    val url: String? = null,
    val name: JsonElement? = null,
)

@Serializable
data class YtdlpFormat(
    val format_id: JsonElement? = null,
    val format_note: JsonElement? = null,
    val format: JsonElement? = null,
    val ext: JsonElement? = null,
    val protocol: JsonElement? = null,
    val acodec: JsonElement? = null,
    val vcodec: JsonElement? = null,
    val audio_ext: JsonElement? = null,
    val video_ext: JsonElement? = null,
    val width: JsonElement? = null,
    val height: JsonElement? = null,
    val fps: JsonElement? = null,
    val tbr: JsonElement? = null,
    val abr: JsonElement? = null,
    val vbr: JsonElement? = null,
    val asr: JsonElement? = null,
    val filesize: JsonElement? = null,
    val filesize_approx: JsonElement? = null,
    val url: JsonElement? = null,
    val container: JsonElement? = null,
    val dynamic_range: JsonElement? = null,
    val language: JsonElement? = null,
    val language_preference: JsonElement? = null,
    val quality: JsonElement? = null,
    val preference: JsonElement? = null,
    val resolution: JsonElement? = null,
    val drm: JsonElement? = null,
)

@Serializable
data class YtdlpInfo(
    val id: JsonElement? = null,
    val _type: String? = null,
    val title: JsonElement? = null,
    val fulltitle: JsonElement? = null,
    val description: JsonElement? = null,
    val uploader: JsonElement? = null,
    val uploader_id: JsonElement? = null,
    val uploader_url: JsonElement? = null,
    val channel: JsonElement? = null,
    val channel_url: JsonElement? = null,
    val creator: JsonElement? = null,
    val webpage_url: JsonElement? = null,
    val original_url: JsonElement? = null,
    val extractor: JsonElement? = null,
    val extractor_key: JsonElement? = null,
    val duration: JsonElement? = null,
    val thumbnail: JsonElement? = null,
    val thumbnails: List<YtdlpThumbnail?>? = null,
    val upload_date: JsonElement? = null,
    val timestamp: JsonElement? = null,
    val release_timestamp: JsonElement? = null,
    val formats: List<YtdlpFormat?>? = null,
    val entries: List<YtdlpInfo?>? = null,
    val is_live: JsonElement? = null,
    val subtitles: Map<String, List<YtdlpSubtitle>?>? = null,
    val automatic_captions: Map<String, List<YtdlpSubtitle>?>? = null,
    val language: JsonElement? = null,
    val artist: JsonElement? = null,
    val album: JsonElement? = null,
    val track: JsonElement? = null,
    val was_live: JsonElement? = null,
    val live_status: JsonElement? = null,
    val ext: JsonElement? = null,
    val width: JsonElement? = null,
    val height: JsonElement? = null,
    val url: JsonElement? = null,
    val format_id: JsonElement? = null,
    val protocol: JsonElement? = null,
    val vcodec: JsonElement? = null,
    val acodec: JsonElement? = null,
    val filesize: JsonElement? = null,
    val filesize_approx: JsonElement? = null,
    val view_count: JsonElement? = null,
    val like_count: JsonElement? = null,
    val playlist_count: JsonElement? = null,
    val playlist_index: JsonElement? = null,
    val age_limit: JsonElement? = null,
    val availability: JsonElement? = null,
    val drm: JsonElement? = null,
)

fun JsonElement?.asNum(): Double? {
    val p = this as? JsonPrimitive ?: return null
    if (!p.isString) {
        val d = p.doubleOrNull ?: return null
        return if (d.isFinite()) d else null
    }
    val trimmed = p.content.trim()
    if (trimmed.isEmpty() || trimmed == "NA") return null
    val d = trimmed.toDoubleOrNull() ?: return null
    return if (d.isFinite()) d else null
}

fun JsonElement?.asInt(): Int? = asNum()?.roundToInt()

fun JsonElement?.asLong(): Long? = asNum()?.toLong()

fun JsonElement?.asStr(): String? {
    val p = this as? JsonPrimitive ?: return null
    if (!p.isString) return null
    val trimmed = p.content.trim()
    if (trimmed.isEmpty() || trimmed == "NA" || trimmed == "none" || trimmed == "null") {
        return null
    }
    return trimmed
}

fun JsonElement?.asRawLowerStr(): String? {
    val p = this as? JsonPrimitive ?: return null
    if (!p.isString) return null
    return p.content.trim().lowercase()
}

fun JsonElement?.asBool(): Boolean? {
    val p = this as? JsonPrimitive ?: return null
    if (!p.isString) return p.booleanOrNull
    return when (p.content.trim().lowercase()) {
        "true" -> true
        "false" -> false
        else -> null
    }
}

fun JsonElement?.isNullOrJsonNull(): Boolean = this == null || this is JsonNull

private val FALSEY_DRM_VALUES = setOf("", "none", "false", "no", "na", "null", "0")

fun isTruthyDrmValue(value: JsonElement?): Boolean {
    if (value == null || value is JsonNull) return false
    val p = value as? JsonPrimitive ?: return true
    if (!p.isString) {
        val b = p.booleanOrNull
        if (b != null) return b
        val n = p.doubleOrNull
        if (n != null) return n != 0.0
        return true
    }
    val lower = p.content.trim().lowercase()
    return lower.isNotEmpty() && lower !in FALSEY_DRM_VALUES
}

fun assertNotDrmProtected(info: YtdlpInfo) {
    if (isTruthyDrmValue(info.drm)) {
        val raw = (info.drm as? JsonPrimitive)?.content ?: info.drm.toString()
        throw seraError(SeraErrorCode.DRM_PROTECTED, detail = "drm: $raw")
    }
    val formats = info.formats.orEmpty().filterNotNull()
    val mediaFormats = formats.filter {
        it.ext.asStr()?.lowercase() != "mhtml" && it.protocol.asStr()?.lowercase() != "mhtml"
    }
    if (mediaFormats.isNotEmpty() && mediaFormats.all { isTruthyDrmValue(it.drm) }) {
        throw seraError(SeraErrorCode.DRM_PROTECTED, detail = "all formats are DRM protected")
    }
}

data class ParsedYtdlpOutput(
    val info: YtdlpInfo,
    val rawJson: String?,
)

fun parseYtdlpInfo(stdout: String): ParsedYtdlpOutput {
    val parsed = try {
        SeraJson.decodeFromString(YtdlpInfo.serializer(), stdout)
    } catch (cause: Exception) {
        throw seraError(
            SeraErrorCode.PROVIDER_UNAVAILABLE,
            detail = "yt-dlp produced unparseable JSON",
            cause = cause,
        )
    }
    assertNotDrmProtected(parsed)
    val raw = if (stdout.length <= 1024 * 1024) stdout else null
    return ParsedYtdlpOutput(info = parsed, rawJson = raw)
}
