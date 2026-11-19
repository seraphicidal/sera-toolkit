package dev.sera.node.extractor

import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.DEFAULT_INSTAGRAM_USER_AGENT
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

const val INSTAGRAM_APP_ID = "936619743392459"

@Serializable
data class InstagramCandidate(
    val url: String? = null,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class InstagramImageVersions(
    val candidates: List<InstagramCandidate> = emptyList(),
)

@Serializable
data class InstagramUser(
    val username: String? = null,
    val full_name: String? = null,
)

@Serializable
data class InstagramCaption(
    val text: String? = null,
)

@Serializable
data class InstagramNode(
    val id: String? = null,
    val code: String? = null,
    val media_type: Int? = null,
    val carousel_media: List<InstagramNode>? = null,
    val image_versions2: InstagramImageVersions? = null,
    val video_versions: List<InstagramCandidate>? = null,
    val video_duration: Double? = null,
    val accessibility_caption: String? = null,
    val user: InstagramUser? = null,
    val caption: InstagramCaption? = null,
)

@Serializable
data class InstagramMediaInfoResponse(
    val items: List<InstagramNode>? = null,
)

@Serializable
data class InstagramOembed(
    val title: String? = null,
    val author_name: String? = null,
    val author_url: String? = null,
    val media_id: String? = null,
    val thumbnail_url: String? = null,
    val thumbnail_width: Int? = null,
    val thumbnail_height: Int? = null,
)

data class ImportedEntry(
    val s: String,
    val kind: String,
    val url: String,
    val w: Int? = null,
    val h: Int? = null,
    val container: String,
    val d: Double? = null,
)

data class InstagramSlide(
    val entry: ImportedEntry,
    val title: String,
    val thumbnailUrl: String? = null,
)

private val USERNAME_REGEX = Regex("""^[A-Za-z0-9._]{1,30}$""")
private val URL_EXT_REGEX = Regex("""\.([a-z0-9]{2,5})(?:[?#]|$)""", RegexOption.IGNORE_CASE)

fun sessionHeaders(
    sessionId: String,
    appId: String = INSTAGRAM_APP_ID,
    userAgent: String = DEFAULT_INSTAGRAM_USER_AGENT,
): Map<String, String> = mapOf(
    "x-ig-app-id" to appId,
    "x-requested-with" to "XMLHttpRequest",
    "cookie" to "sessionid=$sessionId",
    "user-agent" to userAgent,
)

private fun widest(candidates: List<InstagramCandidate>?): InstagramCandidate? =
    candidates.orEmpty()
        .filter { nonEmpty(it.url) != null }
        .maxByOrNull { it.width ?: 0 }

private fun containerForUrl(url: String, fallback: String): String {
    val extension = URL_EXT_REGEX.find(url)?.groupValues?.get(1)?.lowercase()
    return when (extension) {
        "jpeg", "jpg" -> "jpg"
        "png", "webp", "mp4" -> extension
        else -> fallback
    }
}

private fun slideFrom(node: InstagramNode, position: Int): InstagramSlide? {
    val video = widest(node.video_versions)
    val image = widest(node.image_versions2?.candidates)
    val alt = nonEmpty(node.accessibility_caption)
    val sourceId = nonEmpty(node.id) ?: position.toString()

    if (node.media_type == 2 && video?.url != null) {
        return InstagramSlide(
            entry = ImportedEntry(
                s = sourceId,
                kind = "video",
                url = video.url,
                w = video.width?.takeIf { it > 0 },
                h = video.height?.takeIf { it > 0 },
                container = containerForUrl(video.url, "mp4"),
                d = node.video_duration?.takeIf { it > 0.0 },
            ),
            title = if (alt != null) truncateText(alt, 120) else "Video ${position + 1}",
            thumbnailUrl = image?.url,
        )
    }

    val imageUrl = image?.url ?: return null
    return InstagramSlide(
        entry = ImportedEntry(
            s = sourceId,
            kind = "image",
            url = imageUrl,
            w = image.width?.takeIf { it > 0 },
            h = image.height?.takeIf { it > 0 },
            container = containerForUrl(imageUrl, "jpg"),
        ),
        title = if (alt != null) truncateText(alt, 120) else "Image ${position + 1}",
        thumbnailUrl = imageUrl,
    )
}

fun slidesFrom(node: InstagramNode, limit: Int): List<InstagramSlide> {
    val nodes = if (node.media_type == 8 && !node.carousel_media.isNullOrEmpty()) {
        node.carousel_media
    } else {
        listOf(node)
    }
    return nodes.take(limit).mapIndexedNotNull { position, slide -> slideFrom(slide, position) }
}

fun itemFromEntry(entry: ImportedEntry, index: Int): ResolvedItem {
    val original = ResolvedPlan(
        kind = entry.kind,
        container = entry.container,
        label = "Original",
        detail = listOfNotNull(
            entry.container.uppercase(),
            if (entry.w != null && entry.h != null) "${entry.w} \u00d7 ${entry.h}" else null,
        ).joinToString(" \u00b7 "),
        width = entry.w,
        height = entry.h,
        requiresConversion = false,
        recommended = true,
        fetch = FetchPlan.Direct(url = entry.url),
    )
    val plans = if (entry.kind == "video") {
        listOf(
            original,
            ResolvedPlan(
                kind = "audio",
                container = "mp3",
                label = "MP3",
                detail = "320 kbps \u00b7 extracted",
                audioBitrateKbps = 320.0,
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = entry.url),
                convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
            ),
        )
    } else {
        listOf(original)
    }

    return ResolvedItem(
        sourceId = entry.s.take(200),
        index = index,
        kind = entry.kind,
        width = entry.w,
        height = entry.h,
        duration = entry.d,
        container = entry.container,
        plans = ensureRecommendations(plans),
    )
}

fun itemsFrom(node: InstagramNode, limit: Int): List<ResolvedItem> =
    slidesFrom(node, limit).mapIndexed { index, slide ->
        itemFromEntry(slide.entry, index).copy(
            title = slide.title.take(500),
            thumbnailUrl = slide.thumbnailUrl,
        )
    }

fun titleFor(node: InstagramNode): Pair<String, String?> {
    val author = nonEmpty(node.user?.full_name) ?: nonEmpty(node.user?.username)
    val caption = nonEmpty(node.caption?.text)
    val title = if (caption != null) {
        truncateText(caption, 200)
    } else {
        "Post by ${author ?: "an Instagram account"}"
    }
    return title to author?.take(200)
}

fun authorUrlFor(node: InstagramNode): String? {
    val username = node.user?.username ?: return null
    return if (USERNAME_REGEX.matches(username)) "https://www.instagram.com/$username/" else null
}

fun coverItemFrom(
    oembed: InstagramOembed,
    cdnHosts: Collection<String> = DEFAULT_INSTAGRAM_CDN_HOSTS,
): ResolvedItem? {
    val url = nonEmpty(oembed.thumbnail_url) ?: return null
    if (!isAllowedMediaUrl(url, cdnHosts, requireHttps = true)) return null
    val width = oembed.thumbnail_width?.takeIf { it > 0 }
    val height = oembed.thumbnail_height?.takeIf { it > 0 }
    val container = containerForUrl(url, "jpg")

    return ResolvedItem(
        sourceId = nonEmpty(oembed.media_id)?.take(200) ?: "cover",
        index = 0,
        kind = "image",
        title = "Cover image",
        thumbnailUrl = url,
        width = width,
        height = height,
        container = container,
        plans = ensureRecommendations(
            listOf(
                ResolvedPlan(
                    kind = "image",
                    container = container,
                    label = "Cover image",
                    detail = listOfNotNull(
                        container.uppercase(),
                        if (width != null && height != null) "$width \u00d7 $height" else null,
                        "the preview Instagram publishes",
                    ).joinToString(" \u00b7 "),
                    width = width,
                    height = height,
                    requiresConversion = false,
                    recommended = true,
                    fetch = FetchPlan.Direct(url = url),
                ),
            ),
        ),
    )
}

fun buildInstagramOembedEndpoint(url: HttpUrl): HttpUrl =
    "https://www.instagram.com/api/v1/oembed/".toHttpUrlOrNull()!!
        .newBuilder()
        .addQueryParameter("url", url.toString())
        .build()

fun resolvedMediaFromInstagramNode(
    node: InstagramNode,
    url: String,
    maxItems: Int,
    cdnHosts: Collection<String> = DEFAULT_INSTAGRAM_CDN_HOSTS,
): ResolvedMedia {
    val items = itemsFrom(node, maxItems)
    if (items.isEmpty()) {
        throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "instagram: post had no usable media")
    }
    val mediaUrls = ArrayList<String>()
    for (item in items) {
        item.thumbnailUrl?.let { mediaUrls.add(it) }
        for (plan in item.plans) {
            val direct = plan.fetch as? FetchPlan.Direct
            if (direct != null) mediaUrls.add(direct.url)
        }
    }
    assertCdnHosts(mediaUrls, cdnHosts)

    val (title, author) = titleFor(node)
    return ResolvedMedia(
        provider = "instagram",
        providerLabel = "Instagram",
        url = url,
        type = if (items.size > 1) "collection" else "single",
        title = title.take(500),
        author = author,
        authorUrl = authorUrlFor(node),
        thumbnailUrl = items.firstOrNull()?.thumbnailUrl,
        items = items.take(200),
        metadata = mapOf(
            "items" to JsonPrimitive(items.size.toString()),
            "source" to JsonPrimitive("web-api"),
        ),
    )
}
