package dev.sera.node.extractor

import dev.sera.node.model.DEFAULT_INSTAGRAM_USER_AGENT
import okhttp3.HttpUrl
import java.io.File

data class YtdlpProbeOptions(
    val playlist: Boolean = false,
    val flatPlaylist: Boolean = false,
    val extractorArgs: List<String> = emptyList(),
    val extraArgs: List<String> = emptyList(),
    val remoteComponents: List<String> = emptyList(),
    val useExtractors: String? = null,
    val proxy: String? = null,
    val timeoutMs: Long = 60_000L,
    val maxEntries: Int? = null,
    val allowPrivateAddresses: Boolean = false,
    val isCancelled: () -> Boolean = { false },
)

data class YtdlpProgress(
    val percent: Double,
    val bytesDownloaded: Long,
    val bytesTotal: Long? = null,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
    val postprocessor: String? = null,
)

data class YtdlpSectionSpec(
    val start: Double,
    val end: Double? = null,
    val forceKeyframes: Boolean = false,
)

data class YtdlpSubtitleFilter(
    val lang: String,
    val auto: Boolean,
)

data class YtdlpDownloadOptions(
    val url: String,
    val format: String,
    val workdir: File,
    val outputTemplate: String,
    val timeoutMs: Long,
    val maxFilesizeBytes: Long? = null,
    val proxy: String? = null,
    val extractorArgs: List<String> = emptyList(),
    val extraArgs: List<String> = emptyList(),
    val remoteComponents: List<String> = emptyList(),
    val useExtractors: String? = null,
    val mergeContainer: String? = null,
    val remuxContainer: String? = null,
    val audioFormat: String? = null,
    val audioQuality: String? = null,
    val playlistItem: Int? = null,
    val expectedTotalBytes: Long? = null,
    val subtitles: YtdlpSubtitleFilter? = null,
    val sections: YtdlpSectionSpec? = null,
    val loadInfoJsonPath: File? = null,
    val allowPrivateAddresses: Boolean = false,
    val isCancelled: () -> Boolean = { false },
    val onProgress: (YtdlpProgress) -> Unit = {},
)

data class YtdlpSubtitleOptions(
    val url: String,
    val workdir: File,
    val lang: String,
    val auto: Boolean,
    val format: String,
    val timeoutMs: Long,
    val playlistItem: Int? = null,
    val proxy: String? = null,
    val extractorArgs: List<String> = emptyList(),
    val extraArgs: List<String> = emptyList(),
    val remoteComponents: List<String> = emptyList(),
    val useExtractors: String? = null,
    val allowPrivateAddresses: Boolean = false,
    val isCancelled: () -> Boolean = { false },
)

data class FfprobeVideoStream(
    val codec: String,
    val width: Int? = null,
    val height: Int? = null,
    val fps: Double? = null,
)

data class FfprobeAudioStream(
    val codec: String,
    val channels: Int? = null,
    val sampleRate: Int? = null,
    val bitrate: Long? = null,
)

data class FfprobeResult(
    val durationSeconds: Double? = null,
    val formatName: String? = null,
    val sizeBytes: Long? = null,
    val bitrate: Long? = null,
    val video: FfprobeVideoStream? = null,
    val audio: FfprobeAudioStream? = null,
)

data class CommandOutput(
    val exitCode: Int,
    val stdout: String,
    val stderrTail: String,
)

interface MediaCommandExecutor {
    suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput

    suspend fun download(options: YtdlpDownloadOptions)

    suspend fun downloadSubtitles(options: YtdlpSubtitleOptions): File

    suspend fun probeMedia(
        path: File,
        timeoutMs: Long = 30_000L,
        isCancelled: () -> Boolean = { false },
    ): FfprobeResult

    suspend fun keyframeAtOrBefore(
        path: File,
        seconds: Double,
        timeoutMs: Long = 30_000L,
        isCancelled: () -> Boolean = { false },
    ): Double?

    suspend fun runFfmpeg(
        args: List<String>,
        workDir: File,
        timeoutMs: Long,
        onStdoutLine: ((String) -> Unit)? = null,
        isCancelled: () -> Boolean = { false },
    ): CommandOutput
}

data class HttpTextResponse(
    val body: String,
    val url: String,
    val status: Int = 200,
    val headers: Map<String, String> = emptyMap(),
)

data class HttpHeadResponse(
    val status: Int,
    val contentType: String? = null,
    val contentLength: Long? = null,
    val url: String,
)

data class DirectDownloadProgress(
    val bytesDownloaded: Long,
    val bytesTotal: Long? = null,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
)

data class DirectDownloadResult(
    val bytes: Long,
    val contentType: String? = null,
    val url: String,
)

interface HttpFetcher {
    suspend fun fetchText(
        url: HttpUrl,
        maxBytes: Long = 2L * 1024L * 1024L,
        headers: Map<String, String> = emptyMap(),
        keepCookies: Boolean = false,
        allowPrivateAddresses: Boolean = false,
        timeoutMs: Long = 30_000L,
        userAgent: String = DEFAULT_INSTAGRAM_USER_AGENT,
        isCancelled: () -> Boolean = { false },
    ): HttpTextResponse

    suspend fun head(
        url: HttpUrl,
        headers: Map<String, String> = emptyMap(),
        allowPrivateAddresses: Boolean = false,
        timeoutMs: Long = 30_000L,
        userAgent: String = DEFAULT_INSTAGRAM_USER_AGENT,
        isCancelled: () -> Boolean = { false },
    ): HttpHeadResponse {
        val resp = fetchText(
            url = url,
            maxBytes = 1024L,
            headers = headers,
            allowPrivateAddresses = allowPrivateAddresses,
            timeoutMs = timeoutMs,
            userAgent = userAgent,
            isCancelled = isCancelled,
        )
        return HttpHeadResponse(status = resp.status, url = resp.url)
    }

    suspend fun fetchNoFollow(
        url: HttpUrl,
        maxBytes: Long = 64L * 1024L,
        headers: Map<String, String> = emptyMap(),
        allowPrivateAddresses: Boolean = false,
        timeoutMs: Long = 15_000L,
        userAgent: String = "curl/8.7.1",
        isCancelled: () -> Boolean = { false },
    ): HttpTextResponse = fetchText(
        url = url,
        maxBytes = maxBytes,
        headers = headers,
        allowPrivateAddresses = allowPrivateAddresses,
        timeoutMs = timeoutMs,
        userAgent = userAgent,
        isCancelled = isCancelled,
    )

    suspend fun postForm(
        url: HttpUrl,
        formBody: String,
        headers: Map<String, String> = emptyMap(),
        maxBytes: Long = 2L * 1024L * 1024L,
        allowPrivateAddresses: Boolean = false,
        timeoutMs: Long = 15_000L,
        userAgent: String = DEFAULT_INSTAGRAM_USER_AGENT,
        isCancelled: () -> Boolean = { false },
    ): HttpTextResponse = throw UnsupportedOperationException("postForm not implemented")

    suspend fun downloadDirect(
        url: String,
        destination: File,
        maxBytes: Long,
        timeoutMs: Long,
        allowPrivateAddresses: Boolean = false,
        allowUrl: (HttpUrl) -> Boolean = { true },
        isCancelled: () -> Boolean = { false },
        onProgress: (DirectDownloadProgress) -> Unit = {},
    ): DirectDownloadResult
}
