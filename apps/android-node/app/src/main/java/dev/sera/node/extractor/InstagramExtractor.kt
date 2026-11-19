package dev.sera.node.extractor

import dev.sera.node.model.DEFAULT_INSTAGRAM_USER_AGENT
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.SeraJson
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class InstagramExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "instagram"
    override val label: String = "Instagram"
    override val hosts: List<String> = INSTAGRAM_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(normalizeInstagramUrl(url))

    override fun wantsPlaylist(url: HttpUrl): Boolean = true

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> {
        val igConfig = context.hotConfig?.instagram
        val order = igConfig?.strategyOrder?.takeIf { it.isNotEmpty() }
            ?: listOf("ytdlp", "web-api", "oembed")

        val availableStrategies = mapOf(
            "ytdlp" to ExtractionStrategy(
                id = "ytdlp",
                label = "the extractor",
                run = { runExtractor(url, context, onRawJson).media },
            ),
            "web-api" to ExtractionStrategy(
                id = "web-api",
                label = "Instagram's web API, with the operator's session",
                available = { !context.runtimeConfig.instagramSessionId.isNullOrBlank() },
                answers = setOf(
                    FailureClass.UNSUPPORTED_MEDIA,
                    FailureClass.FORMAT_UNAVAILABLE,
                    FailureClass.LOGIN_REQUIRED,
                    FailureClass.AUTH_CONFIGURATION_ERROR,
                    FailureClass.RATE_LIMITED,
                    FailureClass.DATACENTER_BLOCKED,
                    FailureClass.BOT_DETECTION,
                    FailureClass.STREAM_403,
                    FailureClass.EXTRACTOR_BUG,
                ),
                run = { viaSession(url, context) },
            ),
            "oembed" to ExtractionStrategy(
                id = "oembed",
                label = "the cover image Instagram publishes for embeds",
                degraded = true,
                run = { viaOembed(url, context) },
            ),
        )

        return order.mapNotNull { availableStrategies[it] }
    }

    private suspend fun viaSession(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val shortcode = shortcodeFrom(url)
            ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "instagram: no shortcode")
        val mediaId = mediaIdFromShortcode(shortcode)
        val endpoint = "https://www.instagram.com/api/v1/media/$mediaId/info/".toHttpUrlOrNull()!!

        val igConfig = context.hotConfig?.instagram
        val appId = igConfig?.webApiAppId?.takeIf { it.isNotBlank() } ?: INSTAGRAM_APP_ID
        val userAgent = igConfig?.userAgent?.takeIf { it.isNotBlank() } ?: DEFAULT_INSTAGRAM_USER_AGENT
        val cdnHosts = igConfig?.cdnHosts?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTAGRAM_CDN_HOSTS
        val sessionId = context.runtimeConfig.instagramSessionId.orEmpty()

        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 4L * 1024L * 1024L,
            headers = sessionHeaders(sessionId = sessionId, appId = appId, userAgent = userAgent),
            keepCookies = true,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            userAgent = userAgent,
            isCancelled = context.isCancelled,
        )

        val parsed = try {
            SeraJson.decodeFromString(InstagramMediaInfoResponse.serializer(), response.body)
        } catch (cause: Exception) {
            throw seraError(
                SeraErrorCode.PROVIDER_AUTH_REQUIRED,
                detail = "instagram: session endpoint did not return JSON",
                cause = cause,
            )
        }

        val node = parsed.items?.firstOrNull()
            ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "instagram: no media in response")

        return resolvedMediaFromInstagramNode(
            node = node,
            url = url.toString(),
            maxItems = context.maxItemsPerJob,
            cdnHosts = cdnHosts,
        )
    }

    private suspend fun viaOembed(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ResolvedMedia {
        val igConfig = context.hotConfig?.instagram
        val userAgent = igConfig?.userAgent?.takeIf { it.isNotBlank() } ?: DEFAULT_INSTAGRAM_USER_AGENT
        val cdnHosts = igConfig?.cdnHosts?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTAGRAM_CDN_HOSTS
        val endpoint = buildInstagramOembedEndpoint(url)

        val response = httpFetcher.fetchText(
            url = endpoint,
            maxBytes = 256L * 1024L,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            userAgent = userAgent,
            isCancelled = context.isCancelled,
        )

        val oembed = try {
            SeraJson.decodeFromString(InstagramOembed.serializer(), response.body)
        } catch (cause: Exception) {
            throw seraError(
                SeraErrorCode.PROVIDER_AUTH_REQUIRED,
                detail = "instagram: oembed endpoint did not return JSON",
                cause = cause,
            )
        }

        val item = coverItemFrom(oembed, cdnHosts)
            ?: throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "instagram: oembed carried no thumbnail")

        val author = nonEmpty(oembed.author_name)?.take(200)
        val authorUrl = validateProviderUrl(
            oembed.author_url,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
        )
        val title = (nonEmpty(oembed.title) ?: "Post by ${author ?: "an Instagram account"}").take(500)

        return ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = "single",
            title = title,
            author = author,
            authorUrl = authorUrl,
            thumbnailUrl = item.thumbnailUrl,
            items = listOf(item),
            metadata = mapOf(
                "source" to JsonPrimitive("oembed"),
                "degraded" to JsonPrimitive("cover-image"),
            ),
        )
    }

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        try {
            return super.resolve(url, context)
        } catch (error: Throwable) {
            val failure = SeraException.from(error)
            val noVideoFormats = failure.code == SeraErrorCode.MEDIA_UNAVAILABLE &&
                failure.detail?.lowercase()?.contains("no video formats found") == true
            if (failure.code != SeraErrorCode.UNSUPPORTED_SOURCE && !noVideoFormats) {
                throw failure
            }
            throw seraError(
                SeraErrorCode.PROVIDER_AUTH_REQUIRED,
                message = "Instagram photo posts need an account, and this server does not have one.",
                hint = "Reels and video posts work. A photo post can still be sent to SERA from your own browser, where you are already signed in to Instagram.",
                detail = failure.detail ?: "instagram: no video in post",
                cause = failure,
            )
        }
    }
}
