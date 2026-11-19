package dev.sera.node.extractor

import dev.sera.node.BuildConfig
import dev.sera.node.model.AudioExtractSpec
import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SeraJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Base64

const val REDDIT_EMBED_AGENT = "SERA.toolkit (+https://github.com/seraphicidal/sera-toolkit)"
const val REDDIT_MANIFEST_EXTRACTORS = "generic"

private val REDDIT_COMMENTS_ID_REGEX = Regex("""/comments/([a-z0-9]+)""", RegexOption.IGNORE_CASE)
private val REDDIT_SHORT_ID_REGEX = Regex("""^/([a-z0-9]+)""", RegexOption.IGNORE_CASE)
private val SCREENVIEW_ATTR_REGEX = Regex("""<shreddit-screenview-data\s+data="([^"]*)"""")
private val REDDIT_IMAGE_URL_REGEX = Regex("""https://i\.redd\.it/[A-Za-z0-9._-]+""")
private val REDDIT_VIDEO_URL_REGEX = Regex("""https://v\.redd\.it/[A-Za-z0-9]+""")
private val ALPHANUMERIC_ID_REGEX = Regex("""^[A-Za-z0-9]+$""")
private val DIRECT_REDDIT_IMAGE_REGEX = Regex("""^https://i\.redd\.it/""", RegexOption.IGNORE_CASE)
private val IMAGE_MIME_SUBTYPE_REGEX = Regex("""^image/([a-z0-9+.-]+)$""", RegexOption.IGNORE_CASE)
private val URL_EXT_REGEX = Regex("""\.([a-z0-9]{2,5})(?:[?#]|$)""", RegexOption.IGNORE_CASE)

@Serializable
data class RedditGalleryItemRef(
    val media_id: String? = null,
)

@Serializable
data class RedditGalleryData(
    val items: List<RedditGalleryItemRef>? = null,
)

@Serializable
data class RedditMediaSource(
    val u: String? = null,
    val gif: String? = null,
    val mp4: String? = null,
    val x: Int? = null,
    val y: Int? = null,
)

@Serializable
data class RedditMediaMetadata(
    val status: String? = null,
    val e: String? = null,
    val m: String? = null,
    val s: RedditMediaSource? = null,
)

@Serializable
data class RedditVideo(
    val fallback_url: String? = null,
    val dash_url: String? = null,
    val hls_url: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val is_gif: Boolean? = null,
    val has_audio: Boolean? = null,
)

@Serializable
data class RedditMediaWrapper(
    val reddit_video: RedditVideo? = null,
)

@Serializable
data class RedditPreviewImageSource(
    val url: String? = null,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class RedditPreviewImage(
    val source: RedditPreviewImageSource? = null,
)

@Serializable
data class RedditPreview(
    val images: List<RedditPreviewImage>? = null,
    val reddit_video_preview: RedditVideo? = null,
)

@Serializable
data class RedditPost(
    val id: String? = null,
    val title: String? = null,
    val author: String? = null,
    val subreddit_name_prefixed: String? = null,
    val over_18: Boolean? = null,
    val is_gallery: Boolean? = null,
    val gallery_data: RedditGalleryData? = null,
    val media_metadata: Map<String, RedditMediaMetadata?>? = null,
    val is_video: Boolean? = null,
    val media: RedditMediaWrapper? = null,
    val secure_media: RedditMediaWrapper? = null,
    val crosspost_parent_list: List<RedditPost>? = null,
    val url_overridden_by_dest: String? = null,
    val url: String? = null,
    val preview: RedditPreview? = null,
)

@Serializable
data class RedditOembed(
    val title: String? = null,
    val author_name: String? = null,
)

@Serializable
data class RedditScreenviewPost(
    val id: String? = null,
    val url: String? = null,
    val type: String? = null,
    val nsfw: Boolean? = null,
)

@Serializable
data class RedditScreenviewSubreddit(
    val name: String? = null,
)

@Serializable
data class RedditScreenviewData(
    val post: RedditScreenviewPost? = null,
    val subreddit: RedditScreenviewSubreddit? = null,
)

@Serializable
private data class RedditTokenResponse(
    val access_token: String? = null,
    val expires_in: Long? = null,
)

class RedditExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "reddit"
    override val label: String = "Reddit"
    override val hosts: List<String> = REDDIT_HOSTS

    @Volatile
    private var cachedToken: String? = null

    @Volatile
    private var cachedTokenExpiresAtMs: Long = 0L

    @Volatile
    private var cachedCredsKey: String? = null

    override fun normalize(url: HttpUrl): HttpUrl {
        val host = stripWww(url.host.lowercase())
        val targetHost = if (host == "reddit.com" || host == "old.reddit.com") "www.reddit.com" else url.host
        return normalizeUrl(
            url.newBuilder()
                .scheme("https")
                .host(targetHost)
                .build(),
        )
    }

    override fun wantsPlaylist(url: HttpUrl): Boolean = true

    override fun treatsSilentShortVideoAsGif(): Boolean = true

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> = listOf(
        ExtractionStrategy(
            id = "oauth-api",
            label = "Reddit's Data API, with the operator's app registration",
            available = { hasCredentials(context) },
            run = {
                if (redditVideoBaseFromUrl(url) != null) {
                    throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "reddit: a media host, not a post")
                }
                viaApi(url, context)
            },
        ),
        ExtractionStrategy(
            id = "embed",
            label = "what Reddit publishes for embedding",
            run = { readRedditViaEmbed(url, context, httpFetcher) },
        ),
        ExtractionStrategy(
            id = "ytdlp",
            label = "the extractor",
            run = { runExtractor(url, context, onRawJson).media },
        ),
    )

    private fun hasCredentials(context: ExtractionExecutionContext): Boolean =
        !context.runtimeConfig.redditClientId.isNullOrBlank() &&
            !context.runtimeConfig.redditClientSecret.isNullOrBlank()

    private suspend fun viaApi(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val postId = redditPostIdFrom(url)
            ?: throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That does not look like a Reddit post.",
                detail = "reddit: no post id in ${url.encodedPath}",
            )
        val clientId = context.runtimeConfig.redditClientId?.trim().orEmpty()
        val clientSecret = context.runtimeConfig.redditClientSecret?.trim().orEmpty()
        if (clientId.isEmpty() || clientSecret.isEmpty()) {
            throw seraError(SeraErrorCode.PROVIDER_CONFIGURATION_ERROR, detail = "reddit: no client credentials configured")
        }
        val userAgent = "server:sera.toolkit:v${BuildConfig.VERSION_NAME} (by /u/sera-toolkit)"
        val post = fetchRedditPost(postId, clientId, clientSecret, userAgent, context)
        val source = post.crosspost_parent_list?.firstOrNull() ?: post
        val items = redditItemsFrom(source, context.maxItemsPerJob)
        if (items.isEmpty()) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That post has no media to download.",
                detail = "reddit: no recognised media on the post",
            )
        }
        val author = nonEmpty(post.author)
        val title = nonEmpty(post.title)?.let { truncateText(it, 200) } ?: "Reddit post"
        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = if (items.size > 1) "collection" else "single",
            title = title,
            author = author?.let { "u/$it" },
            thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
            items = items,
            metadata = mapOf(
                "subreddit" to JsonPrimitive(nonEmpty(post.subreddit_name_prefixed) ?: "unknown"),
                "items" to JsonPrimitive(items.size.toString()),
            ),
        )
    }

    private suspend fun getAccessToken(
        clientId: String,
        clientSecret: String,
        userAgent: String,
        context: ExtractionExecutionContext,
    ): String {
        val credsKey = "$clientId:$clientSecret"
        val now = System.currentTimeMillis()
        val existing = cachedToken
        if (existing != null && cachedCredsKey == credsKey && cachedTokenExpiresAtMs - 60_000L > now) {
            return existing
        }
        val basic = Base64.getEncoder().encodeToString("$clientId:$clientSecret".toByteArray(Charsets.UTF_8))
        val endpoint = "https://www.reddit.com/api/v1/access_token".toHttpUrlOrNull()!!
        val response = httpFetcher.postForm(
            url = endpoint,
            formBody = "grant_type=client_credentials",
            headers = mapOf("authorization" to "Basic $basic"),
            maxBytes = 1024L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = 15_000L,
            userAgent = userAgent,
            isCancelled = context.isCancelled,
        )
        if (response.status == 401 || response.status == 403) {
            throw seraError(
                SeraErrorCode.PROVIDER_CONFIGURATION_ERROR,
                message = "Reddit rejected this server's credentials.",
                detail = "reddit: token endpoint returned ${response.status}",
            )
        }
        if (response.status >= 400) {
            throw seraError(
                SeraErrorCode.PROVIDER_UNAVAILABLE,
                detail = "reddit: token endpoint returned ${response.status}",
            )
        }
        val parsed = try {
            SeraJson.decodeFromString(RedditTokenResponse.serializer(), response.body)
        } catch (cause: Exception) {
            throw seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = "reddit: invalid JSON from token endpoint", cause = cause)
        }
        val token = parsed.access_token?.takeIf { it.isNotBlank() }
            ?: throw seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = "reddit: token response had no token")
        val lifetimeSeconds = parsed.expires_in ?: 3600L
        cachedToken = token
        cachedCredsKey = credsKey
        cachedTokenExpiresAtMs = System.currentTimeMillis() + lifetimeSeconds * 1000L
        return token
    }

    private suspend fun fetchRedditPost(
        postId: String,
        clientId: String,
        clientSecret: String,
        userAgent: String,
        context: ExtractionExecutionContext,
    ): RedditPost {
        val endpoint = "https://oauth.reddit.com/comments/$postId?raw_json=1&limit=1".toHttpUrlOrNull()!!
        suspend fun callWithToken(token: String): HttpTextResponse =
            httpFetcher.fetchNoFollow(
                url = endpoint,
                maxBytes = 8L * 1024L * 1024L,
                headers = mapOf("authorization" to "Bearer $token"),
                allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
                timeoutMs = 15_000L,
                userAgent = userAgent,
                isCancelled = context.isCancelled,
            )

        var response = callWithToken(getAccessToken(clientId, clientSecret, userAgent, context))
        if (response.status == 401) {
            cachedToken = null
            response = callWithToken(getAccessToken(clientId, clientSecret, userAgent, context))
        }
        when (response.status) {
            404 -> throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "reddit: 404")
            403 -> throw seraError(
                SeraErrorCode.PRIVATE_CONTENT,
                message = "That post is in a private or quarantined community.",
                detail = "reddit: 403 from the data API",
            )
            429 -> throw seraError(SeraErrorCode.RATE_LIMITED, detail = "reddit: 429 from the data API")
        }
        if (response.status >= 400) {
            throw seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = "reddit: data api ${response.status}")
        }
        val element = try {
            SeraJson.parseToJsonElement(response.body)
        } catch (cause: Exception) {
            throw seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = "reddit: invalid JSON from data api", cause = cause)
        }
        return firstRedditPostIn(element)
            ?: throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "reddit: no post in listing")
    }
}

private fun firstRedditPostIn(body: JsonElement): RedditPost? {
    val listings = if (body is JsonArray) body.toList() else listOf(body)
    for (listing in listings) {
        val dataObj = (listing as? JsonObject)?.get("data") as? JsonObject ?: continue
        val children = dataObj["children"] as? JsonArray ?: continue
        val firstChild = children.firstOrNull() as? JsonObject ?: continue
        val postElem = firstChild["data"] ?: continue
        val post = runCatching { SeraJson.decodeFromJsonElement<RedditPost>(postElem) }.getOrNull()
        if (post != null && (!post.id.isNullOrBlank() || !post.title.isNullOrBlank())) {
            return post
        }
    }
    return null
}

fun redditPostIdFrom(url: HttpUrl): String? {
    val comments = REDDIT_COMMENTS_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1)
    if (comments != null) return comments
    if (stripWww(url.host.lowercase()) == "redd.it") {
        return REDDIT_SHORT_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1)
    }
    return null
}

fun redditVideoBaseFromUrl(url: HttpUrl): String? {
    if (stripWww(url.host.lowercase()) != "v.redd.it") return null
    val id = url.pathSegments.firstOrNull { it.isNotEmpty() } ?: return null
    return if (ALPHANUMERIC_ID_REGEX.matches(id)) "https://v.redd.it/$id" else null
}

private fun unescapeRedditUrl(value: String): String = value.replace("&amp;", "&")

private fun redditHttpsUrl(value: String?): String? {
    val raw = nonEmpty(value) ?: return null
    val unescaped = unescapeRedditUrl(raw)
    val parsed = unescaped.toHttpUrlOrNull() ?: return null
    if (!parsed.isHttps || parsed.encodedUsername.isNotEmpty() || parsed.encodedPassword.isNotEmpty() || parsed.port != 443) {
        return null
    }
    return parsed.toString()
}

private fun onRedditVideoHost(url: String): Boolean {
    val parsed = url.toHttpUrlOrNull() ?: return false
    return redditVideoBaseFromUrl(parsed) != null
}

private fun redditContainerFromMime(mime: String?, url: String): String {
    val subtype = IMAGE_MIME_SUBTYPE_REGEX.find(mime.orEmpty())?.groupValues?.get(1)?.lowercase()
    when (subtype) {
        "jpg", "jpeg" -> return "jpg"
        "png", "gif", "webp" -> return subtype
    }
    val ext = URL_EXT_REGEX.find(url)?.groupValues?.get(1)?.lowercase()
    return when (ext) {
        "jpg", "jpeg" -> "jpg"
        "png", "gif", "webp" -> ext
        else -> "jpg"
    }
}

private fun redditImagePlan(url: String, container: String, width: Int?, height: Int?): ResolvedPlan {
    val dimText = if (width != null && height != null) "$width \u00d7 $height" else null
    return ResolvedPlan(
        kind = "image",
        container = container,
        label = "Original",
        detail = joinDetail(container.uppercase(), dimText),
        width = width,
        height = height,
        requiresConversion = false,
        recommended = true,
        fetch = FetchPlan.Direct(url = url),
    )
}

private fun redditGalleryItems(post: RedditPost, limit: Int): List<ResolvedItem> {
    val order = post.gallery_data?.items.orEmpty()
    val metadata = post.media_metadata.orEmpty()
    val items = ArrayList<ResolvedItem>()

    for (entry in order.take(limit)) {
        val id = entry.media_id ?: continue
        val media = metadata[id] ?: continue
        if (media.status != "valid") continue

        val still = redditHttpsUrl(media.s?.u)
        val gif = redditHttpsUrl(media.s?.gif)
        val mp4 = redditHttpsUrl(media.s?.mp4)
        val width = media.s?.x
        val height = media.s?.y

        if (media.e == "AnimatedImage" && (mp4 != null || gif != null)) {
            val plans = ArrayList<ResolvedPlan>()
            if (mp4 != null) {
                plans.add(
                    ResolvedPlan(
                        kind = "gif",
                        container = "mp4",
                        label = "MP4",
                        detail = "Silent video \u00b7 smaller than the GIF",
                        width = width,
                        height = height,
                        requiresConversion = false,
                        recommended = true,
                        fetch = FetchPlan.Direct(url = mp4),
                    ),
                )
            }
            if (gif != null) {
                plans.add(
                    ResolvedPlan(
                        kind = "gif",
                        container = "gif",
                        label = "GIF",
                        detail = "Original",
                        requiresConversion = false,
                        recommended = mp4 == null,
                        fetch = FetchPlan.Direct(url = gif),
                    ),
                )
            }
            items.add(
                ResolvedItem(
                    sourceId = id,
                    index = items.size,
                    kind = "gif",
                    title = "GIF ${items.size + 1}",
                    thumbnailUrl = still,
                    width = width,
                    height = height,
                    container = if (mp4 != null) "mp4" else "gif",
                    plans = ensureRecommendations(plans),
                ),
            )
            continue
        }

        if (still == null) continue
        val container = redditContainerFromMime(media.m, still)
        items.add(
            ResolvedItem(
                sourceId = id,
                index = items.size,
                kind = "image",
                title = "Image ${items.size + 1}",
                thumbnailUrl = still,
                width = width,
                height = height,
                container = container,
                plans = ensureRecommendations(listOf(redditImagePlan(still, container, width, height))),
            ),
        )
    }
    return items
}

private fun redditVideoItem(video: RedditVideo, post: RedditPost): ResolvedItem? {
    val manifest = redditHttpsUrl(video.hls_url) ?: redditHttpsUrl(video.dash_url)
    val fallback = redditHttpsUrl(video.fallback_url)
    val url = manifest ?: fallback ?: return null
    val viaManifest = manifest != null
    val isGif = video.is_gif == true

    val fetchPlan: FetchPlan = if (viaManifest) {
        FetchPlan.Ytdlp(
            selector = "bestvideo*+bestaudio/best",
            merge = "mp4",
            target = url,
            useExtractors = if (onRedditVideoHost(url)) REDDIT_MANIFEST_EXTRACTORS else null,
        )
    } else {
        FetchPlan.Direct(url = url)
    }

    val dimText = if (video.width != null && video.height != null) "${video.width} \u00d7 ${video.height}" else null
    val silentText = if (video.has_audio == false || isGif) "silent" else null
    val plans = ArrayList<ResolvedPlan>()
    plans.add(
        ResolvedPlan(
            kind = if (isGif) "gif" else "video",
            container = "mp4",
            label = if (viaManifest && !isGif) "Best available" else "Original",
            detail = joinDetail("MP4", dimText, silentText),
            width = video.width,
            height = video.height,
            requiresConversion = false,
            recommended = true,
            fetch = fetchPlan,
        ),
    )

    if (!isGif && video.has_audio != false) {
        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = "mp3",
                label = "MP3",
                detail = "192 kbps \u00b7 extracted",
                audioBitrateKbps = 192.0,
                requiresConversion = true,
                recommended = false,
                fetch = if (viaManifest) {
                    FetchPlan.Ytdlp(
                        selector = "bestaudio/best",
                        audio = AudioExtractSpec(format = "mp3", quality = "192K"),
                        target = url,
                        useExtractors = if (onRedditVideoHost(url)) REDDIT_MANIFEST_EXTRACTORS else null,
                    )
                } else {
                    FetchPlan.Direct(url = url)
                },
                convert = if (viaManifest) null else ConversionSpec.Audio(container = "mp3", bitrateKbps = 192),
            ),
        )
    }

    if (isGif && (video.duration == null || video.duration <= 30.0)) {
        plans.add(
            ResolvedPlan(
                kind = "gif",
                container = "gif",
                label = "GIF",
                detail = "Converted from the silent video Reddit stores",
                requiresConversion = true,
                recommended = false,
                fetch = fetchPlan,
                convert = ConversionSpec.Gif(),
            ),
        )
    }

    val thumbnail = redditHttpsUrl(post.preview?.images?.firstOrNull()?.source?.url)
    return ResolvedItem(
        sourceId = "video",
        index = 0,
        kind = if (isGif) "gif" else "video",
        title = nonEmpty(post.title)?.let { truncateText(it, 120) } ?: "Video",
        thumbnailUrl = thumbnail,
        width = video.width,
        height = video.height,
        duration = video.duration,
        container = "mp4",
        plans = ensureRecommendations(plans),
    )
}

fun redditItemsFrom(post: RedditPost, limit: Int): List<ResolvedItem> {
    if (post.is_gallery == true) {
        val gallery = redditGalleryItems(post, limit)
        if (gallery.isNotEmpty()) return gallery
    }
    val video = post.secure_media?.reddit_video ?: post.media?.reddit_video
    if (video != null) {
        val item = redditVideoItem(video, post)
        if (item != null) return listOf(item)
    }
    val direct = nonEmpty(post.url_overridden_by_dest) ?: nonEmpty(post.url)
    if (direct != null && DIRECT_REDDIT_IMAGE_REGEX.containsMatchIn(direct)) {
        val url = unescapeRedditUrl(direct)
        val source = post.preview?.images?.firstOrNull()?.source
        val container = redditContainerFromMime(null, url)
        val kind = if (container == "gif") "gif" else "image"
        return listOf(
            ResolvedItem(
                sourceId = "image",
                index = 0,
                kind = kind,
                title = nonEmpty(post.title)?.let { truncateText(it, 120) } ?: "Image",
                thumbnailUrl = url,
                width = source?.width,
                height = source?.height,
                container = container,
                plans = ensureRecommendations(listOf(redditImagePlan(url, container, source?.width, source?.height))),
            ),
        )
    }
    val preview = post.preview?.reddit_video_preview
    if (preview != null) {
        val item = redditVideoItem(preview.copy(is_gif = true), post)
        if (item != null) return listOf(item)
    }
    return emptyList()
}

private fun embedImageItem(url: String, index: Int): ResolvedItem {
    val container = redditContainerFromMime(null, url)
    val kind = if (container == "gif") "gif" else "image"
    return ResolvedItem(
        sourceId = url.substringAfterLast('/').ifEmpty { index.toString() },
        index = index,
        kind = kind,
        title = "Image ${index + 1}",
        thumbnailUrl = url,
        container = container,
        plans = ensureRecommendations(
            listOf(
                ResolvedPlan(
                    kind = kind,
                    container = container,
                    label = "Original",
                    detail = "${container.uppercase()} \u00b7 as posted",
                    requiresConversion = false,
                    recommended = true,
                    fetch = FetchPlan.Direct(url = url),
                ),
            ),
        ),
    )
}

private fun embedVideoItem(base: String): ResolvedItem =
    ResolvedItem(
        sourceId = base.substringAfterLast('/').ifEmpty { "video" },
        index = 0,
        kind = "video",
        title = "Video",
        container = "mp4",
        plans = ensureRecommendations(
            listOf(
                ResolvedPlan(
                    kind = "video",
                    container = "mp4",
                    label = "Best available",
                    detail = "MP4 \u00b7 from the streaming manifest",
                    requiresConversion = false,
                    recommended = true,
                    fetch = FetchPlan.Ytdlp(
                        selector = "bestvideo*+bestaudio/best",
                        merge = "mp4",
                        useExtractors = REDDIT_MANIFEST_EXTRACTORS,
                    ),
                ),
                ResolvedPlan(
                    kind = "audio",
                    container = "mp3",
                    label = "MP3",
                    detail = "192 kbps \u00b7 extracted",
                    audioBitrateKbps = 192.0,
                    requiresConversion = true,
                    recommended = false,
                    fetch = FetchPlan.Ytdlp(
                        selector = "bestaudio/best",
                        audio = AudioExtractSpec(format = "mp3", quality = "192K"),
                        useExtractors = REDDIT_MANIFEST_EXTRACTORS,
                    ),
                ),
            ),
        ),
    )

suspend fun readRedditViaEmbed(
    url: HttpUrl,
    context: ExtractionExecutionContext,
    httpFetcher: HttpFetcher,
): ResolvedMedia {
    val direct = redditVideoBaseFromUrl(url)
    if (direct != null) {
        return ResolvedMedia(
            provider = "reddit",
            providerLabel = "Reddit",
            url = "$direct/HLSPlaylist.m3u8",
            type = "single",
            title = "Reddit video",
            items = listOf(embedVideoItem(direct)),
            metadata = mapOf(
                "source" to JsonPrimitive("v.redd.it"),
                "items" to JsonPrimitive("1"),
            ),
        )
    }

    val embedUrl = url.newBuilder()
        .host("embed.reddit.com")
        .query(null)
        .build()
    val oembedUrl = "https://www.reddit.com/oembed".toHttpUrlOrNull()!!
        .newBuilder()
        .addQueryParameter("url", url.toString())
        .build()

    val htmlResponse = httpFetcher.fetchText(
        url = embedUrl,
        maxBytes = 2L * 1024L * 1024L,
        allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
        timeoutMs = context.resolveTimeoutMs,
        userAgent = REDDIT_EMBED_AGENT,
        isCancelled = context.isCancelled,
    )
    val oembed = runCatching {
        val resp = httpFetcher.fetchText(
            url = oembedUrl,
            maxBytes = 256L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            userAgent = REDDIT_EMBED_AGENT,
            isCancelled = context.isCancelled,
        )
        SeraJson.decodeFromString(RedditOembed.serializer(), resp.body)
    }.getOrNull()

    val html = htmlResponse.body
    val screenview = SCREENVIEW_ATTR_REGEX.find(html)?.groupValues?.get(1)?.let { rawAttr ->
        runCatching {
            SeraJson.decodeFromString(RedditScreenviewData.serializer(), decodeHtmlEntities(rawAttr))
        }.getOrNull()
    }
    val images = REDDIT_IMAGE_URL_REGEX.findAll(html).map { it.value }.distinct().toList()
    val videoBase = REDDIT_VIDEO_URL_REGEX.find(html)?.value

    val items: List<ResolvedItem>
    val extractFrom: String
    if (videoBase != null) {
        items = listOf(embedVideoItem(videoBase))
        extractFrom = "$videoBase/HLSPlaylist.m3u8"
    } else if (images.isNotEmpty()) {
        items = images.take(context.maxItemsPerJob).mapIndexed { index, img -> embedImageItem(img, index) }
        extractFrom = url.toString()
    } else {
        throw seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "That post has no media to download.",
            detail = "reddit: the embed named no media (type ${screenview?.post?.type ?: "unknown"})",
        )
    }

    val author = nonEmpty(oembed?.author_name)
    val title = nonEmpty(oembed?.title)
    val meta = LinkedHashMap<String, JsonPrimitive>()
    meta["source"] = JsonPrimitive("embed")
    screenview?.subreddit?.name?.takeIf { it.isNotBlank() }?.let { meta["subreddit"] = JsonPrimitive("r/$it") }
    meta["items"] = JsonPrimitive(items.size.toString())

    return ResolvedMedia(
        provider = "reddit",
        providerLabel = "Reddit",
        url = extractFrom,
        type = if (items.size > 1) "collection" else "single",
        title = title?.let { truncateText(it, 200) } ?: "Reddit post",
        author = author?.let { "u/$it" },
        thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
        items = items,
        metadata = meta,
    )
}
