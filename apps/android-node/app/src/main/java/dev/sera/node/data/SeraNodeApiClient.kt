package dev.sera.node.data

import dev.sera.node.model.AcceptedResponse
import dev.sera.node.model.AndroidAppUpdateInfo
import dev.sera.node.model.ClaimRequest
import dev.sera.node.model.FailedRequest
import dev.sera.node.model.FileUploadStatusResponse
import dev.sera.node.model.NodeUpdateManifest
import dev.sera.node.model.ProgressRequest
import dev.sera.node.model.ProgressResponse
import dev.sera.node.model.RemoteTask
import dev.sera.node.model.ResolvedBody
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.SeraJson
import dev.sera.node.model.YtdlpUpdateInfo
import dev.sera.node.model.isValidTaskId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

class FatalAuthException(val statusCode: Int) :
    IOException("Extraction node authentication rejected ($statusCode)")

class ApiStatusException(val statusCode: Int, val bodyText: String) :
    IOException("API returned HTTP $statusCode${if (bodyText.isNotBlank()) ": $bodyText" else ""}")

class TaskCancelledException : IOException("Task cancelled by server")

class NonRetryableUploadException(val statusCode: Int, message: String) : IOException(message)

class UploadOffsetMismatchException(val receivedBytes: Long) :
    IOException("Upload offset exceeded server received bytes ($receivedBytes)")

sealed interface ClaimOutcome {
    data class Task(val task: RemoteTask, val manifestHash: String?) : ClaimOutcome
    data class NoTask(val elapsedMs: Long, val manifestHash: String?) : ClaimOutcome
}

sealed interface ConnectionTestResult {
    data class Success(
        val latencyMs: Long,
        val message: String,
        val manifestHash: String? = null,
    ) : ConnectionTestResult

    data class AuthRejected(
        val statusCode: Int,
        val message: String,
    ) : ConnectionTestResult

    data class Failure(
        val message: String,
    ) : ConnectionTestResult
}

@Serializable
private data class GithubReleaseResponse(
    val tag_name: String = "",
    val draft: Boolean = false,
    val body: String? = null,
    val assets: List<GithubAsset> = emptyList(),
)

@Serializable
private data class GithubAndroidManifestAsset(
    val versionCode: Int,
    val versionName: String,
    val sha256: String,
    val apkUrl: String? = null,
    val assetName: String? = null,
    val releaseNotes: String? = null,
    val minVersionCode: Int? = null,
)

@Serializable
private data class GithubAsset(
    val name: String = "",
    val browser_download_url: String = "",
)

@Serializable
private data class ToolsManifestJson(
    val ytdlp: ToolsManifestYtdlp? = null,
)

@Serializable
private data class ToolsManifestYtdlp(
    val version: String = "",
    val repo: String = "yt-dlp/yt-dlp",
    val checksumAsset: String = "SHA2-256SUMS",
    val assets: Map<String, String> = emptyMap(),
)

class SeraNodeApiClient(
    baseHttpClient: OkHttpClient,
    private val githubApiBaseUrl: String = "https://api.github.com",
    private val githubRawBaseUrl: String = "https://raw.githubusercontent.com",
    private val githubWebBaseUrl: String = "https://github.com",
) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val octetStreamMediaType = "application/octet-stream".toMediaType()

    private val claimClient: OkHttpClient = baseHttpClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(65, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(70, TimeUnit.SECONDS)
        .build()

    private val apiClient: OkHttpClient = baseHttpClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(35, TimeUnit.SECONDS)
        .build()

    private val uploadClient: OkHttpClient = baseHttpClient.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(10, TimeUnit.MINUTES)
        .callTimeout(15, TimeUnit.MINUTES)
        .retryOnConnectionFailure(false)
        .build()

    private val testClient: OkHttpClient = baseHttpClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()

    suspend fun testConnection(
        baseUrl: String,
        token: String,
    ): ConnectionTestResult {
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/updates/manifest")
        val parsedUrl = url.toHttpUrlOrNull()
            ?: return ConnectionTestResult.Failure("Invalid server URL")
        val authHeader = runCatching { bearerHeader(token) }.getOrElse {
            return ConnectionTestResult.Failure("Invalid node token")
        }
        val request = Request.Builder()
            .url(parsedUrl)
            .header("Authorization", authHeader)
            .get()
            .build()
        val startedNs = System.nanoTime()
        return try {
            val response = awaitCall(testClient.newCall(request))
            withContext(Dispatchers.IO) {
                response.use { res ->
                    val latencyMs = ((System.nanoTime() - startedNs) / 1_000_000L).coerceAtLeast(0L)
                    when (res.code) {
                        401, 403 -> ConnectionTestResult.AuthRejected(
                            statusCode = res.code,
                            message = "Authentication rejected (HTTP ${res.code})",
                        )
                        in 200..299 -> {
                            val raw = res.body?.string().orEmpty()
                            val manifest = runCatching {
                                SeraJson.decodeFromString<NodeUpdateManifest>(raw)
                            }.getOrNull()
                            ConnectionTestResult.Success(
                                latencyMs = latencyMs,
                                message = "Connected (${latencyMs} ms)",
                                manifestHash = manifest?.manifestHash?.takeIf { it.isNotBlank() }
                                    ?: res.header("X-Sera-Manifest-Hash")?.trim()?.takeIf { it.isNotEmpty() },
                            )
                        }
                        else -> ConnectionTestResult.Failure("Server returned HTTP ${res.code}")
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (err: Throwable) {
            ConnectionTestResult.Failure(err.message?.take(200) ?: "Connection failed")
        }
    }

    suspend fun claim(
        baseUrl: String,
        token: String,
        requestPayload: ClaimRequest,
        onActiveCall: (Call?) -> Unit = {},
    ): ClaimOutcome {
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/claim")
        val body = SeraJson.encodeToString(requestPayload).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .post(body)
            .build()

        val startedAt = System.currentTimeMillis()
        val call = claimClient.newCall(request)
        onActiveCall(call)
        return try {
            val response = awaitCall(call)
            withContext(Dispatchers.IO) {
                response.use { res ->
                    val elapsedMs = System.currentTimeMillis() - startedAt
                    val manifestHash = res.header("X-Sera-Manifest-Hash")?.trim()?.ifEmpty { null }
                    when (res.code) {
                        204 -> ClaimOutcome.NoTask(elapsedMs, manifestHash)
                        401, 403 -> throw FatalAuthException(res.code)
                        in 200..299 -> {
                            val raw = res.body?.string().orEmpty()
                            val task = SeraJson.decodeFromString<RemoteTask>(raw)
                            ClaimOutcome.Task(task, manifestHash)
                        }
                        else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                    }
                }
            }
        } finally {
            onActiveCall(null)
        }
    }

    suspend fun reportProgress(
        baseUrl: String,
        token: String,
        taskId: String,
        progress: ProgressRequest,
    ): ProgressResponse {
        val safeTaskId = requireValidTaskId(taskId)
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/progress")
        val body = SeraJson.encodeToString(progress).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .post(body)
            .build()

        val response = awaitCall(apiClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    401, 403 -> throw FatalAuthException(res.code)
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        if (raw.isBlank()) ProgressResponse(false)
                        else SeraJson.decodeFromString<ProgressResponse>(raw)
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                }
            }
        }
    }

    suspend fun submitResolved(
        baseUrl: String,
        token: String,
        taskId: String,
        media: ResolvedMedia,
    ): AcceptedResponse {
        val safeTaskId = requireValidTaskId(taskId)
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/resolved")
        val body = SeraJson.encodeToString(ResolvedBody(media)).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .post(body)
            .build()

        val response = awaitCall(apiClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    401, 403 -> throw FatalAuthException(res.code)
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        val parsed = if (raw.isBlank()) AcceptedResponse(true)
                        else SeraJson.decodeFromString<AcceptedResponse>(raw)
                        if (!parsed.accepted) {
                            throw ApiStatusException(res.code, "server rejected resolved payload")
                        }
                        parsed
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                }
            }
        }
    }

    suspend fun queryFileStatus(
        baseUrl: String,
        token: String,
        taskId: String,
        fileName: String,
    ): FileUploadStatusResponse {
        val safeTaskId = requireValidTaskId(taskId)
        val endpoint = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/file")
            .toHttpUrlOrNull()
            ?.newBuilder()
            ?.addQueryParameter("name", fileName)
            ?.build()
            ?: throw IllegalArgumentException("Invalid API URL: $baseUrl")

        val request = Request.Builder()
            .url(endpoint)
            .header("Authorization", bearerHeader(token))
            .get()
            .build()

        val response = awaitCall(apiClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    401, 403 -> throw FatalAuthException(res.code)
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        if (raw.isBlank()) FileUploadStatusResponse()
                        else SeraJson.decodeFromString<FileUploadStatusResponse>(raw)
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(300))
                }
            }
        }
    }

    suspend fun uploadFile(
        baseUrl: String,
        token: String,
        taskId: String,
        file: File,
        fileName: String,
        mimeType: String,
        offsetBytes: Long = 0L,
        onBytesDelta: (Long) -> Unit = {},
    ): AcceptedResponse {
        val safeTaskId = requireValidTaskId(taskId)
        val totalSize = file.length()
        val safeOffset = offsetBytes.coerceIn(0L, totalSize)
        val remainingBytes = (totalSize - safeOffset).coerceAtLeast(0L)

        val endpointBuilder = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/file")
            .toHttpUrlOrNull()
            ?.newBuilder()
            ?.addQueryParameter("name", fileName)
            ?.addQueryParameter("mime", mimeType)
            ?: throw IllegalArgumentException("Invalid API URL: $baseUrl")
        if (safeOffset > 0L) {
            endpointBuilder.addQueryParameter("offset", safeOffset.toString())
        }
        val endpoint = endpointBuilder.build()

        val streamingBody = object : RequestBody() {
            override fun contentType(): MediaType = octetStreamMediaType

            override fun contentLength(): Long = remainingBytes

            override fun writeTo(sink: BufferedSink) {
                FileInputStream(file).use { input ->
                    var toSkip = safeOffset
                    while (toSkip > 0L) {
                        val skipped = input.skip(toSkip)
                        if (skipped > 0L) {
                            toSkip -= skipped
                        } else {
                            if (input.read() == -1) break
                            toSkip -= 1L
                        }
                    }
                    val buffer = ByteArray(65_536)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        sink.write(buffer, 0, read)
                        onBytesDelta(read.toLong())
                    }
                }
            }
        }

        val reqBuilder = Request.Builder()
            .url(endpoint)
            .header("Authorization", bearerHeader(token))
        if (safeOffset > 0L && totalSize > safeOffset) {
            reqBuilder.header("Content-Range", "bytes $safeOffset-${totalSize - 1}/$totalSize")
        }
        val request = reqBuilder.post(streamingBody).build()

        val response = awaitCall(uploadClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    409 -> throw TaskCancelledException()
                    401, 403 -> throw FatalAuthException(res.code)
                    416 -> {
                        val serverReceived = res.header("X-Sera-Received-Bytes")?.toLongOrNull() ?: 0L
                        throw UploadOffsetMismatchException(serverReceived)
                    }
                    400, 404, 413, 415 -> throw NonRetryableUploadException(
                        res.code,
                        "Upload of $fileName rejected (${res.code}): ${res.body?.string().orEmpty().take(300)}",
                    )
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        val parsed = if (raw.isBlank()) AcceptedResponse(true, totalSize)
                        else SeraJson.decodeFromString<AcceptedResponse>(raw)
                        if (parsed.cancelled == true) throw TaskCancelledException()
                        if (!parsed.accepted) {
                            throw ApiStatusException(res.code, "server did not accept uploaded file $fileName")
                        }
                        parsed
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                }
            }
        }
    }

    suspend fun completeTask(
        baseUrl: String,
        token: String,
        taskId: String,
    ): AcceptedResponse {
        val safeTaskId = requireValidTaskId(taskId)
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/complete")
        val body = "{}".toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .post(body)
            .build()

        val response = awaitCall(apiClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    401, 403 -> throw FatalAuthException(res.code)
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        val parsed = if (raw.isBlank()) AcceptedResponse(true)
                        else SeraJson.decodeFromString<AcceptedResponse>(raw)
                        if (!parsed.accepted) {
                            throw ApiStatusException(res.code, "server did not accept completion")
                        }
                        parsed
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                }
            }
        }
    }

    suspend fun failTask(
        baseUrl: String,
        token: String,
        taskId: String,
        failure: FailedRequest,
    ) {
        val safeTaskId = requireValidTaskId(taskId)
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/$safeTaskId/failed")
        val body = SeraJson.encodeToString(failure).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .post(body)
            .build()

        val response = awaitCall(apiClient.newCall(request))
        withContext(Dispatchers.IO) {
            response.use { res ->
                if (res.code == 401 || res.code == 403) throw FatalAuthException(res.code)
                if (!res.isSuccessful) {
                    throw ApiStatusException(res.code, res.body?.string().orEmpty().take(300))
                }
            }
        }
    }

    suspend fun fetchUpdateManifest(
        baseUrl: String,
        token: String,
    ): NodeUpdateManifest {
        val url = buildEndpointUrl(baseUrl, "/internal/extraction/updates/manifest")
        val request = Request.Builder()
            .url(url)
            .header("Authorization", bearerHeader(token))
            .get()
            .build()

        val response = awaitCall(apiClient.newCall(request))
        return withContext(Dispatchers.IO) {
            response.use { res ->
                when (res.code) {
                    401, 403 -> throw FatalAuthException(res.code)
                    in 200..299 -> {
                        val raw = res.body?.string().orEmpty()
                        SeraJson.decodeFromString<NodeUpdateManifest>(raw)
                    }
                    else -> throw ApiStatusException(res.code, res.body?.string().orEmpty().take(500))
                }
            }
        }
    }

    suspend fun fetchGithubLatestAndroidUpdate(repo: String): AndroidAppUpdateInfo? {
        val cleanRepo = sanitizeGithubRepo(repo) ?: return null

        val latestUrl = "${githubApiBaseUrl.trimEnd('/')}/repos/$cleanRepo/releases/latest"
        val latestResponse = awaitCall(
            apiClient.newCall(
                Request.Builder()
                    .url(latestUrl)
                    .header("Accept", "application/vnd.github+json")
                    .get()
                    .build(),
            ),
        )
        val latestRelease = withContext(Dispatchers.IO) {
            latestResponse.use { res ->
                if (!res.isSuccessful) return@use null
                val raw = res.body?.string().orEmpty()
                runCatching { SeraJson.decodeFromString<GithubReleaseResponse>(raw) }.getOrNull()
            }
        }
        if (latestRelease != null && !latestRelease.draft) {
            extractAndroidUpdateFromRelease(latestRelease)?.let { return it }
        }

        val listUrl = "${githubApiBaseUrl.trimEnd('/')}/repos/$cleanRepo/releases?per_page=10"
        val listResponse = awaitCall(
            apiClient.newCall(
                Request.Builder()
                    .url(listUrl)
                    .header("Accept", "application/vnd.github+json")
                    .get()
                    .build(),
            ),
        )
        val releases = withContext(Dispatchers.IO) {
            listResponse.use { res ->
                if (!res.isSuccessful) return@use emptyList()
                val raw = res.body?.string().orEmpty()
                runCatching { SeraJson.decodeFromString<List<GithubReleaseResponse>>(raw) }.getOrDefault(emptyList())
            }
        }
        for (release in releases) {
            if (release.draft) continue
            extractAndroidUpdateFromRelease(release)?.let { return it }
        }
        return null
    }

    private suspend fun extractAndroidUpdateFromRelease(release: GithubReleaseResponse): AndroidAppUpdateInfo? {
        val manifestAsset = release.assets.firstOrNull {
            it.name.equals("android-node-manifest.json", ignoreCase = true)
        }
        if (manifestAsset != null && isTrustedGithubUrl(manifestAsset.browser_download_url)) {
            val assetResponse = awaitCall(
                apiClient.newCall(Request.Builder().url(manifestAsset.browser_download_url).get().build()),
            )
            val parsed = withContext(Dispatchers.IO) {
                assetResponse.use { res ->
                    if (!res.isSuccessful) return@use null
                    val raw = res.body?.string().orEmpty()
                    runCatching { SeraJson.decodeFromString<GithubAndroidManifestAsset>(raw) }.getOrNull()
                }
            }
            if (parsed != null && parsed.versionCode > 0 && SHA256_REGEX.matches(parsed.sha256.trim())) {
                val apkAsset = (parsed.assetName?.let { target ->
                    release.assets.firstOrNull { it.name == target }
                }) ?: release.assets.firstOrNull {
                    it.name.endsWith(".apk", ignoreCase = true) && it.name.contains("arm64", ignoreCase = true)
                } ?: release.assets.firstOrNull { it.name.endsWith(".apk", ignoreCase = true) }
                val resolvedApkUrl = parsed.apkUrl?.takeIf { it.isNotBlank() } ?: apkAsset?.browser_download_url
                if (!resolvedApkUrl.isNullOrBlank() && isTrustedGithubUrl(resolvedApkUrl)) {
                    return AndroidAppUpdateInfo(
                        versionCode = parsed.versionCode,
                        versionName = parsed.versionName,
                        sha256 = parsed.sha256.trim().lowercase(),
                        apkUrl = resolvedApkUrl,
                        proxyPath = "",
                        releaseNotes = parsed.releaseNotes ?: release.body?.take(1000),
                        minVersionCode = parsed.minVersionCode,
                    )
                }
            }
        }

        val apkAsset = release.assets.firstOrNull {
            it.name.endsWith(".apk", ignoreCase = true) && it.name.contains("arm64", ignoreCase = true)
        } ?: release.assets.firstOrNull { it.name.endsWith(".apk", ignoreCase = true) } ?: return null
        if (!isTrustedGithubUrl(apkAsset.browser_download_url)) return null

        val checksumAsset = release.assets.firstOrNull {
            it.name.equals("${apkAsset.name}.sha256", ignoreCase = true) ||
                it.name.equals("SHA256SUMS", ignoreCase = true) ||
                it.name.equals("SHA2-256SUMS", ignoreCase = true)
        } ?: return null
        if (!isTrustedGithubUrl(checksumAsset.browser_download_url)) return null

        val sha256 = fetchSha256ForAsset(checksumAsset.browser_download_url, apkAsset.name) ?: return null
        val versionCode = parseVersionCodeFromTag(release.tag_name) ?: return null
        val versionName = release.tag_name
            .removePrefix("android-node-v")
            .removePrefix("v")
            .substringBefore('+')
            .ifBlank { release.tag_name }
        return AndroidAppUpdateInfo(
            versionCode = versionCode,
            versionName = versionName,
            sha256 = sha256,
            apkUrl = apkAsset.browser_download_url,
            proxyPath = "",
            releaseNotes = release.body?.take(1000),
            minVersionCode = null,
        )
    }

    suspend fun fetchGithubYtdlpManifest(repo: String): YtdlpUpdateInfo? {
        val cleanRepo = sanitizeGithubRepo(repo) ?: return null
        val url = "${githubRawBaseUrl.trimEnd('/')}/$cleanRepo/main/scripts/tools.manifest.json"
        val response = awaitCall(apiClient.newCall(Request.Builder().url(url).get().build()))
        val parsed = withContext(Dispatchers.IO) {
            response.use { res ->
                if (!res.isSuccessful) return@use null
                val raw = res.body?.string().orEmpty()
                runCatching { SeraJson.decodeFromString<ToolsManifestJson>(raw) }.getOrNull()
            }
        }?.ytdlp ?: return null

        val parsedRepo = sanitizeGithubRepo(parsed.repo) ?: return null
        val parsedVersion = sanitizeGithubSegment(parsed.version) ?: return null
        val parsedChecksumAsset = sanitizeGithubAssetName(parsed.checksumAsset) ?: return null
        val assetName = sanitizeGithubAssetName(parsed.assets["android-arm64"] ?: "yt-dlp") ?: return null
        val checksumUrl =
            "${githubWebBaseUrl.trimEnd('/')}/$parsedRepo/releases/download/$parsedVersion/$parsedChecksumAsset"
        val sha256 = fetchSha256ForAsset(checksumUrl, assetName) ?: return null
        val downloadUrl =
            "${githubWebBaseUrl.trimEnd('/')}/$parsedRepo/releases/download/$parsedVersion/$assetName"
        return YtdlpUpdateInfo(
            version = parsedVersion,
            assetName = assetName,
            sha256 = sha256,
            url = downloadUrl,
            proxyPath = "/internal/extraction/updates/ytdlp",
        )
    }

    private fun isTrustedGithubUrl(rawUrl: String): Boolean {
        val parsed = rawUrl.trim().toHttpUrlOrNull() ?: return false
        if (parsed.scheme == "https") return true
        if (parsed.scheme != "http") return false
        return matchesBaseOrigin(parsed, githubWebBaseUrl) || matchesBaseOrigin(parsed, githubApiBaseUrl)
    }

    private fun matchesBaseOrigin(url: HttpUrl, baseUrl: String): Boolean {
        val base = baseUrl.trim().toHttpUrlOrNull() ?: return false
        return url.scheme == base.scheme &&
            url.host.equals(base.host, ignoreCase = true) &&
            url.port == base.port
    }

    private suspend fun fetchSha256ForAsset(checksumUrl: String, assetName: String): String? {
        val response = awaitCall(apiClient.newCall(Request.Builder().url(checksumUrl).get().build()))
        val body = withContext(Dispatchers.IO) {
            response.use { res ->
                if (!res.isSuccessful) null else res.body?.string()
            }
        } ?: return null
        return parseChecksumLine(body, assetName)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun awaitCall(call: Call): Response {
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation {
                call.cancel()
            }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) {
                        cont.resumeWithException(e)
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    cont.resume(response) { _, res, _ ->
                        res.close()
                    }
                }
            })
        }
    }

    companion object {
        private val VALID_GITHUB_REPO = Regex("^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$")
        private val VALID_GITHUB_SEGMENT = Regex("^[A-Za-z0-9._+-]{1,64}$")
        private val VALID_GITHUB_ASSET = Regex("^[A-Za-z0-9._-]{1,128}$")
        private val SHA256_REGEX = Regex("^[a-fA-F0-9]{64}$")

        private fun requireValidTaskId(taskId: String): String {
            val cleaned = taskId.trim()
            if (!isValidTaskId(cleaned)) {
                throw IllegalArgumentException("Invalid task id")
            }
            return cleaned
        }

        private fun bearerHeader(token: String): String {
            val trimmed = token.trim()
            if (trimmed.isEmpty() || trimmed.any { it.code < 0x21 || it.code > 0x7E }) {
                throw IllegalArgumentException("Invalid authorization token")
            }
            return "Bearer $trimmed"
        }

        private fun sanitizeGithubRepo(repo: String): String? {
            val clean = repo.trim().trim('/')
            if (!VALID_GITHUB_REPO.matches(clean)) return null
            val parts = clean.split('/')
            if (parts.any { it == "." || it == ".." }) return null
            return clean
        }

        private fun sanitizeGithubSegment(segment: String): String? {
            val clean = segment.trim()
            if (!VALID_GITHUB_SEGMENT.matches(clean) || clean == "." || clean == ".." || clean.contains("..")) {
                return null
            }
            return clean
        }

        private fun sanitizeGithubAssetName(name: String): String? {
            val clean = name.trim()
            if (!VALID_GITHUB_ASSET.matches(clean) || clean == "." || clean == ".." || clean.contains("..")) {
                return null
            }
            return clean
        }

        fun buildEndpointUrl(baseUrl: String, path: String): String {
            val normalizedBase = NodeSettings.normalizeBaseUrl(baseUrl)
            val normalizedPath = if (path.startsWith("/")) path else "/$path"
            return "$normalizedBase$normalizedPath"
        }

        fun parseChecksumLine(checksumText: String, assetName: String): String? {
            for (line in checksumText.lineSequence()) {
                val trimmed = line.trim()
                if (trimmed.isEmpty()) continue
                val parts = trimmed.split(Regex("\\s+"), limit = 2)
                if (parts.isEmpty()) continue
                val hash = parts[0].lowercase()
                if (!Regex("^[a-f0-9]{64}$").matches(hash)) continue
                if (parts.size == 1) return hash
                val target = parts[1].removePrefix("*").trim()
                if (target == assetName || target.endsWith("/$assetName")) {
                    return hash
                }
            }
            return null
        }

        fun parseVersionCodeFromTag(tag: String): Int? {
            val trimmed = tag.trim()
            val buildSuffix = Regex("\\+(\\d+)$").find(trimmed)?.groupValues?.get(1)?.toIntOrNull()
            if (buildSuffix != null && buildSuffix > 0) return buildSuffix
            val explicitBuild = Regex("^(?:build|code)[-_]?(\\d+)$", RegexOption.IGNORE_CASE)
                .matchEntire(trimmed)
                ?.groupValues?.get(1)?.toIntOrNull()
            if (explicitBuild != null && explicitBuild > 0) return explicitBuild
            return trimmed.toIntOrNull()?.takeIf { it > 0 }
        }
    }
}
