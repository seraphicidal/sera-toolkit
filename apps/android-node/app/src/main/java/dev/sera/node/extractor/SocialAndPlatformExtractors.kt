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

private val TIKTOK_PHOTO_PATH_REGEX = Regex("""^/(@[^/]+)/photo/(\d+)""")
private val VIMEO_ID_REGEX = Regex(
    """^/(?:video/|channels/[^/]+/|groups/[^/]+/videos/)?(\d{6,})(?:/([0-9a-z]+))?/?$""",
    RegexOption.IGNORE_CASE,
)
private val SNAPCHAT_PUBLIC_PATH_REGEX = Regex("""^/(spotlight|add|p|t)/""")
private val SNAPCHAT_CREATOR_SPOTLIGHT_REGEX = Regex("""^/@[^/]+/spotlight/([^/]+)""")
private val THREADS_USER_POST_REGEX = Regex("""^/@([A-Za-z0-9._]+)/post/([A-Za-z0-9_-]+)""")
private val THREADS_SHORT_POST_REGEX = Regex("""^/t/([A-Za-z0-9_-]+)""")
private val THREADS_IMAGE_PATH_REGEX = Regex("""/t51\.\d+-15/""")
private val VIDEO_TAG_REGEX = Regex("""<video\b([^>]*)>(.*?)</video>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val SOURCE_SRC_REGEX = Regex("""<source\b[^>]*\bsrc=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val IMG_TAG_REGEX = Regex("""<img\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val SRC_ATTR_REGEX = Regex("""\bsrc=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val POSTER_ATTR_REGEX = Regex("""\bposter=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val BODY_TEXT_CONTAINER_REGEX = Regex(
    """<div\b[^>]*\bclass=["'][^"']*BodyTextContainer[^"']*["'][^>]*>(.*?)</div>""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)
private val BLUESKY_SUFFIX_EXT_REGEX = Regex("""@([a-z0-9]+)(?:[?#]|$)""", RegexOption.IGNORE_CASE)
private val MASTODON_STATUS_ID_REGEX = Regex("""(?:^/@[^/]+/|^/users/[^/]+/statuses/)(\d+)/?$""")
private val HTML_BR_P_REGEX = Regex("""<(?:br\s*/?|/p)>""", RegexOption.IGNORE_CASE)
private val HTML_TAG_REGEX = Regex("""<[^>]+>""")

const val THREADS_EMBED_AGENT = "SERA.toolkit (+https://github.com/seraphicidal/sera-toolkit)"

class TiktokExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "tiktok"
    override val label: String = "TikTok"
    override val hosts: List<String> = TIKTOK_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val rawHost = url.host.lowercase()
        val targetHost = if (rawHost == "vm.tiktok.com" || rawHost == "vt.tiktok.com") rawHost else "www.tiktok.com"
        val updatedPath = TIKTOK_PHOTO_PATH_REGEX.replace(url.encodedPath) { m ->
            "/${m.groupValues[1]}/video/${m.groupValues[2]}"
        }
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host(targetHost)
                .encodedPath(updatedPath)
                .build(),
        )
    }

    override fun wantsPlaylist(url: HttpUrl): Boolean = true

    override fun treatsSilentShortVideoAsGif(): Boolean = true
}

class TwitchExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "twitch"
    override val label: String = "Twitch"
    override val hosts: List<String> = TWITCH_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val cleanHost = stripWww(url.host.lowercase())
        val targetHost = if (cleanHost == "m.twitch.tv") "www.twitch.tv" else url.host
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host(targetHost)
                .build(),
        )
    }

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val segments = url.pathSegments.filter { it.isNotEmpty() }
        val clipIndex = segments.indexOf("clip")
        val isClip = (stripWww(url.host.lowercase()) == "clips.twitch.tv" && segments.isNotEmpty()) ||
            (clipIndex >= 0 && segments.getOrNull(clipIndex + 1) != null)
        val isVod = segments.firstOrNull() == "videos" && segments.getOrNull(1) != null
        if (!isClip && !isVod) {
            throw seraError(
                SeraErrorCode.LIVE_IN_PROGRESS,
                message = "Only Twitch clips and past broadcasts can be downloaded.",
                hint = "Use a link to a clip or a VOD rather than a channel.",
                detail = "twitch: ${segments.size} path segments, neither clip nor vod",
            )
        }
        return super.resolve(url, context)
    }
}

class VimeoExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "vimeo"
    override val label: String = "Vimeo"
    override val hosts: List<String> = VIMEO_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val httpsUrl = url.newBuilder().scheme("https").build()
        if (httpsUrl.host.lowercase() == "player.vimeo.com") return normalizeUrl(httpsUrl)
        val match = VIMEO_ID_REGEX.find(httpsUrl.encodedPath) ?: return normalizeUrl(httpsUrl)
        val videoId = match.groupValues[1]
        val hash = match.groupValues[2].takeIf { it.isNotEmpty() } ?: httpsUrl.queryParameter("h")
        val embedBuilder = "https://player.vimeo.com/video/$videoId".toHttpUrlOrNull()!!.newBuilder()
        if (!hash.isNullOrBlank()) embedBuilder.setQueryParameter("h", hash)
        return normalizeUrl(embedBuilder.build())
    }
}

class SoundcloudExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "soundcloud"
    override val label: String = "SoundCloud"
    override val hosts: List<String> = SOUNDCLOUD_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val cleanHost = stripWww(url.host.lowercase())
        val targetHost = if (cleanHost == "m.soundcloud.com") "soundcloud.com" else url.host
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host(targetHost)
                .build(),
        )
    }

    override fun wantsPlaylist(url: HttpUrl): Boolean = url.encodedPath.contains("/sets/")

    override fun multiItemType(url: HttpUrl): String =
        if (wantsPlaylist(url)) "playlist" else "collection"
}

class FacebookExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "facebook"
    override val label: String = "Facebook"
    override val hosts: List<String> = FACEBOOK_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val cleanHost = stripWww(url.host.lowercase())
        val targetHost = if (cleanHost == "m.facebook.com" || cleanHost == "web.facebook.com" || cleanHost == "facebook.com") {
            "www.facebook.com"
        } else {
            url.host
        }
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host(targetHost)
                .build(),
        )
    }
}

class PinterestExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "pinterest"
    override val label: String = "Pinterest"
    override val hosts: List<String> = PINTEREST_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl =
        normalizeUrl(url.newBuilder().scheme("https").build())
}

class BandcampExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "bandcamp"
    override val label: String = "Bandcamp"
    override val hosts: List<String> = BANDCAMP_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun wantsPlaylist(url: HttpUrl): Boolean = url.encodedPath.startsWith("/album/")

    override fun multiItemType(url: HttpUrl): String =
        if (wantsPlaylist(url)) "playlist" else "collection"
}

class DailymotionExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "dailymotion"
    override val label: String = "Dailymotion"
    override val hosts: List<String> = DAILYMOTION_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val httpsUrl = url.newBuilder().scheme("https").build()
        if (stripWww(httpsUrl.host.lowercase()) == "dai.ly") {
            val id = httpsUrl.pathSegments.firstOrNull { it.isNotEmpty() }
            if (id != null) {
                val target = "https://www.dailymotion.com/video/".toHttpUrlOrNull()!!
                    .newBuilder()
                    .addPathSegment(id)
                    .build()
                return normalizeUrl(target)
            }
        }
        return normalizeUrl(httpsUrl)
    }
}

class TumblrExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "tumblr"
    override val label: String = "Tumblr"
    override val hosts: List<String> = TUMBLR_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun wantsPlaylist(url: HttpUrl): Boolean = true
}

class SnapchatExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "snapchat"
    override val label: String = "Snapchat"
    override val hosts: List<String> = SNAPCHAT_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val spotlight = SNAPCHAT_CREATOR_SPOTLIGHT_REGEX.find(url.encodedPath)?.groupValues?.get(1)
        val builder = url.newBuilder().scheme("https")
        if (spotlight != null) {
            builder.encodedPath("/spotlight/$spotlight")
        }
        return normalizeUrl(builder.build())
    }

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val isShortHost = stripWww(url.host.lowercase()) == "t.snapchat.com"
        val isPublic = SNAPCHAT_PUBLIC_PATH_REGEX.containsMatchIn(url.encodedPath) ||
            (isShortHost && url.encodedPath.length > 1)
        if (!isPublic) {
            throw seraError(
                SeraErrorCode.PRIVATE_CONTENT,
                message = "Only public Snapchat Spotlight posts can be processed.",
                detail = "snapchat: path is not a public surface",
            )
        }
        return super.resolve(url, context)
    }
}

data class ThreadsPostRef(
    val code: String,
    val user: String? = null,
)

data class ThreadsMediaEntry(
    val kind: String,
    val url: String,
    val poster: String? = null,
)

data class ThreadsEmbedResult(
    val media: List<ThreadsMediaEntry>,
    val text: String? = null,
)

fun threadsPostRefFrom(url: HttpUrl): ThreadsPostRef? {
    val post = THREADS_USER_POST_REGEX.find(url.encodedPath)
    if (post != null) {
        return ThreadsPostRef(code = post.groupValues[2], user = post.groupValues[1])
    }
    val short = THREADS_SHORT_POST_REGEX.find(url.encodedPath)
    return short?.let { ThreadsPostRef(code = it.groupValues[1]) }
}

private fun threadsMediaUrl(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val decoded = decodeHtmlEntities(raw)
    val parsed = decoded.toHttpUrlOrNull() ?: return null
    if (
        !parsed.isHttps ||
        parsed.encodedUsername.isNotEmpty() ||
        parsed.encodedPassword.isNotEmpty() ||
        parsed.port != 443 ||
        !hostMatchesAny(parsed.host, DEFAULT_INSTAGRAM_CDN_HOSTS)
    ) {
        return null
    }
    return parsed.toString()
}

fun parseThreadsEmbedHtml(html: String): ThreadsEmbedResult? {
    val marker = html.indexOf("OuterContainerFull")
    if (marker < 0) return null
    val start = html.lastIndexOf("<div", marker).let { if (it < 0) marker else it }
    val slice = html.substring(start)
    val end = slice.indexOf("PostDateContainer")
    val postHtml = if (end < 0) slice else slice.substring(0, end)

    val media = ArrayList<ThreadsMediaEntry>()
    val seen = HashSet<String>()

    data class LocatedMedia(val offset: Int, val entry: ThreadsMediaEntry)
    val located = ArrayList<LocatedMedia>()

    for (videoMatch in VIDEO_TAG_REGEX.findAll(postHtml)) {
        val attrs = videoMatch.groupValues[1]
        val inner = videoMatch.groupValues[2]
        val sourceSrc = SOURCE_SRC_REGEX.find(inner)?.groupValues?.get(1)
            ?: SRC_ATTR_REGEX.find(attrs)?.groupValues?.get(1)
        val url = threadsMediaUrl(sourceSrc) ?: continue
        val poster = threadsMediaUrl(POSTER_ATTR_REGEX.find(attrs)?.groupValues?.get(1))
        located.add(LocatedMedia(videoMatch.range.first, ThreadsMediaEntry(kind = "video", url = url, poster = poster)))
    }

    for (imgMatch in IMG_TAG_REGEX.findAll(postHtml)) {
        val attrs = imgMatch.groupValues[1]
        val url = threadsMediaUrl(SRC_ATTR_REGEX.find(attrs)?.groupValues?.get(1)) ?: continue
        val parsed = url.toHttpUrlOrNull() ?: continue
        if (!THREADS_IMAGE_PATH_REGEX.containsMatchIn(parsed.encodedPath)) continue
        located.add(LocatedMedia(imgMatch.range.first, ThreadsMediaEntry(kind = "image", url = url)))
    }

    for (item in located.sortedBy { it.offset }) {
        if (seen.add(item.entry.url)) {
            media.add(item.entry)
        }
    }

    val bodyRaw = BODY_TEXT_CONTAINER_REGEX.find(postHtml)?.groupValues?.get(1)
    val text = bodyRaw?.let { raw ->
        decodeHtmlEntities(
            raw.replace(HTML_BR_P_REGEX, " ").replace(HTML_TAG_REGEX, ""),
        ).replace(Regex("""\s+"""), " ").trim().takeIf { it.isNotEmpty() }
    }

    return ThreadsEmbedResult(media = media, text = text)
}

class ThreadsExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "threads"
    override val label: String = "Threads"
    override val hosts: List<String> = THREADS_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl =
        normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host("www.threads.com")
                .build(),
        )

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> = listOf(
        ExtractionStrategy(
            id = "embed",
            label = "the public embed",
            run = { viaEmbed(url, context) },
        ),
        ExtractionStrategy(
            id = "ytdlp",
            label = "the extractor",
            run = { runExtractor(url, context, onRawJson).media },
        ),
    )

    private suspend fun viaEmbed(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val ref = threadsPostRefFrom(url)
            ?: throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That does not look like a Threads post.",
                hint = "Use the link to a single post.",
                detail = "threads: no post code in ${url.encodedPath}",
            )
        val embedPath = if (ref.user != null) "/@${ref.user}/post/${ref.code}/embed" else "/t/${ref.code}/embed"
        val embedUrl = "https://www.threads.com$embedPath".toHttpUrlOrNull()!!
        val response = httpFetcher.fetchText(
            url = embedUrl,
            maxBytes = 2L * 1024L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            userAgent = THREADS_EMBED_AGENT,
            isCancelled = context.isCancelled,
        )
        val embed = parseThreadsEmbedHtml(response.body)
            ?: throw seraError(
                SeraErrorCode.MEDIA_UNAVAILABLE,
                message = "That post is not available.",
                hint = "It may have been deleted, or its author may have limited who can see it.",
                detail = "threads: the embed showed no post",
            )
        if (embed.media.isEmpty()) {
            throw seraError(
                SeraErrorCode.MEDIA_UNAVAILABLE,
                message = "That post has no media to download.",
                detail = "threads: the post has no photo or video",
            )
        }
        val items = embed.media.take(context.maxItemsPerJob).mapIndexed { index, entry ->
            if (entry.kind == "video") threadsVideoItem(entry, index) else threadsImageItem(entry, index)
        }
        val author = ref.user?.let { "@$it" }
        val text = nonEmpty(embed.text)
        val canonicalUrl = if (ref.user != null) {
            "https://www.threads.com/@${ref.user}/post/${ref.code}"
        } else {
            "https://www.threads.com/t/${ref.code}"
        }
        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = canonicalUrl,
            type = if (items.size > 1) "collection" else "single",
            title = text?.let { truncateText(it, 200) } ?: "Post by ${author ?: "a Threads account"}",
            description = text?.let { truncateText(it, 500) },
            author = author,
            authorUrl = author?.let { "https://www.threads.com/$it" },
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf(
                "source" to JsonPrimitive("embed"),
                "items" to JsonPrimitive(items.size.toString()),
            ),
        )
    }

    private fun threadsVideoItem(entry: ThreadsMediaEntry, index: Int): ResolvedItem {
        val parsed = entry.url.toHttpUrlOrNull()
        val sourceId = parsed?.pathSegments?.lastOrNull { it.isNotEmpty() } ?: index.toString()
        val plans = listOf(
            ResolvedPlan(
                kind = "video",
                container = "mp4",
                label = "Original",
                detail = "MP4 \u00b7 as posted",
                requiresConversion = false,
                recommended = true,
                fetch = FetchPlan.Direct(url = entry.url),
            ),
            ResolvedPlan(
                kind = "audio",
                container = "mp3",
                label = "MP3",
                detail = "192 kbps \u00b7 extracted",
                audioBitrateKbps = 192.0,
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = entry.url),
                convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 192),
            ),
        )
        return ResolvedItem(
            sourceId = sourceId,
            index = index,
            kind = "video",
            title = "Video ${index + 1}",
            thumbnailUrl = entry.poster,
            container = "mp4",
            plans = ensureRecommendations(plans),
        )
    }

    private fun threadsImageItem(entry: ThreadsMediaEntry, index: Int): ResolvedItem {
        val parsed = entry.url.toHttpUrlOrNull()
        val sourceId = parsed?.pathSegments?.lastOrNull { it.isNotEmpty() } ?: index.toString()
        val ext = parsed?.let { urlExtension(it) } ?: "jpg"
        val container = normalizeContainer(ext, "jpg")
        return ResolvedItem(
            sourceId = sourceId,
            index = index,
            kind = "image",
            title = "Image ${index + 1}",
            thumbnailUrl = entry.url,
            container = container,
            plans = ensureRecommendations(
                listOf(
                    ResolvedPlan(
                        kind = "image",
                        container = container,
                        label = "Original",
                        detail = "${container.uppercase()} \u00b7 as posted",
                        requiresConversion = false,
                        recommended = true,
                        fetch = FetchPlan.Direct(url = entry.url),
                    ),
                ),
            ),
        )
    }
}

@Serializable
data class BlueskyAspectRatio(
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class BlueskyImage(
    val fullsize: String? = null,
    val thumb: String? = null,
    val alt: String? = null,
    val aspectRatio: BlueskyAspectRatio? = null,
)

@Serializable
data class BlueskyMediaEmbed(
    val images: List<BlueskyImage>? = null,
)

@Serializable
data class BlueskyEmbed(
    val images: List<BlueskyImage>? = null,
    val media: BlueskyMediaEmbed? = null,
)

@Serializable
data class BlueskyAuthor(
    val handle: String? = null,
    val displayName: String? = null,
)

@Serializable
data class BlueskyRecord(
    val text: String? = null,
)

@Serializable
data class BlueskyPost(
    val author: BlueskyAuthor? = null,
    val record: BlueskyRecord? = null,
    val embed: BlueskyEmbed? = null,
)

@Serializable
private data class BlueskyThreadNode(
    val post: BlueskyPost? = null,
)

@Serializable
private data class BlueskyThreadResponse(
    val thread: BlueskyThreadNode? = null,
)

@Serializable
private data class BlueskyDidResponse(
    val did: String? = null,
)

class BlueskyExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "bluesky"
    override val label: String = "Bluesky"
    override val hosts: List<String> = BLUESKY_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun wantsPlaylist(url: HttpUrl): Boolean = true

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> = listOf(
        ExtractionStrategy(
            id = "ytdlp",
            label = "the extractor",
            run = { runExtractor(url, context, onRawJson).media },
        ),
        ExtractionStrategy(
            id = "at-protocol",
            label = "Bluesky's public API",
            answers = setOf(FailureClass.UNSUPPORTED_MEDIA, FailureClass.FORMAT_UNAVAILABLE),
            run = { resolveImages(url, context) },
        ),
    )

    private suspend fun resolveImages(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val original = seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            detail = "bluesky: not a post URL this API can read",
        )
        val parts = url.pathSegments.filter { it.isNotEmpty() }
        val actor = parts.getOrNull(1)
        val rkey = parts.getOrNull(3)
        if (actor.isNullOrBlank() || rkey.isNullOrBlank() || parts.getOrNull(0) != "profile" || parts.getOrNull(2) != "post") {
            throw original
        }

        val post = try {
            val did = if (actor.startsWith("did:")) actor else resolveHandle(actor, context)
            readPost(did, rkey, context)
        } catch (error: Throwable) {
            if (error is SeraException && (
                    error.code == SeraErrorCode.CANCELLED ||
                        error.code == SeraErrorCode.TIMEOUT ||
                        error.code == SeraErrorCode.BLOCKED_ADDRESS
                    )
            ) {
                throw error
            }
            throw original
        }

        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        val candidates = post.embed?.images ?: post.embed?.media?.images ?: emptyList()
        val images = candidates.filter { img ->
            val u = img.fullsize
            u != null && u.startsWith("https://") && validateProviderUrl(u, allowPrivateAddresses = allowPrivate) != null
        }
        if (images.isEmpty()) throw original

        val author = nonEmpty(post.author?.displayName) ?: nonEmpty(post.author?.handle)
        val text = post.record?.text?.trim().orEmpty()
        val title = if (text.isNotEmpty()) truncateText(text, 200) else "Post by ${author ?: "Bluesky user"}"

        val items = images.take(context.maxItemsPerJob).mapIndexed { index, image ->
            val fullsize = image.fullsize!!
            val parsedFull = fullsize.toHttpUrlOrNull()
            val pathExt = parsedFull?.let { urlExtension(it) }.orEmpty()
            val suffixExt = BLUESKY_SUFFIX_EXT_REGEX.find(fullsize)?.groupValues?.get(1).orEmpty()
            val detected = normalizeContainer(suffixExt.ifEmpty { pathExt.ifEmpty { "jpg" } }, "bin")
            val container = if (detected == "bin") "jpg" else detected
            val width = image.aspectRatio?.width
            val height = image.aspectRatio?.height
            val dimText = if (width != null && height != null) "$width \u00d7 $height" else null
            val safeThumb = image.thumb?.takeIf {
                it.startsWith("https://") && validateProviderUrl(it, allowPrivateAddresses = allowPrivate) != null
            } ?: fullsize
            ResolvedItem(
                sourceId = fullsize.substringAfterLast('/').ifEmpty { index.toString() },
                index = index,
                kind = "image",
                title = image.alt?.trim()?.takeIf { it.isNotEmpty() }?.let { truncateText(it, 120) } ?: "Image ${index + 1}",
                thumbnailUrl = safeThumb,
                width = width,
                height = height,
                container = container,
                plans = ensureRecommendations(
                    listOf(
                        ResolvedPlan(
                            kind = "image",
                            container = container,
                            label = "Original",
                            detail = joinDetail(container.uppercase(), dimText),
                            width = width,
                            height = height,
                            requiresConversion = false,
                            recommended = true,
                            fetch = FetchPlan.Direct(url = fullsize),
                        ),
                    ),
                ),
            )
        }

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = if (items.size > 1) "collection" else "single",
            title = title,
            description = text.takeIf { it.isNotEmpty() }?.let { truncateText(it, 500) },
            author = author,
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf("images" to JsonPrimitive(images.size.toString())),
        )
    }

    private suspend fun resolveHandle(handle: String, context: ExtractionExecutionContext): String {
        val endpoint = "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle".toHttpUrlOrNull()!!
            .newBuilder()
            .addQueryParameter("handle", handle)
            .build()
        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 64L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        val parsed = SeraJson.decodeFromString(BlueskyDidResponse.serializer(), response.body)
        val did = parsed.did
        if (did.isNullOrBlank() || !did.startsWith("did:")) {
            throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "bluesky: handle did not resolve")
        }
        return did
    }

    private suspend fun readPost(
        did: String,
        rkey: String,
        context: ExtractionExecutionContext,
    ): BlueskyPost {
        val endpoint = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread".toHttpUrlOrNull()!!
            .newBuilder()
            .addQueryParameter("uri", "at://$did/app.bsky.feed.post/$rkey")
            .addQueryParameter("depth", "0")
            .addQueryParameter("parentHeight", "0")
            .build()
        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 512L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        val parsed = SeraJson.decodeFromString(BlueskyThreadResponse.serializer(), response.body)
        return parsed.thread?.post
            ?: throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "bluesky: no post in thread")
    }
}

@Serializable
data class MastodonOriginalMeta(
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
)

@Serializable
data class MastodonMeta(
    val original: MastodonOriginalMeta? = null,
)

@Serializable
data class MastodonAttachment(
    val id: String? = null,
    val type: String? = null,
    val url: String? = null,
    val preview_url: String? = null,
    val description: String? = null,
    val meta: MastodonMeta? = null,
)

@Serializable
data class MastodonAccount(
    val acct: String? = null,
    val display_name: String? = null,
)

@Serializable
data class MastodonStatus(
    val content: String? = null,
    val account: MastodonAccount? = null,
    val media_attachments: List<MastodonAttachment>? = null,
)

class MastodonExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "mastodon"
    override val label: String = "Mastodon"
    override val hosts: List<String> = MASTODON_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun wantsPlaylist(url: HttpUrl): Boolean = true

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> {
        var cachedApiResult: ResolvedMedia? = null
        var apiResolved = false
        var apiError: Throwable? = null

        suspend fun resolveApiOnce(): ResolvedMedia? {
            if (apiResolved) {
                apiError?.let { throw it }
                return cachedApiResult
            }
            apiResolved = true
            return try {
                resolveViaApi(url, context).also { cachedApiResult = it }
            } catch (err: Throwable) {
                apiError = err
                throw err
            }
        }

        return listOf(
            ExtractionStrategy(
                id = "instance-api",
                label = "the instance's public API",
                run = {
                    val media = resolveApiOnce()
                    if (media == null || media.items.isEmpty()) {
                        throw seraError(
                            SeraErrorCode.UNSUPPORTED_SOURCE,
                            detail = "mastodon: the status carries no attachments this API can read",
                        )
                    }
                    if (!media.items.all { it.kind == "image" }) {
                        throw seraError(
                            SeraErrorCode.UNSUPPORTED_SOURCE,
                            detail = "mastodon: video, which the extractor renders in more qualities",
                        )
                    }
                    media
                },
            ),
            ExtractionStrategy(
                id = "ytdlp",
                label = "the extractor",
                available = { hostMatchesAny(url.host, hosts) },
                run = { runExtractor(url, context, onRawJson).media },
            ),
            ExtractionStrategy(
                id = "instance-api-anything",
                label = "the instance's public API, taking whatever it has",
                run = {
                    val media = resolveApiOnce()
                    if (media == null || media.items.isEmpty()) {
                        if (!hostMatchesAny(url.host, hosts)) {
                            throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "mastodon: nothing in the status")
                        }
                        throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "mastodon: nothing in the status")
                    }
                    media
                },
            ),
        )
    }

    private suspend fun resolveViaApi(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia? {
        val statusId = MASTODON_STATUS_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1) ?: return null
        val endpoint = url.newBuilder()
            .encodedPath("/api/v1/statuses/$statusId")
            .query(null)
            .build()
        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        val status = try {
            val response = httpFetcher.fetchText(
                url = endpoint,
                maxBytes = 512L * 1024L,
                allowPrivateAddresses = allowPrivate,
                timeoutMs = context.resolveTimeoutMs,
                isCancelled = context.isCancelled,
            )
            SeraJson.decodeFromString(MastodonStatus.serializer(), response.body)
        } catch (error: Throwable) {
            if (!hostMatchesAny(url.host, hosts)) {
                throw seraError(
                    SeraErrorCode.UNSUPPORTED_SOURCE,
                    detail = "mastodon: not a known mastodon instance",
                    cause = error,
                )
            }
            throw error
        }

        val attachments = status.media_attachments.orEmpty().filter { a ->
            val u = a.url
            u != null && u.startsWith("https://") && validateProviderUrl(u, allowPrivateAddresses = allowPrivate) != null
        }
        if (attachments.isEmpty()) return null

        val author = nonEmpty(status.account?.display_name)
            ?: nonEmpty(status.account?.acct)?.let { "@$it" }
        val text = stripMastodonHtml(status.content.orEmpty())
        val items = attachments.take(context.maxItemsPerJob).mapIndexed { index, attachment ->
            toMastodonItem(attachment, index, allowPrivate)
        }

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = if (items.size > 1) "collection" else "single",
            title = if (text.isNotEmpty()) truncateText(text, 200) else "Post by ${author ?: "a fediverse account"}",
            description = text.takeIf { it.isNotEmpty() }?.let { truncateText(it, 500) },
            author = author,
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf("attachments" to JsonPrimitive(attachments.size.toString())),
        )
    }

    private fun toMastodonItem(
        attachment: MastodonAttachment,
        index: Int,
        allowPrivateAddresses: Boolean,
    ): ResolvedItem {
        val kind = when (attachment.type) {
            "video" -> "video"
            "gifv" -> "gif"
            "audio" -> "audio"
            else -> "image"
        }
        val attachmentUrl = attachment.url!!
        val ext = attachmentUrl.toHttpUrlOrNull()?.let { urlExtension(it) }.orEmpty()
        val container = normalizeContainer(ext, "bin")
        val width = attachment.meta?.original?.width
        val height = attachment.meta?.original?.height
        val duration = attachment.meta?.original?.duration
        val dimText = if (width != null && height != null) "$width \u00d7 $height" else null

        val plans = ArrayList<ResolvedPlan>()
        plans.add(
            ResolvedPlan(
                kind = kind,
                container = container,
                label = "Original",
                detail = joinDetail(container.uppercase(), dimText),
                width = width,
                height = height,
                requiresConversion = false,
                recommended = true,
                fetch = FetchPlan.Direct(url = attachmentUrl),
            ),
        )
        if (kind == "gif" && (duration == null || duration <= 30.0)) {
            plans.add(
                ResolvedPlan(
                    kind = "gif",
                    container = "gif",
                    label = "GIF",
                    detail = "Converted from the looping video",
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Direct(url = attachmentUrl),
                    convert = ConversionSpec.Gif(),
                ),
            )
        }
        if (kind == "video") {
            plans.add(
                ResolvedPlan(
                    kind = "audio",
                    container = "mp3",
                    label = "MP3",
                    detail = "320 kbps \u00b7 extracted",
                    audioBitrateKbps = 320.0,
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Direct(url = attachmentUrl),
                    convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
                ),
            )
        }

        val safePreview = attachment.preview_url?.takeIf {
            it.startsWith("https://") && validateProviderUrl(it, allowPrivateAddresses = allowPrivateAddresses) != null
        }

        return ResolvedItem(
            sourceId = attachment.id ?: index.toString(),
            index = index,
            kind = kind,
            title = nonEmpty(attachment.description)?.let { truncateText(it, 120) } ?: "Attachment ${index + 1}",
            thumbnailUrl = safePreview,
            width = width,
            height = height,
            container = container,
            plans = ensureRecommendations(plans),
        )
    }
}

private fun stripMastodonHtml(html: String): String =
    decodeHtmlEntities(
        html.replace(HTML_BR_P_REGEX, " ").replace(HTML_TAG_REGEX, ""),
        " ",
    ).replace(Regex("""\s+"""), " ").trim()
