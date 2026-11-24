package dev.sera.node.extractor

import dev.sera.node.model.FetchPlan
import dev.sera.node.model.MediaTags
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs

data class ExtractorResolveResult(
    val media: ResolvedMedia,
    val rawInfoJson: String? = null,
)

data class ExtractionExecutionContext(
    val runtimeConfig: NodeRuntimeConfig,
    val hotConfig: ProviderHotConfig?,
    val maxItemsPerJob: Int = 50,
    val resolveTimeoutMs: Long = 60_000L,
    val allowDegraded: Boolean = false,
    val isCancelled: () -> Boolean = { false },
)

private val ISO_FORMATTER: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

abstract class YtdlpBaseExtractor(
    protected val executor: MediaCommandExecutor,
) {
    abstract val id: String
    abstract val label: String
    abstract val hosts: List<String>

    open fun normalize(url: HttpUrl): HttpUrl = url

    protected open fun wantsPlaylist(url: HttpUrl): Boolean = false

    protected open fun multiItemType(url: HttpUrl): String = "collection"

    protected open fun extractorArgs(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> = emptyList()

    protected open fun extraYtdlpArgs(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> = emptyList()

    protected open fun remoteComponents(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> = emptyList()

    protected open fun useExtractors(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): String? = null

    protected open fun treatsSilentShortVideoAsGif(): Boolean = false

    protected open fun strategies(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<ExtractionStrategy> = listOf(
        ExtractionStrategy(
            id = "ytdlp",
            label = "the extractor",
            run = { runExtractor(url, context).media },
        ),
    )

    open suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        var latestRawJson: String? = null
        val wrappedContext = context
        val ladder = strategiesWithRawCapture(url, wrappedContext) { raw -> latestRawJson = raw }
        if (ladder.size == 1) {
            val media = ladder[0].run()
            val hasYtdlpPlan = media.items.any { item -> item.plans.any { it.fetch is FetchPlan.Ytdlp } }
            return ExtractorResolveResult(
                media = media,
                rawInfoJson = if (hasYtdlpPlan) latestRawJson else null,
            )
        }
        val outcome = runStrategies(
            strategies = ladder,
            provider = id,
            includeDegraded = context.allowDegraded,
            isCancelled = context.isCancelled,
        )
        val media = if (outcome.attempts.isNotEmpty()) {
            val mergedMeta = (outcome.media.metadata.orEmpty() + ("extractionStrategy" to JsonPrimitive(outcome.strategy)))
            outcome.media.copy(metadata = mergedMeta)
        } else {
            outcome.media
        }
        val hasYtdlpPlan = media.items.any { item -> item.plans.any { it.fetch is FetchPlan.Ytdlp } }
        return ExtractorResolveResult(
            media = media,
            rawInfoJson = if (hasYtdlpPlan) latestRawJson else null,
        )
    }

    protected open fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> = strategies(url, context)

    protected suspend fun runExtractor(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: ((String?) -> Unit)? = null,
    ): ExtractorResolveResult {
        val parsed = executor.dumpInfo(
            url.toString(),
            YtdlpProbeOptions(
                playlist = wantsPlaylist(url),
                extractorArgs = extractorArgs(url, context),
                extraArgs = extraYtdlpArgs(url, context),
                remoteComponents = remoteComponents(url, context),
                useExtractors = useExtractors(url, context),
                timeoutMs = context.resolveTimeoutMs,
                maxEntries = context.maxItemsPerJob,
                allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
                isCancelled = context.isCancelled,
            ),
        )
        onRawJson?.invoke(parsed.rawJson)
        val media = toResolvedMedia(parsed.info, url, context)
        return ExtractorResolveResult(media = media, rawInfoJson = parsed.rawJson)
    }

    fun toResolvedMedia(
        info: YtdlpInfo,
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        assertNotDrmProtected(info)
        val planOptions = PlanBuildOptions(
            maxFilesizeBytes = context.runtimeConfig.maxFilesizeBytes,
        )
        val allowPrivate = context.runtimeConfig.allowPrivateAddresses

        val entries = collectEntries(info).take(context.maxItemsPerJob)
        val rawItems = entries.mapIndexedNotNull { index, entry ->
            toItem(entry, index, planOptions, allowPrivate)
        }

        val args = extractorArgs(url, context)
        val useExt = useExtractors(url, context)
        val items = if (args.isNotEmpty() || useExt != null) {
            rawItems.map { item ->
                item.copy(
                    plans = item.plans.map { plan ->
                        val ytdlpFetch = plan.fetch as? FetchPlan.Ytdlp
                        if (ytdlpFetch != null) {
                            plan.copy(
                                fetch = ytdlpFetch.copy(
                                    extractorArgs = args.ifEmpty { null },
                                    useExtractors = useExt,
                                ),
                            )
                        } else {
                            plan
                        }
                    },
                )
            }
        } else {
            rawItems
        }

        if (items.isEmpty()) {
            throw seraError(
                SeraErrorCode.MEDIA_UNAVAILABLE,
                message = "No downloadable media was found at that link.",
                hint = "If the post is public, it may use a format this server cannot read.",
                detail = "$id: 0 usable items from ${entries.size} entries",
            )
        }

        val duration = info.duration.asNum() ?: items.firstOrNull()?.duration
        val type = if (items.size > 1) multiItemType(url) else "single"
        val author = info.uploader.asStr()
            ?: info.channel.asStr()
            ?: info.creator.asStr()
            ?: info.uploader_id.asStr()
        val authorUrl = validateProviderUrl(
            info.uploader_url.asStr() ?: info.channel_url.asStr(),
            allowPrivateAddresses = allowPrivate,
        )
        val thumbnail = validateProviderUrl(pickThumbnail(info), allowPrivateAddresses = allowPrivate)
            ?: items.firstNotNullOfOrNull { it.thumbnailUrl }
        val createdAt = parseTimestamp(info)
        val description = info.description.asStr()?.let { truncateText(it, 500) }
        val resolvedUrl = validateProviderUrl(info.webpage_url.asStr(), allowPrivateAddresses = allowPrivate)
            ?: url.toString()
        val title = (info.title.asStr() ?: info.fulltitle.asStr() ?: fallbackTitle(url)).take(500)

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = resolvedUrl,
            type = type,
            title = title,
            description = description,
            author = author?.take(200),
            authorUrl = authorUrl,
            thumbnailUrl = thumbnail,
            duration = duration?.takeIf { it >= 0.0 },
            createdAt = createdAt,
            items = items.take(200),
            metadata = buildMetadata(info),
        )
    }

    protected fun toItem(
        entry: YtdlpInfo,
        index: Int,
        planOptions: PlanBuildOptions,
        allowPrivateAddresses: Boolean = false,
    ): ResolvedItem? {
        val kind = kindOf(entry)
        val formats = toUsableFormats(entryFormats(entry))
        val duration = entry.duration.asNum()?.takeIf { it >= 0.0 }
        val plans = ArrayList<ResolvedPlan>()

        when (kind) {
            "image" -> {
                val directUrl = validateProviderUrl(entry.url.asStr(), allowPrivateAddresses = allowPrivateAddresses)
                plans.addAll(buildImagePlans(entry, directUrl))
            }
            "gif" -> {
                val videoPlans = buildVideoPlans(formats, duration, planOptions)
                plans.addAll(buildGifPlans(true, videoPlans, duration, planOptions))
            }
            "video" -> {
                val videoPlans = buildVideoPlans(formats, duration, planOptions)
                plans.addAll(videoPlans)
                plans.addAll(buildAlternateContainerPlans(videoPlans.firstOrNull()))
                plans.addAll(buildAudioPlans(formats, duration, planOptions))
                val silent = formats.isNotEmpty() && formats.none { it.hasAudio }
                if (treatsSilentShortVideoAsGif() && silent) {
                    plans.addAll(buildGifPlans(false, videoPlans, duration, planOptions))
                }
            }
            "audio" -> {
                plans.addAll(buildAudioPlans(formats, duration, planOptions))
            }
        }

        if (plans.isEmpty()) return null

        val width = entry.width.asInt()?.takeIf { it > 0 } ?: plans.firstNotNullOfOrNull { it.width }
        val height = entry.height.asInt()?.takeIf { it > 0 } ?: plans.firstNotNullOfOrNull { it.height }
        val rawExt = entry.ext.asStr()
        val container = if (rawExt != null) {
            normalizeContainer(rawExt, plans.first().container)
        } else {
            plans.first().container
        }
        val thumbnailUrl = validateProviderUrl(pickThumbnail(entry), allowPrivateAddresses = allowPrivateAddresses)
        val thumbnailFallbackUrl = validateProviderUrl(entry.thumbnail.asStr(), allowPrivateAddresses = allowPrivateAddresses)
        val subtitles = if (kind == "video" || kind == "audio") subtitleTracks(entry).take(100) else emptyList()
        val title = entry.title.asStr()?.take(500)
        val filesize = (entry.filesize.asLong() ?: entry.filesize_approx.asLong())?.takeIf { it >= 0L }
        val sourceId = entry.id.asStr()?.take(200)
        val playlistIndex = entry.playlist_index.asInt()
        val resolvedIndex = if (playlistIndex != null && playlistIndex >= 1) playlistIndex - 1 else index
        val liveStatus = entry.live_status.asStr()
        val isLive = (entry.is_live.asBool() == true) ||
            liveStatus == "is_live" ||
            liveStatus == "is_upcoming"
        val artist = entry.artist.asStr()?.take(200)
        val album = entry.album.asStr()?.take(200)
        val track = entry.track.asStr()?.take(200)
        val tags = if (artist != null || album != null || track != null) {
            MediaTags(artist = artist, album = album, track = track)
        } else {
            null
        }

        return ResolvedItem(
            sourceId = sourceId,
            index = resolvedIndex,
            kind = kind,
            title = title,
            thumbnailUrl = thumbnailUrl,
            thumbnailFallbackUrl = if (thumbnailFallbackUrl != null && thumbnailFallbackUrl != thumbnailUrl) {
                thumbnailFallbackUrl
            } else {
                null
            },
            subtitles = subtitles.ifEmpty { null },
            tags = tags,
            width = width,
            height = height,
            duration = duration,
            container = container,
            filesizeBytes = filesize,
            isLive = if (isLive) true else null,
            plans = ensureRecommendations(plans).take(64),
        )
    }

    protected fun fallbackTitle(url: HttpUrl): String {
        val segment = url.pathSegments.lastOrNull { it.isNotEmpty() } ?: return label
        val decoded = try {
            URLDecoder.decode(segment, StandardCharsets.UTF_8.name())
        } catch (_: Exception) {
            segment
        }
        return decoded.replace(Regex("""[-_]+"""), " ")
    }
}

fun collectEntries(info: YtdlpInfo): List<YtdlpInfo> {
    val entries = info.entries?.filterNotNull()
    if (entries.isNullOrEmpty()) return listOf(info)
    val out = ArrayList<YtdlpInfo>(entries.size)
    for (entry in entries) {
        val nested = entry.entries?.filterNotNull()
        if (!nested.isNullOrEmpty()) {
            out.addAll(nested)
        } else {
            out.add(entry)
        }
    }
    return out.ifEmpty { listOf(info) }
}

fun pickThumbnail(info: YtdlpInfo): String? {
    val direct = info.thumbnail.asStr()
    val candidates = info.thumbnails.orEmpty()
        .filterNotNull()
        .filter { !it.url.isNullOrBlank() }
    if (candidates.isEmpty()) return direct

    fun score(t: YtdlpThumbnail): Double {
        val width = t.width.asNum() ?: 0.0
        val distance = abs(width - 640.0)
        val preference = t.preference.asNum() ?: 0.0
        return preference * 1000.0 - distance
    }
    return candidates.maxByOrNull { score(it) }?.url ?: direct
}

fun parseTimestamp(info: YtdlpInfo): String? {
    val epoch = info.timestamp.asNum() ?: info.release_timestamp.asNum()
    if (epoch != null && epoch.isFinite() && epoch > 0.0 && epoch < 8_640_000_000_000.0) {
        return ISO_FORMATTER.format(Instant.ofEpochMilli((epoch * 1000.0).toLong()))
    }
    val uploadDate = info.upload_date.asStr()
    if (uploadDate != null && Regex("""^\d{8}$""").matches(uploadDate)) {
        return "${uploadDate.substring(0, 4)}-${uploadDate.substring(4, 6)}-${uploadDate.substring(6, 8)}T00:00:00.000Z"
    }
    return null
}

fun buildMetadata(info: YtdlpInfo): Map<String, JsonPrimitive>? {
    val metadata = LinkedHashMap<String, JsonPrimitive>()
    val views = info.view_count.asLong()
    val likes = info.like_count.asLong()
    if (views != null && views != 0L) metadata["viewCount"] = JsonPrimitive(views)
    if (likes != null && likes != 0L) metadata["likeCount"] = JsonPrimitive(likes)
    if (info.was_live.asBool() == true) metadata["wasLive"] = JsonPrimitive(true)
    val extractor = info.extractor_key.asStr() ?: info.extractor.asStr()
    if (extractor != null) metadata["extractor"] = JsonPrimitive(extractor)
    return if (metadata.isEmpty()) null else metadata
}
