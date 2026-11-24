package dev.sera.node.extractor

import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SeraJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlin.math.PI
import kotlin.math.roundToLong

private val TWITTER_PHOTO_VIDEO_SUFFIX = Regex("""/(photo|video)/\d+/?$""", RegexOption.IGNORE_CASE)
private val TWITTER_STATUS_PATH = Regex("""^/(?:i/(?:web/)?|[^/]+/)status/\d+""", RegexOption.IGNORE_CASE)
private val TWEET_ID_REGEX = Regex("""/status(?:es)?/(\d+)""")
private val VARIANT_SIZE_REGEX = Regex("""/(\d{2,4})x(\d{2,4})/""")
private val URL_EXT_REGEX = Regex("""\.([a-z0-9]{2,5})(?:[?#]|$)""", RegexOption.IGNORE_CASE)
private val SOURCE_ID_FROM_URL_REGEX = Regex("""/([^/?#]+)\.[a-z0-9]+(?:[?#]|$)""", RegexOption.IGNORE_CASE)
private val META_REFRESH_REGEX = Regex("""content=["']\d+;\s*url=([^"'>]+)["']""", RegexOption.IGNORE_CASE)
private val LOCATION_REPLACE_REGEX = Regex("""location\.replace\(["']([^"']+)["']\)""", RegexOption.IGNORE_CASE)

private val DIRECT_TWITTER_HOSTS = listOf(
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "vxtwitter.com",
    "fxtwitter.com",
    "fixupx.com",
    "fixvx.com",
    "twittpr.com",
)

@Serializable
data class SyndicatedTweetVariant(
    val bitrate: Double? = null,
    val content_type: String? = null,
    val url: String? = null,
)

@Serializable
data class SyndicatedTweetVideoInfo(
    val duration_millis: Double? = null,
    val variants: List<SyndicatedTweetVariant>? = null,
)

@Serializable
data class SyndicatedTweetOriginalInfo(
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class SyndicatedTweetMedia(
    val type: String? = null,
    val media_url_https: String? = null,
    val ext_alt_text: String? = null,
    val original_info: SyndicatedTweetOriginalInfo? = null,
    val video_info: SyndicatedTweetVideoInfo? = null,
)

@Serializable
data class SyndicatedTweetUser(
    val name: String? = null,
    val screen_name: String? = null,
)

@Serializable
data class SyndicatedTweet(
    val id_str: String? = null,
    val text: String? = null,
    val possibly_sensitive: Boolean? = null,
    val user: SyndicatedTweetUser? = null,
    val mediaDetails: List<SyndicatedTweetMedia>? = null,
    val quoted_tweet: SyndicatedTweet? = null,
)

@Serializable
data class FxTweetVariant(
    val url: String? = null,
    val bitrate: Double? = null,
    val content_type: String? = null,
)

@Serializable
data class FxTweetMediaItem(
    val type: String? = null,
    val id: String? = null,
    val url: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val altText: String? = null,
    val description: String? = null,
    val thumbnail_url: String? = null,
    val duration: Double? = null,
    val variants: List<FxTweetVariant>? = null,
)

@Serializable
data class FxTweetMediaContainer(
    val all: List<FxTweetMediaItem>? = null,
    val photos: List<FxTweetMediaItem>? = null,
    val videos: List<FxTweetMediaItem>? = null,
)

@Serializable
data class FxTweetAuthor(
    val name: String? = null,
    val screen_name: String? = null,
)

@Serializable
data class FxTweet(
    val text: String? = null,
    val author: FxTweetAuthor? = null,
    val media: FxTweetMediaContainer? = null,
)

@Serializable
data class FxTweetResponse(
    val code: Int? = null,
    val message: String? = null,
    val tweet: FxTweet? = null,
)

private data class NormalizedTweetVariant(
    val url: String,
    val bitrate: Double? = null,
    val width: Int? = null,
    val height: Int? = null,
)

private data class NormalizedTweetMedia(
    val source: String,
    val isPhoto: Boolean,
    val isGif: Boolean,
    val width: Int? = null,
    val height: Int? = null,
    val alt: String? = null,
    val sourceId: String,
    val thumbnailUrl: String? = null,
    val durationSeconds: Double? = null,
    val variants: List<NormalizedTweetVariant>,
)

class TwitterExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "twitter"
    override val label: String = "X"
    override val hosts: List<String> = TWITTER_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        if (stripWww(url.host.lowercase()) == "t.co") return normalizeUrl(url)
        val cleanedPath = url.encodedPath.replace(TWITTER_PHOTO_VIDEO_SUFFIX, "").ifEmpty { "/" }
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host("x.com")
                .encodedPath(cleanedPath)
                .build(),
        )
    }

    override fun treatsSilentShortVideoAsGif(): Boolean = true

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val target = if (stripWww(url.host.lowercase()) == "t.co") {
            expandShortLink(url, context)
        } else {
            url
        }
        return super.resolve(target, context)
    }

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> = listOf(
        ExtractionStrategy(
            id = "syndication",
            label = "the endpoint X's embed widget calls",
            run = { viaSyndication(url, context) },
        ),
        ExtractionStrategy(
            id = "fxtwitter",
            label = "the FixTweet API",
            run = { viaFxTwitter(url, context) },
        ),
        ExtractionStrategy(
            id = "ytdlp",
            label = "the extractor",
            run = { runExtractor(url, context, onRawJson).media },
        ),
    )

    private suspend fun expandShortLink(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): HttpUrl {
        val response = httpFetcher.fetchNoFollow(
            url = url,
            maxBytes = 64L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            userAgent = "curl/8.7.1",
            isCancelled = context.isCancelled,
        )
        var location = response.headers["location"]
        if (location.isNullOrBlank() && response.status == 200) {
            val html = response.body
            val match = META_REFRESH_REGEX.find(html) ?: LOCATION_REPLACE_REGEX.find(html)
            val extracted = match?.groupValues?.get(1)
            if (!extracted.isNullOrBlank()) {
                location = decodeHtmlEntities(extracted.replace("\\/", "/").replace("\\", ""))
            }
        }
        if (location.isNullOrBlank() && (response.status < 300 || response.status >= 400)) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That short link did not redirect.",
                detail = "t.co: returned HTTP ${response.status}",
            )
        }
        if (location.isNullOrBlank()) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That short link has no redirect location.",
                detail = "t.co: missing location header",
            )
        }
        val resolved = url.resolve(location)
            ?: throw seraError(SeraErrorCode.INVALID_URL, detail = "t.co: malformed redirect location")
        if (resolved.scheme != "http" && resolved.scheme != "https") {
            throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "t.co redirect to ${resolved.scheme}:")
        }
        val parsed = parseUserUrl(
            resolved.toString(),
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
        ).url
        val host = parsed.host.lowercase()
        val isTwitterHost = DIRECT_TWITTER_HOSTS.any { h -> host == h || host.endsWith(".$h") }
        val isStatus = TWITTER_STATUS_PATH.containsMatchIn(parsed.encodedPath)
        if (!isTwitterHost || !isStatus) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That short link does not point to an X post.",
                detail = "t.co: target ${parsed.host}${parsed.encodedPath} is not an X status",
            )
        }
        return normalize(parsed)
    }

    private suspend fun viaSyndication(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val tweet = try {
            readSyndicatedTweet(url, context)
        } catch (error: Throwable) {
            if (context.isCancelled()) throw seraError(SeraErrorCode.CANCELLED, cause = error)
            if (error is SeraException && (error.code == SeraErrorCode.CANCELLED || error.code == SeraErrorCode.BLOCKED_ADDRESS)) {
                throw error
            }
            null
        }
        val primaryMedia = usableSyndicatedMedia(tweet)
        val source = if (primaryMedia.isNotEmpty()) tweet else (tweet?.quoted_tweet ?: tweet)
        val media = usableSyndicatedMedia(source)

        if (media.isNotEmpty() && source != null) {
            return fromSyndicatedEmbed(url, source, media, context)
        }
        if (tweet != null) {
            if (tweet.possibly_sensitive == true) {
                throw seraError(
                    SeraErrorCode.UNSUPPORTED_SOURCE,
                    detail = "twitter: sensitive post attachments not served by syndication",
                )
            }
            throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "Syndication returned no media details")
        }
        throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "twitter: the syndication endpoint did not answer")
    }

    private suspend fun readSyndicatedTweet(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): SyndicatedTweet? {
        val id = TWEET_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1) ?: return null
        val token = computeSyndicationToken(id)
        val endpoint = "https://cdn.syndication.twimg.com/tweet-result".toHttpUrlOrNull()!!
            .newBuilder()
            .addQueryParameter("id", id)
            .addQueryParameter("token", token)
            .addQueryParameter("lang", "en")
            .build()
        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 2L * 1024L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        val parsed = runCatching {
            SeraJson.decodeFromString(SyndicatedTweet.serializer(), response.body)
        }.getOrNull()
        return if (!parsed?.id_str.isNullOrBlank()) parsed else null
    }

    private fun fromSyndicatedEmbed(
        url: HttpUrl,
        tweet: SyndicatedTweet,
        media: List<SyndicatedTweetMedia>,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val author = nonEmpty(tweet.user?.name) ?: nonEmpty(tweet.user?.screen_name)
        val text = nonEmpty(tweet.text)
        val allowPrivate = context.runtimeConfig.allowPrivateAddresses

        val items = media
            .take(context.maxItemsPerJob)
            .mapIndexedNotNull { index, entry -> toSyndicatedItem(entry, index, allowPrivate) }

        if (items.isEmpty()) {
            throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "twitter: no usable direct attachment")
        }

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = if (items.size > 1) "collection" else "single",
            title = if (text != null) truncateText(text, 200) else "Post by ${author ?: "an X account"}",
            description = text?.let { truncateText(it, 500) },
            author = author?.take(200),
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf(
                "attachments" to JsonPrimitive(media.size.toString()),
                "source" to JsonPrimitive("syndication"),
            ),
        )
    }

    private suspend fun viaFxTwitter(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val id = TWEET_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1)
            ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "fxtwitter: no tweet id")
        val endpoint = "https://api.fxtwitter.com/status/$id".toHttpUrlOrNull()!!
        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 4L * 1024L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        val parsed = try {
            SeraJson.decodeFromString(FxTweetResponse.serializer(), response.body)
        } catch (cause: Exception) {
            throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "fxtwitter: invalid json", cause = cause)
        }
        if (parsed.code == 404) {
            throw seraError(
                SeraErrorCode.MEDIA_UNAVAILABLE,
                message = "That post is no longer available.",
                detail = "fxtwitter: returned 404",
            )
        }
        val tweet = parsed.tweet
            ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "fxtwitter: no tweet in response")

        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        val rawList = tweet.media?.all ?: tweet.media?.photos ?: tweet.media?.videos ?: emptyList()
        val media = rawList.filter { item ->
            validateTwitterMediaUrl(item.url, allowPrivate) != null
        }

        if (media.isEmpty()) {
            throw seraError(
                SeraErrorCode.MEDIA_UNAVAILABLE,
                message = "That post has no media to download.",
                detail = "fxtwitter: post contains no media",
            )
        }

        val author = nonEmpty(tweet.author?.name) ?: nonEmpty(tweet.author?.screen_name)
        val text = nonEmpty(tweet.text)

        val items = media
            .take(context.maxItemsPerJob)
            .mapIndexedNotNull { index, entry -> toFxItem(entry, index, allowPrivate) }

        if (items.isEmpty()) {
            throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "fxtwitter: no usable attachments")
        }

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = if (items.size > 1) "collection" else "single",
            title = if (text != null) truncateText(text, 200) else "Post by ${author ?: "an X account"}",
            description = text?.let { truncateText(it, 500) },
            author = author?.take(200),
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf(
                "attachments" to JsonPrimitive(media.size.toString()),
                "source" to JsonPrimitive("fxtwitter"),
            ),
        )
    }
}

private fun computeSyndicationToken(tweetId: String): String {
    val num = tweetId.toDoubleOrNull() ?: return "a"
    val value = (num / 1e15) * PI
    val raw = java.math.BigDecimal.valueOf(value).toPlainString()
    return raw.filter { it in '1'..'9' }
}

private fun usableSyndicatedMedia(tweet: SyndicatedTweet?): List<SyndicatedTweetMedia> =
    tweet?.mediaDetails.orEmpty().filter { entry ->
        val u = nonEmpty(entry.media_url_https)
        u != null && u.startsWith("https://")
    }

private fun validateTwitterMediaUrl(raw: String?, allowPrivateAddresses: Boolean): String? {
    if (raw == null || !raw.startsWith("https://")) return null
    return validateProviderUrl(raw, allowPrivateAddresses = allowPrivateAddresses)
}

private fun sizeFromVariantUrl(url: String): Pair<Int?, Int?> {
    val match = VARIANT_SIZE_REGEX.find(url) ?: return null to null
    return match.groupValues[1].toIntOrNull() to match.groupValues[2].toIntOrNull()
}

private fun originalPhotoUrl(url: String): String? {
    val parsed = url.toHttpUrlOrNull() ?: return null
    if (!parsed.isHttps) return null
    return parsed.newBuilder().setQueryParameter("name", "orig").build().toString()
}

private fun twitterContainerFor(url: String): String {
    val ext = URL_EXT_REGEX.find(url)?.groupValues?.get(1)?.lowercase()
    return when (ext) {
        "jpeg", "jpg" -> "jpg"
        "png", "webp", "gif" -> ext
        else -> "mp4"
    }
}

private fun buildTwitterMediaItem(
    normalized: NormalizedTweetMedia,
    index: Int,
    allowPrivateAddresses: Boolean,
): ResolvedItem? {
    if (normalized.isPhoto) {
        val rawPhoto = originalPhotoUrl(normalized.source)
        val url = validateTwitterMediaUrl(rawPhoto, allowPrivateAddresses) ?: return null
        val container = twitterContainerFor(normalized.source)
        val dimText = if (normalized.width != null && normalized.height != null) {
            "${normalized.width} \u00d7 ${normalized.height}"
        } else {
            null
        }
        return ResolvedItem(
            sourceId = normalized.sourceId,
            index = index,
            kind = "image",
            title = normalized.alt?.let { truncateText(it, 120) } ?: "Image ${index + 1}",
            thumbnailUrl = normalized.thumbnailUrl,
            width = normalized.width,
            height = normalized.height,
            container = container,
            plans = ensureRecommendations(
                listOf(
                    ResolvedPlan(
                        kind = "image",
                        container = container,
                        label = "Original",
                        detail = joinDetail(container.uppercase(), dimText),
                        width = normalized.width,
                        height = normalized.height,
                        requiresConversion = false,
                        recommended = true,
                        fetch = FetchPlan.Direct(url = url),
                    ),
                ),
            ),
        )
    }

    if (normalized.variants.isEmpty()) return null

    val seenLabels = HashSet<String>()
    val plans = ArrayList<ResolvedPlan>()
    for (variant in normalized.variants) {
        val itemWidth = variant.width ?: normalized.width
        val itemHeight = variant.height ?: normalized.height
        val label = if (normalized.isGif) "Original" else qualityLabel(itemHeight, itemWidth)
        if (!seenLabels.add(label)) continue
        val approxBytes = if (variant.bitrate != null && normalized.durationSeconds != null) {
            ((variant.bitrate / 8.0) * normalized.durationSeconds).roundToLong().takeIf { it > 0L }
        } else {
            null
        }
        plans.add(
            ResolvedPlan(
                kind = if (normalized.isGif) "gif" else "video",
                container = "mp4",
                label = label,
                detail = joinDetail(
                    "MP4 \u00b7 H.264",
                    approxBytes?.let { "~${formatBytes(it.toDouble())}" },
                ),
                width = itemWidth,
                height = itemHeight,
                filesizeBytes = approxBytes,
                filesizeIsApproximate = if (approxBytes != null) true else null,
                requiresConversion = false,
                recommended = plans.isEmpty(),
                fetch = FetchPlan.Direct(url = variant.url),
            ),
        )
    }

    val best = normalized.variants.first().url
    if (normalized.isGif) {
        if (normalized.durationSeconds == null || normalized.durationSeconds <= 30.0) {
            plans.add(
                ResolvedPlan(
                    kind = "gif",
                    container = "gif",
                    label = "GIF",
                    detail = "Converted from the silent video X stores",
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Direct(url = best),
                    convert = ConversionSpec.Gif(),
                ),
            )
        }
    } else {
        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = "mp3",
                label = "MP3",
                detail = "320 kbps \u00b7 extracted",
                audioBitrateKbps = 320.0,
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = best),
                convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
            ),
        )
        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = "m4a",
                label = "M4A",
                detail = "Original quality \u00b7 AAC",
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = best),
                convert = ConversionSpec.Audio(container = "m4a"),
            ),
        )
    }

    val (bestWidth, bestHeight) = sizeFromVariantUrl(best)
    val itemWidth = bestWidth ?: normalized.width
    val itemHeight = bestHeight ?: normalized.height
    return ResolvedItem(
        sourceId = normalized.sourceId,
        index = index,
        kind = if (normalized.isGif) "gif" else "video",
        title = normalized.alt?.let { truncateText(it, 120) }
            ?: if (normalized.isGif) "GIF ${index + 1}" else "Video ${index + 1}",
        thumbnailUrl = normalized.thumbnailUrl,
        width = itemWidth,
        height = itemHeight,
        duration = normalized.durationSeconds,
        container = "mp4",
        plans = ensureRecommendations(plans),
    )
}

private fun toSyndicatedItem(
    media: SyndicatedTweetMedia,
    index: Int,
    allowPrivateAddresses: Boolean,
): ResolvedItem? {
    val source = validateTwitterMediaUrl(media.media_url_https, allowPrivateAddresses) ?: return null
    val width = media.original_info?.width?.takeIf { it > 0 }
    val height = media.original_info?.height?.takeIf { it > 0 }
    val alt = nonEmpty(media.ext_alt_text)
    val sourceId = stableSourceId(SOURCE_ID_FROM_URL_REGEX.find(source)?.groupValues?.get(1) ?: index.toString())
    val variants = media.video_info?.variants.orEmpty()
        .filter { it.content_type == "video/mp4" }
        .mapNotNull { variant ->
            val u = validateTwitterMediaUrl(variant.url, allowPrivateAddresses) ?: return@mapNotNull null
            val (w, h) = sizeFromVariantUrl(u)
            NormalizedTweetVariant(
                url = u,
                bitrate = variant.bitrate,
                width = w?.takeIf { it > 0 },
                height = h?.takeIf { it > 0 },
            )
        }
        .sortedByDescending { it.bitrate ?: 0.0 }
    val durationSeconds = media.video_info?.duration_millis?.let { it / 1000.0 }?.takeIf { it.isFinite() && it >= 0.0 }
    return buildTwitterMediaItem(
        normalized = NormalizedTweetMedia(
            source = source,
            isPhoto = media.type == "photo",
            isGif = media.type == "animated_gif",
            width = width,
            height = height,
            alt = alt,
            sourceId = sourceId,
            thumbnailUrl = source,
            durationSeconds = durationSeconds,
            variants = variants,
        ),
        index = index,
        allowPrivateAddresses = allowPrivateAddresses,
    )
}

private fun toFxItem(
    media: FxTweetMediaItem,
    index: Int,
    allowPrivateAddresses: Boolean,
): ResolvedItem? {
    val source = validateTwitterMediaUrl(media.url, allowPrivateAddresses) ?: return null
    val width = media.width?.takeIf { it > 0 }
    val height = media.height?.takeIf { it > 0 }
    val alt = nonEmpty(media.altText) ?: nonEmpty(media.description)
    val sourceId = stableSourceId(media.id ?: SOURCE_ID_FROM_URL_REGEX.find(source)?.groupValues?.get(1) ?: index.toString())
    val rawVariants = media.variants.orEmpty()
        .filter { it.content_type == "video/mp4" }
        .mapNotNull { variant ->
            val u = validateTwitterMediaUrl(variant.url, allowPrivateAddresses) ?: return@mapNotNull null
            val (w, h) = sizeFromVariantUrl(u)
            NormalizedTweetVariant(
                url = u,
                bitrate = variant.bitrate,
                width = w?.takeIf { it > 0 },
                height = h?.takeIf { it > 0 },
            )
        }
        .sortedByDescending { it.bitrate ?: 0.0 }
    val variants = if (rawVariants.isNotEmpty()) {
        rawVariants
    } else {
        listOf(NormalizedTweetVariant(url = source, width = width, height = height))
    }
    val thumbnailUrl = validateTwitterMediaUrl(media.thumbnail_url, allowPrivateAddresses)
        ?: if (media.type == "photo") source else null
    return buildTwitterMediaItem(
        normalized = NormalizedTweetMedia(
            source = source,
            isPhoto = media.type == "photo",
            isGif = media.type == "gif",
            width = width,
            height = height,
            alt = alt,
            sourceId = sourceId,
            thumbnailUrl = thumbnailUrl,
            durationSeconds = media.duration?.takeIf { it.isFinite() && it >= 0.0 },
            variants = variants,
        ),
        index = index,
        allowPrivateAddresses = allowPrivateAddresses,
    )
}
