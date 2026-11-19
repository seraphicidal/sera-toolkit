package dev.sera.node.extractor

import dev.sera.node.model.AudioExtractSpec
import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SeraJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

private val BLOCKED_CLOUD_CONTENT_TYPES = setOf(
    "text/html",
    "text/plain",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/xml",
    "text/xml",
)

private val VIDEO_EXTS = setOf("mp4", "m4v", "mov", "webm", "mkv", "avi", "flv", "ts", "m3u8", "mpd")
private val ARCHIVE_DOC_EXTS = setOf("pdf", "iso", "zip", "tar", "7z", "apk", "dmg", "exe", "epub")

private val ARCHIVE_DOC_MIMES = mapOf(
    "application/pdf" to "pdf",
    "application/x-pdf" to "pdf",
    "application/zip" to "zip",
    "application/x-zip-compressed" to "zip",
    "application/x-tar" to "tar",
    "application/tar" to "tar",
    "application/x-gtar" to "tar",
    "application/x-7z-compressed" to "7z",
    "application/vnd.android.package-archive" to "apk",
    "application/x-apple-diskimage" to "dmg",
    "application/x-iso9660-image" to "iso",
    "application/x-cd-image" to "iso",
    "application/x-msdownload" to "exe",
    "application/x-msdos-program" to "exe",
    "application/x-executable" to "exe",
    "application/vnd.microsoft.portable-executable" to "exe",
    "application/epub+zip" to "epub",
)

private val MIME_TO_CONTAINER = mapOf(
    "video/mp4" to "mp4",
    "video/webm" to "webm",
    "video/quicktime" to "mov",
    "video/x-matroska" to "mkv",
    "audio/mpeg" to "mp3",
    "audio/mp4" to "m4a",
    "audio/aac" to "aac",
    "audio/opus" to "opus",
    "audio/ogg" to "ogg",
    "audio/wav" to "wav",
    "audio/x-wav" to "wav",
    "audio/flac" to "flac",
    "image/jpeg" to "jpg",
    "image/png" to "png",
    "image/webp" to "webp",
    "image/avif" to "avif",
    "image/gif" to "gif",
) + ARCHIVE_DOC_MIMES

private val GDRIVE_FORM_REGEX = Regex(
    """<form\b[^>]*(?:id=["']download-form["']|action=["'][^"']*download[^"']*["'])[^>]*>(.*?)</form>""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)
private val FORM_ACTION_REGEX = Regex("""\baction=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val INPUT_TAG_REGEX = Regex("""<input\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val ATTR_NAME_REGEX = Regex("""\bname=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val ATTR_VALUE_REGEX = Regex("""\bvalue=["']([^"']*)["']""", RegexOption.IGNORE_CASE)

private val MEDIAFIRE_SCRAMBLED_REGEX = Regex("""\bdata-scrambled-url=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
private val MEDIAFIRE_DIRECT_REGEX = Regex("""https?://download[0-9]*\.mediafire\.com/[^\s"'<>]+""", RegexOption.IGNORE_CASE)
private val MEDIAFIRE_DOWNLOAD_HOST_REGEX = Regex("""^download[0-9]*\.mediafire\.com$""", RegexOption.IGNORE_CASE)

private val META_TAG_REGEX = Regex("""<meta\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val LINK_TAG_REGEX = Regex("""<link\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val TITLE_TAG_REGEX = Regex("""<title\b[^>]*>(.*?)</title>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val VIDEO_BLOCK_REGEX = Regex("""<video\b([^>]*)>(.*?)</video>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val AUDIO_BLOCK_REGEX = Regex("""<audio\b([^>]*)>(.*?)</audio>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val SOURCE_TAG_REGEX = Regex("""<source\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val JSON_LD_REGEX = Regex(
    """<script\b[^>]*\btype=["']application/ld\+json["'][^>]*>(.*?)</script>""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)
private val GENERIC_ATTR_REGEX = Regex("""\b([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")

fun classifyDirectMedia(contentType: String, extension: String): String {
    val ct = contentType.lowercase()
    val ext = extension.lowercase()
    if (ct == "image/gif" || (ct.isEmpty() && ext == "gif")) return "gif"
    if ((ct.startsWith("image/") && !ct.contains("svg")) || (ct.isEmpty() && ext != "svg" && ext in IMAGE_EXTENSIONS)) {
        return "image"
    }
    if (ct.startsWith("video/") || (ct.isEmpty() && ext in VIDEO_EXTS)) return "video"
    if (ct.startsWith("audio/") || (ct.isEmpty() && ext in AUDIO_EXTENSIONS)) return "audio"
    if (ct in ARCHIVE_DOC_MIMES || (ct.isEmpty() && ext in ARCHIVE_DOC_EXTS)) return "image"
    if (ct == "application/octet-stream" || ct == "binary/octet-stream") {
        if (ext in VIDEO_EXTS) return "video"
        if (ext in AUDIO_EXTENSIONS) return "audio"
        if (ext in IMAGE_EXTENSIONS) return "image"
        if (ext in ARCHIVE_DOC_EXTS) return "image"
    }
    if (ct.contains("mpegurl") || ct.contains("dash+xml")) return "video"
    return "unknown"
}

fun normalizeDirectContainer(contentType: String, extension: String): String {
    val ct = contentType.lowercase()
    val mapped = MIME_TO_CONTAINER[ct]
    if (mapped != null) return mapped
    return normalizeContainer(extension, "bin")
}

private fun filenameFromUrl(rawUrl: String, fallback: String): String {
    val parsed = rawUrl.toHttpUrlOrNull() ?: return fallback
    val segment = parsed.pathSegments.lastOrNull { it.isNotEmpty() } ?: return fallback
    return try {
        URLDecoder.decode(segment, StandardCharsets.UTF_8.name())
    } catch (_: Exception) {
        segment
    }
}

fun extractGoogleDriveConfirmUrl(html: String, base: HttpUrl): HttpUrl? {
    val formMatch = GDRIVE_FORM_REGEX.find(html) ?: return null
    val formTag = formMatch.value
    val formInner = formMatch.groupValues[1]
    val action = FORM_ACTION_REGEX.find(formTag)?.groupValues?.get(1)?.let { decodeHtmlEntities(it) } ?: return null
    val resolved = base.resolve(action) ?: return null
    val host = resolved.host.lowercase()
    if (host != "drive.google.com" && !host.endsWith(".google.com") && !host.endsWith(".googleusercontent.com")) {
        return null
    }
    val builder = resolved.newBuilder()
    var hasConfirm = resolved.queryParameter("confirm") != null
    for (inputMatch in INPUT_TAG_REGEX.findAll(formInner)) {
        val attrs = inputMatch.groupValues[1]
        val name = ATTR_NAME_REGEX.find(attrs)?.groupValues?.get(1) ?: continue
        val value = ATTR_VALUE_REGEX.find(attrs)?.groupValues?.get(1)?.let { decodeHtmlEntities(it) } ?: continue
        builder.setQueryParameter(name, value)
        if (name == "confirm") hasConfirm = true
    }
    if (!hasConfirm) {
        builder.setQueryParameter("confirm", "t")
    }
    return builder.build()
}

fun extractMediaFireDirectUrl(html: String): String? {
    val scrambled = MEDIAFIRE_SCRAMBLED_REGEX.find(html)?.groupValues?.get(1)
    if (!scrambled.isNullOrBlank()) {
        val decoded = runCatching {
            String(Base64.getDecoder().decode(scrambled.trim()), Charsets.UTF_8).trim()
        }.getOrNull()
        if (decoded != null && (decoded.startsWith("http://", ignoreCase = true) || decoded.startsWith("https://", ignoreCase = true))) {
            val parsed = decoded.toHttpUrlOrNull()
            val host = parsed?.host?.lowercase()
            if (host != null && (host == "mediafire.com" || host.endsWith(".mediafire.com"))) {
                return decoded
            }
        }
    }
    return MEDIAFIRE_DIRECT_REGEX.find(html)?.value?.trim()
}

private fun buildCloudMedia(
    providerId: String,
    providerLabel: String,
    sourceUrl: HttpUrl,
    downloadUrl: String,
    filename: String,
    contentType: String?,
    contentLength: Long?,
    maxFilesizeBytes: Long,
): ResolvedMedia {
    val cleanType = contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    if (cleanType in BLOCKED_CLOUD_CONTENT_TYPES) {
        throw seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            message = "That link doesn't point to a downloadable file.",
            detail = "$providerId: received $cleanType",
        )
    }
    if (contentLength != null && contentLength > maxFilesizeBytes) {
        throw seraError(SeraErrorCode.TOO_LARGE, detail = "$contentLength bytes exceeds limit")
    }
    val fileExt = filename.substringAfterLast('.', "").lowercase().takeIf { it.isNotEmpty() && it.length <= 5 }
        ?: downloadUrl.toHttpUrlOrNull()?.let { urlExtension(it) }
        ?: ""
    val classified = classifyDirectMedia(cleanType, fileExt)
    val kind = if (classified == "unknown") "image" else classified
    val container = normalizeDirectContainer(cleanType, fileExt)
    val stem = filename.replace(Regex("""\.[^.]+$"""), "")
    val title = sanitizeStem(stem, providerLabel)

    val plans = ArrayList<ResolvedPlan>()
    plans.add(
        ResolvedPlan(
            kind = kind,
            container = container,
            label = "Original",
            detail = joinDetail(
                container.uppercase(),
                contentLength?.let { formatBytes(it.toDouble()) },
            ),
            filesizeBytes = contentLength,
            requiresConversion = false,
            recommended = true,
            fetch = FetchPlan.Direct(url = downloadUrl),
        ),
    )

    if (kind == "video") {
        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = "mp3",
                label = "MP3",
                detail = "320 kbps \u00b7 extracted",
                audioBitrateKbps = 320.0,
                requiresConversion = true,
                recommended = true,
                fetch = FetchPlan.Direct(url = downloadUrl),
                convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
            ),
        )
        plans.add(
            ResolvedPlan(
                kind = "audio",
                container = "m4a",
                label = "M4A",
                detail = "256 kbps \u00b7 extracted",
                audioBitrateKbps = 256.0,
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = downloadUrl),
                convert = ConversionSpec.Audio(container = "m4a", bitrateKbps = 256),
            ),
        )
    } else if (kind == "gif") {
        plans.add(
            ResolvedPlan(
                kind = "video",
                container = "mp4",
                label = "MP4",
                detail = "Converted from GIF \u00b7 H.264",
                requiresConversion = true,
                recommended = false,
                fetch = FetchPlan.Direct(url = downloadUrl),
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
                fetch = FetchPlan.Direct(url = downloadUrl),
                convert = ConversionSpec.Video(container = "webm"),
            ),
        )
    }

    val item = ResolvedItem(
        sourceId = downloadUrl,
        index = 0,
        kind = kind,
        title = title,
        container = container,
        filesizeBytes = contentLength,
        plans = ensureRecommendations(plans),
    )

    return ResolvedMedia(
        provider = providerId,
        providerLabel = providerLabel,
        url = sourceUrl.toString(),
        type = "single",
        title = title,
        author = sourceUrl.host,
        items = listOf(item),
        metadata = mapOf("contentType" to JsonPrimitive(cleanType.ifEmpty { "application/octet-stream" })),
    )
}

class GoogleDriveExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "gdrive"
    override val label: String = "Google Drive"
    override val hosts: List<String> = GDRIVE_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val fileId = extractGoogleDriveId(url)
            ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "gdrive: missing file id")
        var downloadTarget = "https://drive.usercontent.google.com/download".toHttpUrlOrNull()!!
            .newBuilder()
            .addQueryParameter("id", fileId)
            .addQueryParameter("export", "download")
            .addQueryParameter("confirm", "t")
            .build()

        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        var head = httpFetcher.head(
            url = downloadTarget,
            allowPrivateAddresses = allowPrivate,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        if (head.status >= 400) {
            throw seraError(
                if (head.status == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                detail = "gdrive HEAD ${head.status}",
            )
        }

        if (head.contentType?.lowercase()?.contains("text/html") == true) {
            val page = httpFetcher.fetchText(
                url = downloadTarget,
                maxBytes = 512L * 1024L,
                allowPrivateAddresses = allowPrivate,
                timeoutMs = context.resolveTimeoutMs,
                isCancelled = context.isCancelled,
            )
            val base = page.url.toHttpUrlOrNull() ?: downloadTarget
            val confirmed = extractGoogleDriveConfirmUrl(page.body, base)
                ?: throw seraError(
                    SeraErrorCode.PRIVATE_CONTENT,
                    detail = "gdrive: file requires sign-in or confirmation could not be bypassed",
                )
            downloadTarget = confirmed
            head = httpFetcher.head(
                url = downloadTarget,
                allowPrivateAddresses = allowPrivate,
                timeoutMs = context.resolveTimeoutMs,
                isCancelled = context.isCancelled,
            )
            if (head.status >= 400) {
                throw seraError(
                    if (head.status == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                    detail = "gdrive confirmed HEAD ${head.status}",
                )
            }
        }

        val finalUrl = head.url.ifEmpty { downloadTarget.toString() }
        val filename = filenameFromUrl(finalUrl, "gdrive-$fileId")
        val media = buildCloudMedia(
            providerId = id,
            providerLabel = label,
            sourceUrl = url,
            downloadUrl = finalUrl,
            filename = filename,
            contentType = head.contentType,
            contentLength = head.contentLength,
            maxFilesizeBytes = context.runtimeConfig.maxFilesizeBytes,
        )
        return ExtractorResolveResult(media = media)
    }
}

class DropboxExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "dropbox"
    override val label: String = "Dropbox"
    override val hosts: List<String> = DROPBOX_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl {
        val builder = url.newBuilder()
        if (hostMatches(url.host, "dropbox.com")) {
            builder.removeAllQueryParameters("raw")
            builder.setQueryParameter("dl", "1")
        }
        return normalizeUrl(builder.build())
    }

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val normalized = normalize(url)
        val head = httpFetcher.head(
            url = normalized,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        if (head.status >= 400) {
            throw seraError(
                if (head.status == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                detail = "dropbox HEAD ${head.status}",
            )
        }
        val finalUrl = head.url.ifEmpty { normalized.toString() }
        val filename = filenameFromUrl(url.toString(), filenameFromUrl(finalUrl, "dropbox-file"))
        val media = buildCloudMedia(
            providerId = id,
            providerLabel = label,
            sourceUrl = url,
            downloadUrl = finalUrl,
            filename = filename,
            contentType = head.contentType,
            contentLength = head.contentLength,
            maxFilesizeBytes = context.runtimeConfig.maxFilesizeBytes,
        )
        return ExtractorResolveResult(media = media)
    }
}

class MediaFireExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "mediafire"
    override val label: String = "MediaFire"
    override val hosts: List<String> = MEDIAFIRE_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        val directUrl = if (MEDIAFIRE_DOWNLOAD_HOST_REGEX.matches(url.host)) {
            url
        } else {
            val page = httpFetcher.fetchText(
                url = url,
                maxBytes = 2L * 1024L * 1024L,
                allowPrivateAddresses = allowPrivate,
                timeoutMs = context.resolveTimeoutMs,
                isCancelled = context.isCancelled,
            )
            val extracted = extractMediaFireDirectUrl(page.body)
                ?: throw seraError(
                    SeraErrorCode.MEDIA_UNAVAILABLE,
                    detail = "mediafire: direct download URL not found on page",
                )
            parseUserUrl(extracted, allowPrivateAddresses = allowPrivate).url
        }

        val head = httpFetcher.head(
            url = directUrl,
            allowPrivateAddresses = allowPrivate,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        if (head.status >= 400) {
            throw seraError(
                if (head.status == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                detail = "mediafire HEAD ${head.status}",
            )
        }
        val finalUrl = head.url.ifEmpty { directUrl.toString() }
        val filename = filenameFromUrl(finalUrl, filenameFromUrl(url.toString(), "mediafire-file"))
        val media = buildCloudMedia(
            providerId = id,
            providerLabel = label,
            sourceUrl = url,
            downloadUrl = finalUrl,
            filename = filename,
            contentType = head.contentType,
            contentLength = head.contentLength,
            maxFilesizeBytes = context.runtimeConfig.maxFilesizeBytes,
        )
        return ExtractorResolveResult(media = media)
    }
}

class MegaExtractor(
    executor: MediaCommandExecutor,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "mega"
    override val label: String = "MEGA"
    override val hosts: List<String> = MEGA_HOSTS

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun useExtractors(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): String = "default"
}

class DirectFileExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "direct"
    override val label: String = "Direct file"
    override val hosts: List<String> = emptyList()

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        val head = httpFetcher.head(
            url = url,
            allowPrivateAddresses = context.runtimeConfig.allowPrivateAddresses,
            timeoutMs = context.resolveTimeoutMs,
            isCancelled = context.isCancelled,
        )
        if (head.status >= 400) {
            throw seraError(
                if (head.status == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                detail = "HEAD ${head.status}",
            )
        }
        val extension = urlExtension(url).orEmpty()
        val contentType = head.contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        val kind = classifyDirectMedia(contentType, extension)
        if (kind == "unknown") {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "That link doesn't point to a media file.",
                detail = "content-type ${contentType.ifEmpty { "(none)" }} for .$extension",
            )
        }
        if (head.contentLength != null && head.contentLength > context.runtimeConfig.maxFilesizeBytes) {
            throw seraError(SeraErrorCode.TOO_LARGE, detail = "${head.contentLength} bytes exceeds limit")
        }

        val isManifest = extension == "m3u8" ||
            extension == "mpd" ||
            contentType.contains("mpegurl") ||
            contentType.contains("dash+xml")
        val container = if (isManifest) "mp4" else normalizeDirectContainer(contentType, extension)
        val rawSegment = url.pathSegments.lastOrNull { it.isNotEmpty() } ?: "file"
        val filename = try {
            URLDecoder.decode(rawSegment, StandardCharsets.UTF_8.name())
        } catch (_: Exception) {
            rawSegment
        }
        val title = sanitizeStem(filename.replace(Regex("""\.[^.]+$"""), ""), "Media file")
        val targetUrl = head.url.ifEmpty { url.toString() }

        val plans = ArrayList<ResolvedPlan>()
        plans.add(
            ResolvedPlan(
                kind = kind,
                container = container,
                label = "Original",
                detail = joinDetail(
                    container.uppercase(),
                    head.contentLength?.let { formatBytes(it.toDouble()) },
                ),
                filesizeBytes = head.contentLength,
                requiresConversion = false,
                recommended = true,
                fetch = if (isManifest) {
                    FetchPlan.Ytdlp(
                        selector = "bestvideo+bestaudio/best",
                        merge = "mp4",
                        target = targetUrl,
                        useExtractors = "default",
                    )
                } else {
                    FetchPlan.Direct(url = targetUrl)
                },
            ),
        )

        if (kind == "video") {
            plans.add(directAudioPlan("mp3", "MP3", 320, targetUrl, isManifest))
            plans.add(directAudioPlan("m4a", "M4A", 256, targetUrl, isManifest))
            plans.add(directAudioPlan("wav", "WAV", null, targetUrl, isManifest))
        }
        if (kind == "gif") {
            plans.add(directConvertedVideoPlan("mp4", "MP4", targetUrl))
            plans.add(directConvertedVideoPlan("webm", "WebM", targetUrl))
        }

        val item = ResolvedItem(
            sourceId = "file",
            index = 0,
            kind = kind,
            title = title,
            container = container,
            filesizeBytes = head.contentLength,
            plans = ensureRecommendations(plans),
        )

        val media = ResolvedMedia(
            provider = id,
            providerLabel = label,
            url = url.toString(),
            type = "single",
            title = title,
            author = url.host,
            items = listOf(item),
            metadata = mapOf("contentType" to JsonPrimitive(contentType.ifEmpty { "unknown" })),
        )
        return ExtractorResolveResult(media = media)
    }

    private fun directAudioPlan(
        container: String,
        label: String,
        bitrate: Int?,
        url: String,
        isManifest: Boolean,
    ): ResolvedPlan =
        ResolvedPlan(
            kind = "audio",
            container = container,
            label = label,
            detail = if (bitrate != null) "$bitrate kbps \u00b7 extracted" else "Lossless \u00b7 extracted",
            audioBitrateKbps = bitrate?.toDouble(),
            requiresConversion = true,
            recommended = container == "mp3",
            fetch = if (isManifest) {
                FetchPlan.Ytdlp(
                    selector = "bestaudio/best",
                    audio = AudioExtractSpec(
                        format = container,
                        quality = if (bitrate != null) "${bitrate}K" else "0",
                    ),
                    target = url,
                    useExtractors = "default",
                )
            } else {
                FetchPlan.Direct(url = url)
            },
            convert = if (isManifest) null else ConversionSpec.Audio(container = container, bitrateKbps = bitrate),
        )

    private fun directConvertedVideoPlan(
        container: String,
        label: String,
        url: String,
    ): ResolvedPlan =
        ResolvedPlan(
            kind = "video",
            container = container,
            label = label,
            detail = "Converted from GIF \u00b7 ${if (container == "mp4") "H.264" else "VP9"}",
            requiresConversion = true,
            recommended = false,
            fetch = FetchPlan.Direct(url = url),
            convert = ConversionSpec.Video(container = container),
        )
}

data class RobotsGroup(
    val allow: List<String>,
    val disallow: List<String>,
)

data class RobotsRules(
    val groups: List<RobotsGroup>,
)

fun parseRobots(text: String, userAgent: String = "sera-toolkit"): RobotsRules {
    val agent = userAgent.lowercase()
    data class MutableGroup(
        val agents: MutableList<String> = ArrayList(),
        val allow: MutableList<String> = ArrayList(),
        val disallow: MutableList<String> = ArrayList(),
    )
    val groups = ArrayList<MutableGroup>()
    var current: MutableGroup? = null
    var lastLineWasAgent = false

    for (rawLine in text.lineSequence()) {
        val line = rawLine.substringBefore('#').trim()
        if (line.isEmpty()) continue
        val sep = line.indexOf(':')
        if (sep < 0) continue
        val field = line.substring(0, sep).trim().lowercase()
        val value = line.substring(sep + 1).trim()
        if (field == "user-agent") {
            if (current == null || !lastLineWasAgent) {
                current = MutableGroup()
                groups.add(current)
            }
            if (value.isNotEmpty()) current.agents.add(value.lowercase())
            lastLineWasAgent = true
            continue
        }
        lastLineWasAgent = false
        val active = current ?: continue
        if (field == "allow" && value.isNotEmpty()) active.allow.add(value)
        else if (field == "disallow") active.disallow.add(value)
    }

    val named = groups.filter { g -> g.agents.any { a -> a != "*" && agent.contains(a) } }
    val wildcard = groups.filter { g -> g.agents.contains("*") }
    val applicable = named.ifEmpty { wildcard }
    return RobotsRules(groups = applicable.map { RobotsGroup(allow = it.allow, disallow = it.disallow) })
}

private fun robotsPatternMatches(pattern: String, path: String): Int {
    if (pattern.isEmpty() || pattern.length > 512) return -1
    val anchored = pattern.endsWith('$')
    val body = if (anchored) pattern.dropLast(1) else pattern
    if (!body.contains('*')) {
        val hit = if (anchored) path == body else path.startsWith(body)
        return if (hit) body.length else -1
    }
    val parts = body.split('*')
    val first = parts.first()
    if (!path.startsWith(first)) return -1
    var cursor = first.length
    val last = parts.last()
    if (anchored && (!path.endsWith(last) || path.length - last.length < cursor)) {
        return -1
    }
    val end = if (anchored) path.length - last.length else path.length
    val limit = if (anchored) parts.size - 1 else parts.size
    for (i in 1 until limit) {
        val part = parts[i]
        if (part.isEmpty()) continue
        val found = path.indexOf(part, cursor)
        if (found < 0 || found + part.length > end) return -1
        cursor = found + part.length
    }
    return body.length
}

fun isRobotsAllowed(rules: RobotsRules, path: String): Boolean {
    var bestAllow = -1
    var bestDisallow = -1
    for (group in rules.groups) {
        for (pattern in group.allow) bestAllow = maxOf(bestAllow, robotsPatternMatches(pattern, path))
        for (pattern in group.disallow) {
            if (pattern.isEmpty()) continue
            bestDisallow = maxOf(bestDisallow, robotsPatternMatches(pattern, path))
        }
    }
    if (bestDisallow < 0) return true
    return bestAllow >= bestDisallow
}

data class DiscoveredMediaEntry(
    val url: String,
    val kind: String,
    val source: String,
    val width: Int? = null,
    val height: Int? = null,
    val mimeType: String? = null,
)

data class DiscoveredPageMedia(
    val title: String? = null,
    val description: String? = null,
    val siteName: String? = null,
    val author: String? = null,
    val thumbnail: String? = null,
    val drmProtected: Boolean = false,
    val media: List<DiscoveredMediaEntry>,
)

private val SOURCE_RANK = mapOf(
    "og:video" to 0,
    "twitter:player" to 1,
    "video" to 2,
    "audio" to 3,
    "json-ld" to 4,
    "og:image" to 5,
    "link" to 6,
)

private fun parseHtmlAttributes(attrText: String): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (m in GENERIC_ATTR_REGEX.findAll(attrText)) {
        val key = m.groupValues[1].lowercase()
        val value = m.groupValues[2].ifEmpty { m.groupValues[3] }
        out[key] = decodeHtmlEntities(value)
    }
    return out
}

private fun resolveAbsoluteMediaCandidate(candidate: String?, base: HttpUrl): String? {
    if (candidate.isNullOrBlank()) return null
    val trimmed = candidate.trim()
    if (trimmed.isEmpty() || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return null
    val resolved = base.resolve(trimmed) ?: return null
    if (resolved.scheme != "http" && resolved.scheme != "https") return null
    if (resolved.encodedUsername.isNotEmpty() || resolved.encodedPassword.isNotEmpty()) return null
    if (resolved.port != 80 && resolved.port != 443 && resolved.port != base.port) return null
    return resolved.toString()
}

private fun kindFromCandidateUrl(url: String, hint: String): String {
    val parsed = url.toHttpUrlOrNull() ?: return hint
    val ext = urlExtension(parsed) ?: return hint
    if (ext !in MEDIA_EXTENSIONS) return hint
    if (ext == "gif") return "gif"
    if (ext in IMAGE_EXTENSIONS) return "image"
    if (ext in AUDIO_EXTENSIONS) return "audio"
    return "video"
}

fun discoverHtmlMedia(html: String, pageUrl: HttpUrl): DiscoveredPageMedia {
    val found = ArrayList<DiscoveredMediaEntry>()
    val seen = HashSet<String>()

    fun add(
        rawUrl: String?,
        source: String,
        hint: String,
        width: Int? = null,
        height: Int? = null,
        mimeType: String? = null,
    ) {
        val abs = resolveAbsoluteMediaCandidate(rawUrl, pageUrl) ?: return
        if (!seen.add(abs)) return
        found.add(
            DiscoveredMediaEntry(
                url = abs,
                kind = kindFromCandidateUrl(abs, hint),
                source = source,
                width = width,
                height = height,
                mimeType = mimeType,
            ),
        )
    }

    val metas = LinkedHashMap<String, String>()
    for (m in META_TAG_REGEX.findAll(html)) {
        val attrs = parseHtmlAttributes(m.groupValues[1])
        val key = (attrs["property"] ?: attrs["name"])?.lowercase() ?: continue
        val content = attrs["content"] ?: continue
        if (key !in metas) metas[key] = content
    }

    fun meta(name: String): String? = metas[name.lowercase()]
    fun numericMeta(name: String): Int? = meta(name)?.toIntOrNull()?.takeIf { it > 0 }

    val ogVideoWidth = numericMeta("og:video:width")
    val ogVideoHeight = numericMeta("og:video:height")
    val ogVideoType = meta("og:video:type")?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    val skipOgVideo = ogVideoType.isNotEmpty() && (
        ogVideoType.startsWith("text/") ||
            ogVideoType == "application/xhtml+xml" ||
            ogVideoType.contains("shockwave-flash")
        )
    if (!skipOgVideo) {
        for (prop in listOf("og:video:secure_url", "og:video:url", "og:video")) {
            val v = meta(prop)
            if (v != null) {
                add(v, "og:video", "video", ogVideoWidth, ogVideoHeight, meta("og:video:type"))
            }
        }
    }
    add(meta("twitter:player:stream"), "twitter:player", "video")

    for (videoMatch in VIDEO_BLOCK_REGEX.findAll(html)) {
        val attrs = parseHtmlAttributes(videoMatch.groupValues[1])
        add(attrs["src"], "video", "video")
        for (srcMatch in SOURCE_TAG_REGEX.findAll(videoMatch.groupValues[2])) {
            val sAttrs = parseHtmlAttributes(srcMatch.groupValues[1])
            add(sAttrs["src"], "video", "video", mimeType = sAttrs["type"])
        }
    }

    for (audioMatch in AUDIO_BLOCK_REGEX.findAll(html)) {
        val attrs = parseHtmlAttributes(audioMatch.groupValues[1])
        add(attrs["src"], "audio", "audio")
        for (srcMatch in SOURCE_TAG_REGEX.findAll(audioMatch.groupValues[2])) {
            val sAttrs = parseHtmlAttributes(srcMatch.groupValues[1])
            add(sAttrs["src"], "audio", "audio", mimeType = sAttrs["type"])
        }
    }

    var ldTitle: String? = null
    var ldAuthor: String? = null

    fun visitLd(node: JsonElement, depth: Int = 0) {
        if (depth > 3) return
        when (node) {
            is JsonArray -> node.forEach { visitLd(it, depth) }
            is JsonObject -> {
                if (ldTitle == null) {
                    val nameVal = (node["name"] as? JsonPrimitive)?.content?.trim()
                    if (!nameVal.isNullOrEmpty()) ldTitle = nameVal
                }
                if (ldAuthor == null) {
                    val authorElem = node["author"]
                    val aName = when (authorElem) {
                        is JsonPrimitive -> authorElem.content.trim()
                        is JsonObject -> (authorElem["name"] as? JsonPrimitive)?.content?.trim()
                        else -> null
                    }
                    if (!aName.isNullOrEmpty()) ldAuthor = aName
                }
                val typeElem = node["@type"]
                val types = when (typeElem) {
                    is JsonPrimitive -> listOf(typeElem.content)
                    is JsonArray -> typeElem.mapNotNull { (it as? JsonPrimitive)?.content }
                    else -> emptyList()
                }
                if ("VideoObject" in types || "AudioObject" in types) {
                    val contentUrl = (node["contentUrl"] as? JsonPrimitive)?.content
                    add(contentUrl, "json-ld", if ("AudioObject" in types) "audio" else "video")
                }
                (node["@graph"] as? JsonArray)?.forEach { visitLd(it, depth + 1) }
                node["video"]?.let { visitLd(it, depth + 1) }
            }
            else -> Unit
        }
    }

    for (ldMatch in JSON_LD_REGEX.findAll(html)) {
        val raw = ldMatch.groupValues[1].trim()
        if (raw.isEmpty() || raw.length > 512 * 1024) continue
        val parsed = runCatching { SeraJson.parseToJsonElement(raw) }.getOrNull() ?: continue
        visitLd(parsed)
    }

    add(
        meta("og:image:secure_url") ?: meta("og:image"),
        "og:image",
        "image",
        width = numericMeta("og:image:width"),
        height = numericMeta("og:image:height"),
    )

    for (linkMatch in LINK_TAG_REGEX.findAll(html)) {
        val attrs = parseHtmlAttributes(linkMatch.groupValues[1])
        if (attrs["rel"]?.lowercase() == "image_src") {
            add(attrs["href"], "link", "image")
        }
    }

    val htmlTitle = TITLE_TAG_REGEX.find(html)?.groupValues?.get(1)?.let {
        decodeHtmlEntities(it).replace(Regex("""\s+"""), " ").trim().takeIf { s -> s.isNotEmpty() }
    }
    val finalTitle = (meta("og:title") ?: htmlTitle ?: ldTitle)?.trim()?.takeIf { it.isNotEmpty() }
    val description = (meta("og:description") ?: meta("description"))?.trim()?.takeIf { it.isNotEmpty() }
    val siteName = meta("og:site_name")?.trim()?.takeIf { it.isNotEmpty() }
    val author = (meta("author") ?: ldAuthor ?: siteName ?: pageUrl.host).trim().takeIf { it.isNotEmpty() }
    val thumbnail = resolveAbsoluteMediaCandidate(meta("og:image:secure_url") ?: meta("og:image"), pageUrl)
    val lowerHtml = html.lowercase()
    val drmProtected = found.isEmpty() && (
        lowerHtml.contains("com.widevine.alpha") ||
            lowerHtml.contains("com.microsoft.playready") ||
            lowerHtml.contains("com.apple.fps")
        )

    return DiscoveredPageMedia(
        title = finalTitle,
        description = description,
        siteName = siteName,
        author = author,
        thumbnail = thumbnail,
        drmProtected = drmProtected,
        media = found.sortedBy { SOURCE_RANK[it.source] ?: 99 },
    )
}

class GenericExtractor(
    executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
) : YtdlpBaseExtractor(executor) {

    override val id: String = "generic"
    override val label: String = "Web page"
    override val hosts: List<String> = emptyList()

    private data class CachedRobots(
        val rules: RobotsRules,
        val expiresAtMs: Long,
    )

    private val robotsCache = ConcurrentHashMap<String, CachedRobots>()

    override fun normalize(url: HttpUrl): HttpUrl = normalizeUrl(url)

    override fun useExtractors(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): String = "default"

    override suspend fun resolve(
        url: HttpUrl,
        context: ExtractionExecutionContext,
    ): ExtractorResolveResult {
        assertRobotsAllows(url, context)

        val directExt = urlExtension(url)
        if (directExt == "m3u8" || directExt == "mpd") {
            val item = toDiscoveredItem(
                DiscoveredMediaEntry(url = url.toString(), kind = "video", source = "video"),
                0,
            )
            return ExtractorResolveResult(
                media = ResolvedMedia(
                    provider = id,
                    providerLabel = label,
                    url = url.toString(),
                    type = "single",
                    title = url.host,
                    items = listOf(item),
                    metadata = mapOf("discoveredFrom" to JsonPrimitive("manifest")),
                ),
            )
        }

        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        val page = try {
            val resp = httpFetcher.fetchText(
                url = url,
                maxBytes = 2L * 1024L * 1024L,
                allowPrivateAddresses = allowPrivate,
                timeoutMs = context.resolveTimeoutMs,
                isCancelled = context.isCancelled,
            )
            val resolvedUrl = parseUserUrl(resp.url.ifEmpty { url.toString() }, allowPrivateAddresses = allowPrivate).url
            discoverHtmlMedia(resp.body, resolvedUrl)
        } catch (error: Throwable) {
            if (error is SeraException && (
                    error.code == SeraErrorCode.BLOCKED_ADDRESS ||
                        error.code == SeraErrorCode.DRM_PROTECTED ||
                        error.code == SeraErrorCode.CANCELLED ||
                        error.code == SeraErrorCode.TIMEOUT ||
                        error.detail?.startsWith("robots.txt disallows") == true
                    )
            ) {
                throw error
            }
            null
        }

        if (page != null && page.drmProtected && page.media.isEmpty()) {
            throw seraError(
                SeraErrorCode.DRM_PROTECTED,
                detail = "generic: DRM protected media on ${url.host}",
            )
        }

        if (page != null && page.media.isNotEmpty()) {
            val allowedMedia = page.media.mapNotNull { entry ->
                val checked = validateProviderUrl(entry.url, allowPrivateAddresses = allowPrivate) ?: return@mapNotNull null
                entry.copy(url = checked)
            }
            if (allowedMedia.isNotEmpty()) {
                val hasPlayable = allowedMedia.any { it.kind == "video" || it.kind == "audio" }
                val selected = (if (hasPlayable) allowedMedia.filter { it.kind != "image" } else allowedMedia)
                    .take(context.maxItemsPerJob)
                val items = selected.mapIndexed { index, media -> toDiscoveredItem(media, index) }
                val thumbnailUrl = validateProviderUrl(page.thumbnail, allowPrivateAddresses = allowPrivate)
                return ExtractorResolveResult(
                    media = ResolvedMedia(
                        provider = id,
                        providerLabel = page.siteName ?: label,
                        url = url.toString(),
                        type = if (items.size > 1) "collection" else "single",
                        title = page.title?.let { truncateText(it, 200) } ?: url.host,
                        description = page.description?.let { truncateText(it, 500) },
                        author = page.author,
                        thumbnailUrl = thumbnailUrl,
                        items = items,
                        metadata = mapOf("discoveredFrom" to JsonPrimitive(selected.firstOrNull()?.source ?: "unknown")),
                    ),
                )
            }
        }

        if (page != null && directExt != null && directExt in MEDIA_EXTENSIONS) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                detail = "generic: no declared media on ${url.host}",
            )
        }

        try {
            val delegated = super.resolve(url, context)
            val resolvedOrigin = delegated.media.url.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}:${it.port}" }
            val originalOrigin = "${url.scheme}://${url.host}:${url.port}"
            val sameOriginMedia = if (resolvedOrigin == originalOrigin) {
                delegated.media
            } else {
                delegated.media.copy(url = url.toString())
            }
            return delegated.copy(media = sameOriginMedia)
        } catch (error: Throwable) {
            val sera = SeraException.from(error)
            if (sera.code != SeraErrorCode.UNSUPPORTED_SOURCE && sera.code != SeraErrorCode.MEDIA_UNAVAILABLE) {
                throw sera
            }
        }

        throw seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            detail = "generic: no declared media on ${url.host}",
        )
    }

    private suspend fun assertRobotsAllows(url: HttpUrl, context: ExtractionExecutionContext) {
        val allowPrivate = context.runtimeConfig.allowPrivateAddresses
        parseUserUrl(url.toString(), allowPrivateAddresses = allowPrivate)
        val robotsUrl = url.newBuilder().encodedPath("/robots.txt").query(null).build()
        val originKey = "${url.scheme}://${url.host.lowercase()}:${url.port}"
        val now = System.currentTimeMillis()
        val cached = robotsCache[originKey]
        val rules = if (cached != null && cached.expiresAtMs > now) {
            cached.rules
        } else {
            val resp = try {
                httpFetcher.fetchText(
                    url = robotsUrl,
                    maxBytes = 512L * 1024L,
                    allowPrivateAddresses = allowPrivate,
                    timeoutMs = context.resolveTimeoutMs,
                    isCancelled = context.isCancelled,
                )
            } catch (error: Throwable) {
                if (error is SeraException && error.code == SeraErrorCode.BLOCKED_ADDRESS) {
                    throw error
                }
                return
            }
            if (resp.url.isNotEmpty()) {
                parseUserUrl(resp.url, allowPrivateAddresses = allowPrivate)
            }
            val parsed = parseRobots(resp.body, "sera-toolkit")
            if (robotsCache.size >= 200) robotsCache.clear()
            robotsCache[originKey] = CachedRobots(rules = parsed, expiresAtMs = now + 60_000L)
            parsed
        }
        val queryPart = url.encodedQuery?.let { "?$it" }.orEmpty()
        val targetPath = "${url.encodedPath}$queryPart"
        if (!isRobotsAllowed(rules, targetPath)) {
            throw seraError(
                SeraErrorCode.UNSUPPORTED_SOURCE,
                message = "This site asks not to be read automatically.",
                hint = "Try a direct link to the media file instead.",
                detail = "robots.txt disallows $targetPath",
            )
        }
    }

    private fun toDiscoveredItem(media: DiscoveredMediaEntry, index: Int): ResolvedItem {
        val kind = if (media.kind == "unknown") "video" else media.kind
        val ext = media.url.toHttpUrlOrNull()?.let { urlExtension(it) }.orEmpty()
        val mime = media.mimeType?.lowercase().orEmpty()
        val isManifest = ext == "m3u8" ||
            ext == "mpd" ||
            mime.contains("mpegurl") ||
            mime.contains("dash+xml")
        val container = if (isManifest) "mp4" else normalizeDirectContainer(mime, ext)

        if (isManifest) {
            val plans = listOf(
                ResolvedPlan(
                    kind = "video",
                    container = "mp4",
                    label = "Original",
                    detail = if (ext == "mpd") "MP4 \u00b7 DASH stream" else "MP4 \u00b7 HLS stream",
                    width = media.width,
                    height = media.height,
                    requiresConversion = false,
                    recommended = true,
                    fetch = FetchPlan.Ytdlp(
                        selector = "bestvideo+bestaudio/best",
                        merge = "mp4",
                        target = media.url,
                        useExtractors = "default",
                    ),
                ),
                ResolvedPlan(
                    kind = "audio",
                    container = "mp3",
                    label = "MP3",
                    detail = "320 kbps \u00b7 extracted",
                    audioBitrateKbps = 320.0,
                    requiresConversion = true,
                    recommended = true,
                    fetch = FetchPlan.Ytdlp(
                        selector = "bestaudio/best",
                        audio = AudioExtractSpec(format = "mp3", quality = "320K"),
                        target = media.url,
                        useExtractors = "default",
                    ),
                ),
            )
            return ResolvedItem(
                sourceId = media.url,
                index = index,
                kind = "video",
                width = media.width,
                height = media.height,
                container = "mp4",
                plans = ensureRecommendations(plans),
            )
        }

        val plans = ArrayList<ResolvedPlan>()
        plans.add(
            ResolvedPlan(
                kind = kind,
                container = container,
                label = "Original",
                detail = container.uppercase(),
                width = media.width,
                height = media.height,
                requiresConversion = false,
                recommended = true,
                fetch = FetchPlan.Direct(url = media.url),
            ),
        )
        if (kind == "video") {
            plans.add(
                ResolvedPlan(
                    kind = "audio",
                    container = "mp3",
                    label = "MP3",
                    detail = "320 kbps \u00b7 extracted",
                    audioBitrateKbps = 320.0,
                    requiresConversion = true,
                    recommended = true,
                    fetch = FetchPlan.Direct(url = media.url),
                    convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
                ),
            )
        }
        return ResolvedItem(
            sourceId = media.url,
            index = index,
            kind = kind,
            width = media.width,
            height = media.height,
            container = container,
            plans = ensureRecommendations(plans),
        )
    }
}
