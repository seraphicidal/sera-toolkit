package dev.sera.node.extractor

import dev.sera.node.model.AudioExtractSpec
import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SubtitleTrack
import java.util.Locale
import kotlin.math.roundToLong

data class PlanBuildOptions(
    val maxGifDurationSeconds: Double? = null,
    val maxFilesizeBytes: Long? = null,
)

private data class AudioTarget(
    val container: String,
    val format: String,
    val label: String,
    val prefer: String,
    val selectorPrefix: String? = null,
)

private val AUDIO_TARGETS = listOf(
    AudioTarget(container = "mp3", format = "mp3", label = "MP3", prefer = "any"),
    AudioTarget(
        container = "m4a",
        format = "m4a",
        label = "M4A",
        prefer = "mp4",
        selectorPrefix = "bestaudio[acodec^=mp4a]",
    ),
    AudioTarget(
        container = "opus",
        format = "opus",
        label = "Opus",
        prefer = "webm",
        selectorPrefix = "bestaudio[acodec=opus]",
    ),
    AudioTarget(container = "wav", format = "wav", label = "WAV", prefer = "any"),
)

private val QUALITY_STEPS = listOf(
    4320 to "8K",
    2160 to "4K",
    1440 to "1440p",
    1080 to "1080p",
    720 to "720p",
    480 to "480p",
    360 to "360p",
    240 to "240p",
    144 to "144p",
)

private val BYTE_UNITS = listOf("B", "KB", "MB", "GB", "TB")

fun formatBytes(bytes: Double): String {
    if (!bytes.isFinite() || bytes < 0.0) return ""
    var value = bytes
    var unit = 0
    while (value >= 1024.0 && unit < BYTE_UNITS.size - 1) {
        value /= 1024.0
        unit += 1
    }
    val digits = when {
        unit == 0 -> 0
        value < 10.0 -> 1
        else -> 0
    }
    return String.format(Locale.US, "%.${digits}f %s", value, BYTE_UNITS[unit])
}

fun qualityLabel(height: Int?, width: Int? = null): String {
    if (height == null || height <= 0) return "Source"
    val shortEdge = if (width != null && width > 0 && width < height) width else height
    for ((threshold, label) in QUALITY_STEPS) {
        if (shortEdge >= threshold - threshold * 0.06) return label
    }
    return "${shortEdge}p"
}

fun codecLabel(codec: String?): String? {
    if (codec.isNullOrEmpty() || codec == "none") return null
    val c = codec.lowercase()
    return when {
        c.startsWith("avc1") || c.startsWith("h264") -> "H.264"
        c.startsWith("hev1") || c.startsWith("hvc1") || c.startsWith("h265") -> "H.265"
        c.startsWith("av01") -> "AV1"
        c.startsWith("vp09") || c == "vp9" -> "VP9"
        c.startsWith("vp8") -> "VP8"
        c.startsWith("mp4a") || c.startsWith("aac") -> "AAC"
        c.startsWith("opus") -> "Opus"
        c.startsWith("vorbis") -> "Vorbis"
        c.startsWith("mp3") -> "MP3"
        c.startsWith("flac") -> "FLAC"
        c.startsWith("ec-3") || c.startsWith("ac-3") -> "Dolby"
        else -> codec.substringBefore('.').uppercase()
    }
}

private fun sizeDetail(bytes: Long?, approximate: Boolean): String? {
    if (bytes == null || bytes <= 0L) return null
    return "${if (approximate) "~" else ""}${formatBytes(bytes.toDouble())}"
}

fun joinDetail(vararg parts: String?): String? {
    val kept = parts.filter { !it.isNullOrEmpty() }
    return if (kept.isEmpty()) null else kept.joinToString(" \u00b7 ")
}

fun kindOf(info: YtdlpInfo): String {
    val ext = (info.ext.asStr() ?: "").lowercase()
    if (ext == "gif") return "gif"
    if (ext in IMAGE_EXTENSIONS) return "image"
    if (ext in AUDIO_EXTENSIONS) return "audio"

    val formats = toUsableFormats(entryFormats(info))
    if (formats.isNotEmpty()) {
        val split = splitFormats(formats)
        if (split.videoOnly.isNotEmpty() || split.progressive.isNotEmpty()) {
            val onlyImages = formats.all { it.ext.lowercase() in IMAGE_EXTENSIONS }
            return if (onlyImages) "image" else "video"
        }
        if (split.audioOnly.isNotEmpty()) return "audio"
    }

    val vcodec = info.vcodec.asStr()
    val acodec = info.acodec.asStr()
    if (vcodec != null && vcodec != "none") return "video"
    if (acodec != null && acodec != "none") return "audio"
    return "unknown"
}

private fun makeVideoPlan(
    video: UsableFormat,
    audio: UsableFormat?,
    container: String,
    duration: Double?,
    recommended: Boolean,
): ResolvedPlan {
    val videoSize = estimateSize(video, duration)
    val audioSize = if (audio != null) estimateSize(audio, duration) ?: 0L else 0L
    val total = if (videoSize != null) videoSize + audioSize else null
    val approximate = video.filesizeIsApproximate || (audio?.filesizeIsApproximate == true)

    val selector = if (audio != null) "${video.id}+${audio.id}" else video.id
    val vLabel = codecLabel(video.vcodec)
    val aLabel = codecLabel(audio?.acodec ?: video.acodec)
    val codecSummary = if (vLabel != null && aLabel != null) "$vLabel + $aLabel" else (vLabel ?: aLabel)
    val detail = joinDetail(
        container.uppercase(),
        codecSummary,
        if (video.fps != null && video.fps >= 50) "${video.fps} fps" else null,
        sizeDetail(total, approximate),
    )

    return ResolvedPlan(
        kind = "video",
        container = container,
        label = qualityLabel(video.height, video.width),
        detail = detail,
        width = video.width,
        height = video.height,
        fps = video.fps?.toDouble(),
        videoCodec = video.vcodec?.take(32),
        audioCodec = (audio?.acodec ?: video.acodec)?.take(32),
        filesizeBytes = total,
        filesizeIsApproximate = if (total != null && approximate) true else null,
        requiresConversion = false,
        recommended = recommended,
        fetch = FetchPlan.Ytdlp(
            selector = selector,
            merge = if (audio != null) container else null,
        ),
    )
}

fun buildVideoPlans(
    formats: List<UsableFormat>,
    duration: Double?,
    options: PlanBuildOptions = PlanBuildOptions(),
): List<ResolvedPlan> {
    val split = splitFormats(formats)
    val plans = ArrayList<ResolvedPlan>()

    val progressiveByHeight = LinkedHashMap<Int, UsableFormat>()
    for (format in split.progressive) {
        val height = format.height ?: continue
        val current = progressiveByHeight[height]
        if (current == null || rankVideo(format) > rankVideo(current)) {
            progressiveByHeight[height] = format
        }
    }

    val heights = bestVideoPerHeight(split.videoOnly)
    val seen = HashSet<Int>()
    var first = true

    fun emit(video: UsableFormat, audio: UsableFormat?) {
        val height = video.height ?: 0
        if (height in seen) return

        val container = if (audio != null) {
            if (fitsInMp4(video.vcodec, audio.acodec)) "mp4" else "webm"
        } else {
            nativeContainer(video.vcodec)
        }

        val plan = makeVideoPlan(
            video = video,
            audio = audio,
            container = container,
            duration = duration,
            recommended = first,
        )

        val limit = options.maxFilesizeBytes
        if (limit != null && limit > 0L && plan.filesizeBytes != null && plan.filesizeBytes > limit) {
            return
        }
        seen.add(height)
        plans.add(plan)
        first = false
    }

    for (video in heights) {
        val height = video.height ?: 0
        val progressiveMatch = progressiveByHeight[height]
        if (
            progressiveMatch != null &&
            protocolScore(progressiveMatch.protocol, progressiveMatch.note) >=
            protocolScore(video.protocol, video.note) &&
            (progressiveMatch.tbr ?: 0.0) >= (video.tbr ?: 0.0) * 0.8
        ) {
            emit(progressiveMatch, null)
            continue
        }
        val preferred = nativeContainer(video.vcodec)
        emit(video, bestAudio(split.audioOnly, preferred))
    }

    for (format in progressiveByHeight.values.sortedByDescending { it.height ?: 0 }) {
        val height = format.height ?: continue
        if (height !in seen) {
            emit(format, null)
        }
    }

    if (plans.isEmpty() && (split.progressive.isNotEmpty() || split.videoOnly.isNotEmpty())) {
        val best = (split.progressive + split.videoOnly).maxByOrNull { rankVideo(it) }
        if (best != null) {
            val preferred = nativeContainer(best.vcodec)
            val audio = if (best.hasAudio) null else bestAudio(split.audioOnly, preferred)
            emit(best, audio)
        }
    }

    return plans
}

fun buildAlternateContainerPlans(best: ResolvedPlan?): List<ResolvedPlan> {
    if (best == null || best.kind != "video") return emptyList()
    val ytdlpFetch = best.fetch as? FetchPlan.Ytdlp ?: return emptyList()
    val plans = ArrayList<ResolvedPlan>()

    if (best.container == "mp4" && fitsInMov(best.videoCodec, best.audioCodec)) {
        plans.add(
            best.copy(
                container = "mov",
                label = "${best.label} (MOV)",
                detail = joinDetail("MOV", codecLabel(best.videoCodec), "remux"),
                recommended = false,
                requiresConversion = false,
                fetch = ytdlpFetch.copy(remux = "mov"),
            ),
        )
    }
    return plans
}

fun buildAudioPlans(
    formats: List<UsableFormat>,
    duration: Double?,
    options: PlanBuildOptions = PlanBuildOptions(),
): List<ResolvedPlan> {
    val split = splitFormats(formats)
    val pool = split.audioOnly.ifEmpty {
        split.progressive.filter { it.acodec != null }
    }
    if (bestAudio(pool) == null) return emptyList()

    val plans = ArrayList<ResolvedPlan>()

    for (target in AUDIO_TARGETS) {
        val source = bestAudio(pool, target.prefer) ?: continue
        val sourceAbr = source.abr ?: if (source.hasVideo) null else source.tbr
        val sourceCodec = (source.acodec ?: "").lowercase()

        val isLossless = target.container == "wav"
        val canCopy =
            (target.container == "m4a" && (sourceCodec.startsWith("mp4a") || sourceCodec.startsWith("aac"))) ||
                (target.container == "opus" && sourceCodec.startsWith("opus")) ||
                (target.container == "mp3" && sourceCodec.startsWith("mp3"))

        val base = if (split.audioOnly.isNotEmpty()) "bestaudio/best" else "best"
        val m4aPrefix = if (sourceCodec.startsWith("aac")) {
            "bestaudio[acodec^=aac]"
        } else {
            target.selectorPrefix
        }
        val prefix = if (target.container == "m4a") m4aPrefix else target.selectorPrefix
        val selector = if (canCopy && prefix != null) "$prefix/$base" else base

        val bitrate = if (isLossless || canCopy) null else audioBitrateChoices(sourceAbr).first()

        val estimatedBytes: Long? = if (isLossless) {
            if (duration != null && duration > 0.0) (duration * 44100.0 * 2.0 * 2.0).roundToLong() else null
        } else {
            val effectiveRate = bitrate?.toDouble() ?: sourceAbr
            if (duration != null && duration > 0.0 && effectiveRate != null && effectiveRate > 0.0) {
                (((effectiveRate * 1000.0) / 8.0) * duration).roundToLong()
            } else {
                estimateSize(source, duration)
            }
        }

        val limit = options.maxFilesizeBytes
        if (limit != null && limit > 0L && estimatedBytes != null && estimatedBytes > limit) {
            continue
        }

        val detail = joinDetail(
            when {
                canCopy -> "Original quality"
                bitrate != null -> "$bitrate kbps"
                isLossless -> "Lossless"
                else -> null
            },
            if (canCopy) codecLabel(source.acodec) else null,
            sizeDetail(estimatedBytes, true),
        ) ?: target.label

        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = target.container,
                label = target.label,
                detail = detail,
                audioBitrateKbps = bitrate?.toDouble(),
                audioCodec = source.acodec?.take(32),
                filesizeBytes = estimatedBytes,
                filesizeIsApproximate = if (estimatedBytes != null) true else null,
                requiresConversion = !canCopy,
                recommended = target.container == "mp3",
                fetch = FetchPlan.Ytdlp(
                    selector = selector,
                    audio = AudioExtractSpec(
                        format = target.format,
                        quality = if (bitrate != null) "${bitrate}K" else "0",
                    ),
                ),
            ),
        )
    }

    return plans
}

fun buildImagePlans(info: YtdlpInfo, directUrl: String?): List<ResolvedPlan> {
    val ext = (info.ext.asStr() ?: "jpg").lowercase()
    val container = if (ext in IMAGE_EXTENSIONS) ext else "jpg"
    val width = info.width.asInt()?.takeIf { it > 0 }
    val height = info.height.asInt()?.takeIf { it > 0 }
    val exactSize = info.filesize.asLong()?.takeIf { it > 0L }
    val size = exactSize ?: info.filesize_approx.asLong()?.takeIf { it > 0L }

    return listOf(
        ResolvedPlan(
            kind = "image",
            container = container,
            label = "Original",
            detail = joinDetail(
                container.uppercase(),
                if (width != null && height != null) "$width \u00d7 $height" else null,
                sizeDetail(size, exactSize == null),
            ) ?: container.uppercase(),
            width = width,
            height = height,
            filesizeBytes = size,
            filesizeIsApproximate = if (size != null && exactSize == null) true else null,
            requiresConversion = false,
            recommended = true,
            fetch = if (directUrl != null) {
                FetchPlan.Direct(url = directUrl)
            } else {
                FetchPlan.Ytdlp(selector = "best")
            },
        ),
    )
}

fun buildGifPlans(
    sourceIsRealGif: Boolean,
    videoPlans: List<ResolvedPlan>,
    duration: Double?,
    options: PlanBuildOptions = PlanBuildOptions(),
): List<ResolvedPlan> {
    val plans = ArrayList<ResolvedPlan>()
    val maxGif = options.maxGifDurationSeconds ?: 30.0
    val best = videoPlans.firstOrNull()

    if (sourceIsRealGif) {
        plans.add(
            ResolvedPlan(
                kind = "gif",
                container = "gif",
                label = "Original",
                detail = "GIF \u00b7 unmodified",
                requiresConversion = false,
                recommended = true,
                fetch = FetchPlan.Ytdlp(selector = "best"),
            ),
        )
    }

    if (best != null && best.fetch is FetchPlan.Ytdlp) {
        if (!sourceIsRealGif && (duration == null || duration <= maxGif)) {
            val effectiveFps = if (best.fps != null && best.fps > 15.0) 15 else (best.fps?.toInt() ?: 15)
            plans.add(
                ResolvedPlan(
                    kind = "gif",
                    container = "gif",
                    label = "GIF",
                    detail = "Converted \u00b7 $effectiveFps fps",
                    requiresConversion = true,
                    recommended = false,
                    fetch = best.fetch,
                    convert = ConversionSpec.Gif(maxWidth = 480, fps = 15),
                ),
            )
        }
        if (sourceIsRealGif) {
            plans.add(
                ResolvedPlan(
                    kind = "video",
                    container = "mp4",
                    label = "MP4",
                    detail = "Converted from GIF \u00b7 H.264",
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Ytdlp(selector = "best"),
                    convert = ConversionSpec.Video(container = "mp4"),
                ),
            )
            plans.add(
                ResolvedPlan(
                    kind = "video",
                    container = "webm",
                    label = "WebM",
                    detail = "Converted from GIF \u00b7 VP9",
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Ytdlp(selector = "best"),
                    convert = ConversionSpec.Video(container = "webm"),
                ),
            )
        }
    }

    return plans
}

fun applyRecommendations(plans: List<ResolvedPlan>): List<ResolvedPlan> {
    val claimed = HashSet<String>()
    return plans.map { plan ->
        if (plan.recommended && claimed.add(plan.kind)) {
            plan
        } else if (plan.recommended) {
            plan.copy(recommended = false)
        } else {
            plan
        }
    }
}

fun ensureRecommendations(plans: List<ResolvedPlan>): List<ResolvedPlan> {
    val withFlags = applyRecommendations(plans)
    val kinds = LinkedHashSet<String>(withFlags.size)
    for (plan in withFlags) kinds.add(plan.kind)
    val result = withFlags.toMutableList()
    for (kind in kinds) {
        if (result.any { it.kind == kind && it.recommended }) continue
        val index = result.indexOfFirst { it.kind == kind }
        if (index >= 0) result[index] = result[index].copy(recommended = true)
    }
    return result
}

private fun baseLanguage(lang: String): String =
    lang.split('-', '_').firstOrNull()?.lowercase().orEmpty()

fun languageName(lang: String): String {
    val code = lang.removeSuffix("-orig")
    if (baseLanguage(code) == "und") return "Unknown language"
    return try {
        val locale = Locale.forLanguageTag(code.replace('_', '-'))
        val display = locale.getDisplayName(Locale.ENGLISH)
        if (display.isNotBlank() && !display.equals(code, ignoreCase = true)) display else lang
    } catch (_: Exception) {
        lang
    }
}

fun subtitleTracks(entry: YtdlpInfo): List<SubtitleTrack> {
    val manual = entry.subtitles.orEmpty().entries.filter { it.key != "live_chat" }
    val automatic = entry.automatic_captions.orEmpty().keys

    val tracks = manual.map { (lang, renditions) ->
        val name = renditions.orEmpty().firstNotNullOfOrNull { it.name.asStr() }
        SubtitleTrack(
            lang = lang.take(40),
            label = (name ?: languageName(lang)).take(100),
            auto = false,
        )
    }.toMutableList()

    val entryLang = entry.language.asStr()
    val original = automatic.firstOrNull { it.endsWith("-orig") }
        ?: if (entryLang != null && entryLang in automatic) entryLang else null

    if (original != null) {
        val base = baseLanguage(original.removeSuffix("-orig"))
        if (tracks.none { baseLanguage(it.lang) == base }) {
            tracks.add(
                SubtitleTrack(
                    lang = original.take(40),
                    label = "${languageName(base)} (auto-generated)".take(100),
                    auto = true,
                ),
            )
        }
    }
    return tracks
}
