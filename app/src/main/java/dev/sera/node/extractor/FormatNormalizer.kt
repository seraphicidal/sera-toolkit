package dev.sera.node.extractor

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

private val KNOWN_CONTAINERS = setOf(
    "mp4",
    "webm",
    "mov",
    "mkv",
    "mp3",
    "m4a",
    "aac",
    "opus",
    "ogg",
    "wav",
    "flac",
    "gif",
    "jpg",
    "png",
    "webp",
    "avif",
    "pdf",
    "iso",
    "zip",
    "tar",
    "7z",
    "apk",
    "dmg",
    "exe",
    "epub",
)

val IMAGE_EXTENSIONS = setOf("jpg", "jpeg", "png", "webp", "avif", "bmp", "heic", "tif", "tiff")
val AUDIO_EXTENSIONS = setOf("mp3", "m4a", "aac", "opus", "ogg", "oga", "wav", "flac", "wma")

private val SUPPORTED_PROTOCOLS = setOf(
    "https",
    "http",
    "m3u8_native",
    "m3u8",
    "http_dash_segments",
    "mhtml_ignored",
)

private val FORMAT_ID_REGEX = Regex("""^[A-Za-z0-9_.-]+$""")

data class UsableFormat(
    val id: String,
    val ext: String,
    val protocol: String,
    val vcodec: String? = null,
    val acodec: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val fps: Int? = null,
    val tbr: Double? = null,
    val abr: Double? = null,
    val asr: Double? = null,
    val filesize: Long? = null,
    val filesizeIsApproximate: Boolean = false,
    val hasVideo: Boolean = false,
    val hasAudio: Boolean = false,
    val languagePreference: Double? = null,
    val note: String? = null,
)

data class FormatSplit(
    val videoOnly: List<UsableFormat>,
    val audioOnly: List<UsableFormat>,
    val progressive: List<UsableFormat>,
)

fun normalizeContainer(ext: String?, fallback: String = "bin"): String {
    val raw = (ext ?: "").trim().lowercase().trimStart('.')
    val mapped = when (raw) {
        "jpeg" -> "jpg"
        "m4v" -> "mp4"
        "oga" -> "ogg"
        else -> raw
    }
    return if (mapped in KNOWN_CONTAINERS) mapped else fallback
}

private fun isStoryboard(format: YtdlpFormat): Boolean {
    val ext = format.ext.asStr()?.lowercase()
    val protocol = format.protocol.asStr()?.lowercase()
    val note = format.format_note.asStr()?.lowercase().orEmpty()
    return ext == "mhtml" || protocol == "mhtml" || note.contains("storyboard")
}

private fun isRedundantTwin(format: YtdlpFormat): Boolean {
    val id = format.format_id.asStr().orEmpty()
    if (id.endsWith("-drc")) return true
    val note = format.format_note.asStr()?.lowercase().orEmpty()
    return note.contains("drc")
}

fun entryFormats(info: YtdlpInfo): List<YtdlpFormat>? {
    val existing = info.formats?.filterNotNull()
    if (!existing.isNullOrEmpty()) return existing
    val id = info.format_id.asStr() ?: return null
    val url = info.url.asStr() ?: return null
    return listOf(
        YtdlpFormat(
            format_id = info.format_id,
            url = info.url,
            ext = info.ext,
            protocol = info.protocol,
            vcodec = info.vcodec,
            acodec = info.acodec,
            width = info.width,
            height = info.height,
            filesize = info.filesize,
            filesize_approx = info.filesize_approx,
        ),
    ).also {
        id.length
        url.length
    }
}

fun toUsableFormats(formats: List<YtdlpFormat>?): List<UsableFormat> {
    if (formats.isNullOrEmpty()) return emptyList()
    val out = ArrayList<UsableFormat>(formats.size)

    for (format in formats) {
        val id = format.format_id.asStr() ?: continue
        if (!FORMAT_ID_REGEX.matches(id)) continue
        if (isStoryboard(format) || isRedundantTwin(format)) continue

        val protocol = format.protocol.asStr() ?: "https"
        if (protocol !in SUPPORTED_PROTOCOLS) continue

        val rawVcodec = format.vcodec.asRawLowerStr()
        val rawAcodec = format.acodec.asRawLowerStr()
        val vExplicitNone = rawVcodec == "none"
        val aExplicitNone = rawAcodec == "none"
        val vcodec = format.vcodec.asStr()
        val acodec = format.acodec.asStr()
        val ext = (format.ext.asStr() ?: "").lowercase()
        if (vcodec == null && acodec == null && ext in IMAGE_EXTENSIONS) continue

        val hasVideo = if (vExplicitNone) false else (vcodec != null || ext !in AUDIO_EXTENSIONS)
        val hasAudio = if (aExplicitNone) {
            false
        } else {
            acodec != null || (!vExplicitNone && format.acodec.isNullOrJsonNull() && ext !in IMAGE_EXTENSIONS)
        }
        if (!hasVideo && !hasAudio) continue

        val exact = format.filesize.asLong()?.takeIf { it > 0L }
        val approx = format.filesize_approx.asLong()?.takeIf { it > 0L }
        val size = exact ?: approx
        val width = format.width.asNum()?.roundToInt()?.takeIf { it > 0 }
        val height = format.height.asNum()?.roundToInt()?.takeIf { it > 0 }
        val fps = format.fps.asNum()?.roundToInt()?.takeIf { it > 0 }
        val tbr = format.tbr.asNum()?.takeIf { it > 0.0 }
        val abr = format.abr.asNum()?.takeIf { it > 0.0 }
        val asr = format.asr.asNum()?.takeIf { it > 0.0 }
        val langPref = format.language_preference.asNum()
        val note = format.format_note.asStr()

        out.add(
            UsableFormat(
                id = id,
                ext = format.ext.asStr() ?: "bin",
                protocol = protocol,
                vcodec = vcodec,
                acodec = acodec,
                width = width,
                height = height,
                fps = fps,
                tbr = tbr,
                abr = abr,
                asr = asr,
                filesize = size,
                filesizeIsApproximate = exact == null,
                hasVideo = hasVideo,
                hasAudio = hasAudio,
                languagePreference = langPref,
                note = note,
            ),
        )
    }

    val nonPremiumHeights = out
        .filter { it.hasVideo && it.height != null && !(it.note?.lowercase().orEmpty().contains("premium")) }
        .mapNotNull { it.height }
        .toSet()

    return out.filter { f ->
        f.height == null ||
            !(f.note?.lowercase().orEmpty().contains("premium")) ||
            f.height !in nonPremiumHeights
    }
}

fun estimateSize(format: UsableFormat, durationSeconds: Double?): Long? {
    if (format.filesize != null) return format.filesize
    val bitrate = format.tbr ?: format.abr
    if (bitrate == null || bitrate == 0.0 || durationSeconds == null || durationSeconds == 0.0) {
        return null
    }
    return ((bitrate * 1000.0 * durationSeconds) / 8.0).roundToLong()
}

fun nativeContainer(vcodec: String?): String {
    val codec = (vcodec ?: "").lowercase()
    return if (codec.startsWith("vp9") || codec.startsWith("vp09") || codec.startsWith("vp8")) {
        "webm"
    } else {
        "mp4"
    }
}

fun fitsInMp4(vcodec: String?, acodec: String?): Boolean {
    val v = (vcodec ?: "").lowercase()
    val a = (acodec ?: "").lowercase()
    val videoOk =
        v.isEmpty() ||
            v == "none" ||
            v.startsWith("avc") ||
            v.startsWith("h264") ||
            v.startsWith("av01") ||
            v.startsWith("vp09") ||
            v.startsWith("vp9") ||
            v.startsWith("hev") ||
            v.startsWith("hvc")
    val audioOk =
        a.isEmpty() ||
            a == "none" ||
            a.startsWith("mp4a") ||
            a.startsWith("aac") ||
            a.startsWith("ac-3") ||
            a.startsWith("ec-3")
    return videoOk && audioOk
}

fun fitsInMov(vcodec: String?, acodec: String?): Boolean {
    val v = (vcodec ?: "").lowercase()
    val videoOk =
        v.startsWith("avc") || v.startsWith("h264") || v.startsWith("hev") || v.startsWith("hvc")
    return videoOk && fitsInMp4(vcodec, acodec)
}

fun splitFormats(formats: List<UsableFormat>): FormatSplit {
    val videoOnly = ArrayList<UsableFormat>()
    val audioOnly = ArrayList<UsableFormat>()
    val progressive = ArrayList<UsableFormat>()
    for (format in formats) {
        when {
            format.hasVideo && format.hasAudio -> progressive.add(format)
            format.hasVideo -> videoOnly.add(format)
            else -> audioOnly.add(format)
        }
    }
    return FormatSplit(videoOnly = videoOnly, audioOnly = audioOnly, progressive = progressive)
}

fun protocolScore(protocol: String, note: String? = null): Int {
    val normalized = protocol.lowercase()
    val base = when (normalized) {
        "https", "http" -> 2
        "http_dash_segments" -> 1
        else -> 0
    }
    return if (note?.lowercase()?.contains("untested") == true) min(base, 0) - 1 else base
}

fun bestAudio(audio: List<UsableFormat>, prefer: String = "any"): UsableFormat? {
    if (audio.isEmpty()) return null
    fun score(format: UsableFormat): Double {
        val proto = protocolScore(format.protocol, format.note)
        val codec = (format.acodec ?: "").lowercase()
        val containerBonus = when {
            prefer == "mp4" && (codec.startsWith("mp4a") || codec.startsWith("aac")) -> 1
            prefer == "webm" && codec.startsWith("opus") -> 1
            else -> 0
        }
        val langScore = when {
            format.languagePreference != null -> max(-10.0, min(20.0, format.languagePreference))
            format.note?.lowercase()?.contains("original") == true -> 5.0
            else -> 0.0
        }
        return proto * 100_000_000.0 +
            containerBonus * 1_000_000.0 +
            langScore * 10_000.0 +
            (format.abr ?: format.tbr ?: 0.0)
    }
    return audio.maxByOrNull { score(it) }
}

fun rankVideo(format: UsableFormat): Double {
    val proto = protocolScore(format.protocol, format.note)
    val codec = (format.vcodec ?: "").lowercase()
    val codecScore = when {
        codec.startsWith("avc") || codec.startsWith("h264") -> 3
        codec.startsWith("av01") -> 2
        codec.startsWith("vp9") || codec.startsWith("vp09") -> 1
        else -> 0
    }
    val fpsScore = if ((format.fps ?: 30) >= 50) 1 else 0
    val premiumPenalty = if (format.note?.lowercase()?.contains("premium") == true) 50_000.0 else 0.0
    return proto * 100_000_000.0 +
        fpsScore * 10_000_000.0 +
        codecScore * 1_000_000.0 +
        (format.tbr ?: 0.0) -
        premiumPenalty
}

fun bestVideoPerHeight(video: List<UsableFormat>): List<UsableFormat> {
    val byHeight = LinkedHashMap<Int, UsableFormat>()
    for (format in video) {
        val height = format.height ?: continue
        val current = byHeight[height]
        if (current == null || rankVideo(format) > rankVideo(current)) {
            byHeight[height] = format
        }
    }
    return byHeight.values.sortedByDescending { it.height ?: 0 }
}

fun audioBitrateChoices(sourceAbr: Double?): List<Int> {
    val source = sourceAbr ?: 0.0
    val candidates = listOf(320, 192, 128)
    val usable = candidates.filter { rate ->
        source == 0.0 || rate <= max(source * 1.1, 128.0)
    }
    return usable.ifEmpty { listOf(max(source, 64.0).roundToInt()) }
}
