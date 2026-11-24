package dev.sera.node.extractor

import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val ALTERNATE_CLIENTS = listOf("web_safari", "android")
private val THUMBNAIL_EXT_REGEX = Regex("""\.(jpg|jpeg|png|webp)(?:[?#]|$)""", RegexOption.IGNORE_CASE)
private val VALID_PLAYER_CLIENT_TOKEN = Regex("""^[A-Za-z0-9_+-]{1,32}$""")
private val VALID_PLAYER_CLIENTS = Regex("""^[A-Za-z0-9_,+-]{1,128}$""")

class YoutubeExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "youtube"
    override val label: String = "YouTube"
    override val hosts: List<String> = YOUTUBE_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(normalizeYoutubeUrl(url))

    override fun multiItemType(url: HttpUrl): String =
        if (wantsPlaylist(url)) "playlist" else "collection"

    override fun wantsPlaylist(url: HttpUrl): Boolean =
        url.encodedPath.startsWith("/playlist") && url.queryParameter("list") != null

    private fun sanitizePlayerClients(raw: String?): String? {
        val cleaned = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val tokens = cleaned.split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() && VALID_PLAYER_CLIENT_TOKEN.matches(it) }
        if (tokens.isEmpty()) return null
        val joined = tokens.joinToString(",")
        return joined.takeIf { VALID_PLAYER_CLIENTS.matches(it) }
    }

    private fun sanitizePotProviderUrl(raw: String?): String? {
        val cleaned = raw?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() } ?: return null
        if (hasForbiddenUrlChar(cleaned) || cleaned.contains(';')) return null
        val parsed = cleaned.toHttpUrlOrNull() ?: return null
        if (parsed.scheme != "http" && parsed.scheme != "https") return null
        if (parsed.encodedUsername.isNotEmpty() || parsed.encodedPassword.isNotEmpty()) return null
        return cleaned.takeIf { it.length <= 160 }
    }

    private fun configuredPlayerClients(context: ExtractionExecutionContext): String? {
        val hotClients = context.hotConfig?.youtube?.playerClients.orEmpty()
            .map { it.trim() }
            .filter { it.isNotEmpty() && VALID_PLAYER_CLIENT_TOKEN.matches(it) }
        if (hotClients.isNotEmpty()) {
            return sanitizePlayerClients(hotClients.joinToString(","))
        }
        return sanitizePlayerClients(context.runtimeConfig.youtubePlayerClients)
    }

    private fun configuredPotProviderUrl(context: ExtractionExecutionContext): String? {
        val hotPot = sanitizePotProviderUrl(context.hotConfig?.youtube?.potProviderUrl)
        return hotPot ?: sanitizePotProviderUrl(context.runtimeConfig.youtubePotProviderUrl)
    }

    override fun extractorArgs(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> {
        val args = ArrayList<String>()
        val clients = configuredPlayerClients(context)
        if (clients != null) args.add("youtube:player_client=$clients")
        val provider = configuredPotProviderUrl(context)
        if (provider != null) args.add("youtubepot-bgutilhttp:base_url=$provider")
        return args
    }

    override fun extraYtdlpArgs(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> = context.hotConfig?.youtube?.extraArgs.orEmpty()

    override fun remoteComponents(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): List<String> = context.hotConfig?.youtube?.remoteComponents.orEmpty()
        .map { it.trim() }
        .filter { it.isNotEmpty() }

    override fun strategiesWithRawCapture(
        url: HttpUrl,
        context: ExtractionExecutionContext,
        onRawJson: (String?) -> Unit,
    ): List<ExtractionStrategy> {
        val configured = configuredPlayerClients(context)
        val ladder = ArrayList<ExtractionStrategy>()
        ladder.add(
            ExtractionStrategy(
                id = "ytdlp",
                label = if (configured != null) "the extractor ($configured)" else "the extractor",
                run = { runExtractor(url, context, onRawJson).media },
            ),
        )
        for (client in ALTERNATE_CLIENTS) {
            if (configured == client) continue
            ladder.add(
                ExtractionStrategy(
                    id = "ytdlp:$client",
                    label = "the extractor, asking as $client",
                    answers = setOf(
                        FailureClass.FORMAT_UNAVAILABLE,
                        FailureClass.PO_TOKEN_REQUIRED,
                        FailureClass.BOT_DETECTION,
                        FailureClass.DATACENTER_BLOCKED,
                    ),
                    run = {
                        val overridden = context.copy(
                            runtimeConfig = context.runtimeConfig.copy(youtubePlayerClients = client),
                            hotConfig = context.hotConfig?.copy(
                                youtube = context.hotConfig.youtube.copy(playerClients = listOf(client)),
                            ),
                        )
                        runExtractor(url, overridden, onRawJson).media
                    },
                ),
            )
        }
        return ladder
    }

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val potStatus = if (configuredPotProviderUrl(context) != null) "configured" else "not-configured"
        val result = super.resolve(url, context)
        val withThumb = withThumbnailOption(result.media)
        val meta = LinkedHashMap<String, JsonPrimitive>()
        withThumb.metadata?.let { meta.putAll(it) }
        meta["extractionPath"] = JsonPrimitive("direct")
        meta["poTokenStatus"] = JsonPrimitive(potStatus)
        return result.copy(media = withThumb.copy(metadata = meta))
    }
}

fun withThumbnailOption(media: ResolvedMedia): ResolvedMedia =
    media.copy(
        items = media.items.map { item ->
            val thumbnail = item.thumbnailUrl
            if (thumbnail == null || item.kind != "video") {
                item
            } else {
                val extension = THUMBNAIL_EXT_REGEX.find(thumbnail)?.groupValues?.get(1)?.lowercase()
                val container = if (extension == "jpeg") "jpg" else (extension ?: "jpg")
                item.copy(
                    plans = ensureRecommendations(
                        item.plans + ResolvedPlan(
                            kind = "image",
                            container = container,
                            label = "Thumbnail",
                            detail = "${container.uppercase()} \u00b7 cover image",
                            requiresConversion = false,
                            recommended = false,
                            fetch = FetchPlan.Direct(url = thumbnail),
                        ),
                    ).take(64),
                )
            }
        },
    )
