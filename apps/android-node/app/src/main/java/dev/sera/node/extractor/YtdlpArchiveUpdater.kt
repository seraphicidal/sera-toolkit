package dev.sera.node.extractor

import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

private val SHA256_HEX_REGEX = Regex("^[a-f0-9]{64}$")

class YtdlpArchiveUpdater(
    baseClient: OkHttpClient,
) {
    private val downloadClient: OkHttpClient = baseClient.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(6, TimeUnit.MINUTES)
        .build()

    suspend fun updateFromManifest(
        manifest: YtdlpUpdateInfo,
        targetBinaryFile: File,
        versionMarkerFile: File,
        currentInstalledVersion: String?,
        authToken: String?,
        apiBaseUrl: String?,
        force: Boolean = false,
    ): ToolUpdateResult = withContext(Dispatchers.IO) {
        val rawSha = manifest.sha256?.trim()?.ifEmpty { null }
        val manifestSha = rawSha?.let { normalizeSha256(it) }
        if (manifestSha != null && !SHA256_HEX_REGEX.matches(manifestSha)) {
            return@withContext ToolUpdateResult(
                updated = false,
                previousVersion = currentInstalledVersion,
                currentVersion = currentInstalledVersion,
                sha256Verified = false,
                message = "Invalid yt-dlp SHA-256 in manifest",
            )
        }

        val markerVersion = versionMarkerFile.takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
        val knownCurrent = currentInstalledVersion ?: markerVersion

        if (
            !force &&
            manifestSha != null &&
            targetBinaryFile.isFile &&
            knownCurrent == manifest.version &&
            matchesSha256(targetBinaryFile, manifestSha)
        ) {
            return@withContext ToolUpdateResult(
                updated = false,
                previousVersion = knownCurrent,
                currentVersion = knownCurrent,
                sha256Verified = true,
                message = "yt-dlp $knownCurrent already up to date",
            )
        }

        val baseOriginUrl = apiBaseUrl?.trim()?.trimEnd('/')?.toHttpUrlOrNull()
        val allTargets = resolveTargets(
            apiBaseUrl = apiBaseUrl,
            proxyPath = manifest.proxyPath,
            directUrl = manifest.url,
        )
        val targets = if (manifestSha != null) {
            allTargets
        } else {
            allTargets.filter { it.sendAuthHeader }
        }
        if (targets.isEmpty()) {
            return@withContext ToolUpdateResult(
                updated = false,
                previousVersion = knownCurrent,
                currentVersion = knownCurrent,
                sha256Verified = false,
                message = if (manifestSha == null) {
                    "Missing yt-dlp SHA-256 in manifest"
                } else {
                    "No yt-dlp download URL available"
                },
            )
        }

        targetBinaryFile.parentFile?.mkdirs()
        val staging = File(targetBinaryFile.parentFile, "${targetBinaryFile.name}.download")
        val backup = File(targetBinaryFile.parentFile, "${targetBinaryFile.name}.old")
        var lastError = "yt-dlp download failed"

        for (target in targets) {
            currentCoroutineContext().ensureActive()
            staging.delete()
            val reqBuilder = Request.Builder().url(target.url).get()
            if (target.sendAuthHeader) {
                val safeToken = authToken?.trim()?.takeIf { t -> t.isNotEmpty() && t.all { it.code in 0x21..0x7E } }
                if (safeToken != null) {
                    reqBuilder.header("Authorization", "Bearer $safeToken")
                }
            }
            val call = downloadClient.newCall(reqBuilder.build())
            val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
                if (cause != null) call.cancel()
            }
            try {
                val response = awaitCall(call)
                response.use { res ->
                    if (!res.isSuccessful) {
                        lastError = "HTTP ${res.code} downloading ${target.url}"
                        return@use
                    }
                    val sameOriginFinal = baseOriginUrl != null && isSameOrigin(baseOriginUrl, res.request.url)
                    val headerSha = if (target.sendAuthHeader && sameOriginFinal) {
                        res.header("X-Sera-Sha256")?.let { normalizeSha256(it) }
                            ?.takeIf { SHA256_HEX_REGEX.matches(it) }
                    } else {
                        null
                    }
                    val expectedSha = manifestSha ?: headerSha
                    if (expectedSha == null) {
                        lastError = "Missing yt-dlp SHA-256 verification header"
                        return@use
                    }
                    val body = res.body ?: run {
                        lastError = "Empty yt-dlp response body"
                        return@use
                    }
                    val digest = MessageDigest.getInstance("SHA-256")
                    val buffer = ByteArray(65_536)
                    var totalBytes = 0L

                    body.byteStream().use { input ->
                        FileOutputStream(staging).use { output ->
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val read = input.read(buffer)
                                if (read <= 0) break
                                output.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                                totalBytes += read
                            }
                            output.fd.sync()
                        }
                    }

                    if (totalBytes < 100_000L) {
                        staging.delete()
                        lastError = "Downloaded yt-dlp payload too small ($totalBytes bytes)"
                        return@use
                    }

                    if (!looksLikeZipappOrExecutable(staging)) {
                        staging.delete()
                        lastError = "Downloaded yt-dlp payload is not a valid zipapp"
                        return@use
                    }

                    val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                    if (actualSha != expectedSha) {
                        staging.delete()
                        lastError = "SHA-256 mismatch for yt-dlp (expected $expectedSha, got $actualSha)"
                        return@use
                    }

                    staging.setExecutable(true, true)
                    backup.delete()
                    if (targetBinaryFile.exists()) {
                        if (!targetBinaryFile.renameTo(backup)) {
                            targetBinaryFile.delete()
                        }
                    }
                    if (!staging.renameTo(targetBinaryFile)) {
                        staging.copyTo(targetBinaryFile, overwrite = true)
                        staging.delete()
                    }
                    targetBinaryFile.setExecutable(true, true)
                    backup.delete()
                    versionMarkerFile.writeText("${manifest.version}\n", Charsets.UTF_8)

                    return@withContext ToolUpdateResult(
                        updated = true,
                        previousVersion = knownCurrent,
                        currentVersion = manifest.version,
                        sha256Verified = true,
                        message = if (knownCurrent != null) {
                            "Updated yt-dlp $knownCurrent -> ${manifest.version}"
                        } else {
                            "Installed yt-dlp ${manifest.version}"
                        },
                    )
                }
            } catch (cancelled: CancellationException) {
                call.cancel()
                staging.delete()
                throw cancelled
            } catch (error: IOException) {
                staging.delete()
                lastError = error.message ?: "Network error downloading yt-dlp"
            } finally {
                cancelHandle?.dispose()
            }
        }

        ToolUpdateResult(
            updated = false,
            previousVersion = knownCurrent,
            currentVersion = knownCurrent,
            sha256Verified = false,
            message = lastError,
        )
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun awaitCall(call: Call): Response {
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
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

    data class UpdateTarget(
        val url: String,
        val sendAuthHeader: Boolean,
    )

    companion object {
        fun normalizeSha256(raw: String?): String =
            raw.orEmpty().trim().removePrefix("sha256:").removePrefix("SHA256:").trim().lowercase()

        fun computeSha256Hex(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(65_536)
            FileInputStream(file).use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }

        fun matchesSha256(file: File, expectedHex: String): Boolean {
            val expected = normalizeSha256(expectedHex)
            if (!SHA256_HEX_REGEX.matches(expected) || !file.isFile) return false
            return computeSha256Hex(file) == expected
        }

        fun looksLikeZipappOrExecutable(file: File): Boolean {
            if (!file.isFile || file.length() < 4) return false
            val head = ByteArray(4)
            FileInputStream(file).use { if (it.read(head) < 4) return false }
            val isShebang = head[0] == '#'.code.toByte() && head[1] == '!'.code.toByte()
            val isZip = head[0] == 0x50.toByte() && head[1] == 0x4b.toByte() && head[2] == 0x03.toByte() && head[3] == 0x04.toByte()
            return isShebang || isZip
        }

        fun isSameOrigin(a: HttpUrl, b: HttpUrl): Boolean {
            return a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                a.port == b.port
        }

        fun resolveTargets(
            apiBaseUrl: String?,
            proxyPath: String?,
            directUrl: String?,
        ): List<UpdateTarget> {
            val targets = mutableListOf<UpdateTarget>()
            val cleanBase = apiBaseUrl?.trim()?.trimEnd('/')?.ifBlank { null }
            val baseHttpUrl = cleanBase?.toHttpUrlOrNull()
            val cleanProxy = proxyPath?.trim()?.ifBlank { null }
            if (cleanBase != null && baseHttpUrl != null && cleanProxy != null) {
                val resolved = when {
                    cleanProxy.startsWith("//") || cleanProxy.contains('\\') -> null
                    cleanProxy.startsWith("http://", ignoreCase = true) ||
                        cleanProxy.startsWith("https://", ignoreCase = true) -> {
                        val parsedProxy = cleanProxy.toHttpUrlOrNull()
                        if (parsedProxy != null && isSameOrigin(baseHttpUrl, parsedProxy)) {
                            parsedProxy.toString()
                        } else {
                            null
                        }
                    }
                    else -> {
                        val path = if (cleanProxy.startsWith("/")) cleanProxy else "/$cleanProxy"
                        val candidate = "$cleanBase$path".toHttpUrlOrNull()
                        if (candidate != null && isSameOrigin(baseHttpUrl, candidate) && !cleanProxy.contains("..")) {
                            candidate.toString()
                        } else {
                            null
                        }
                    }
                }
                if (resolved != null) {
                    targets.add(UpdateTarget(url = resolved, sendAuthHeader = true))
                }
            }
            val cleanDirect = directUrl?.trim()?.ifBlank { null }
            val parsedDirect = cleanDirect?.toHttpUrlOrNull()
            if (
                parsedDirect != null &&
                (parsedDirect.isHttps || (baseHttpUrl != null && isSameOrigin(baseHttpUrl, parsedDirect))) &&
                targets.none { it.url == parsedDirect.toString() }
            ) {
                targets.add(UpdateTarget(url = parsedDirect.toString(), sendAuthHeader = false))
            }
            return targets
        }
    }
}
