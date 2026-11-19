package dev.sera.node.extractor

import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

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
            staging.delete()
            try {
                val reqBuilder = Request.Builder().url(target.url).get()
                if (target.sendAuthHeader && !authToken.isNullOrBlank()) {
                    reqBuilder.header("Authorization", "Bearer ${authToken.trim()}")
                }
                downloadClient.newCall(reqBuilder.build()).execute().use { response ->
                    if (!response.isSuccessful) {
                        lastError = "HTTP ${response.code} downloading ${target.url}"
                        return@use
                    }
                    val headerSha = if (target.sendAuthHeader) {
                        response.header("X-Sera-Sha256")?.let { normalizeSha256(it) }
                            ?.takeIf { SHA256_HEX_REGEX.matches(it) }
                    } else {
                        null
                    }
                    val expectedSha = manifestSha ?: headerSha
                    if (expectedSha == null) {
                        lastError = "Missing yt-dlp SHA-256 verification header"
                        return@use
                    }
                    val body = response.body ?: run {
                        lastError = "Empty yt-dlp response body"
                        return@use
                    }
                    val digest = MessageDigest.getInstance("SHA-256")
                    val buffer = ByteArray(65_536)
                    var totalBytes = 0L

                    body.byteStream().use { input ->
                        FileOutputStream(staging).use { output ->
                            while (true) {
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

                    staging.setExecutable(true, false)
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
                    targetBinaryFile.setExecutable(true, false)
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
            } catch (error: IOException) {
                staging.delete()
                lastError = error.message ?: "Network error downloading yt-dlp"
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

        fun resolveTargets(
            apiBaseUrl: String?,
            proxyPath: String?,
            directUrl: String?,
        ): List<UpdateTarget> {
            val targets = mutableListOf<UpdateTarget>()
            val cleanBase = apiBaseUrl?.trim()?.trimEnd('/')?.ifBlank { null }
            val cleanProxy = proxyPath?.trim()?.ifBlank { null }
            if (cleanBase != null && cleanProxy != null) {
                val resolved = if (
                    cleanProxy.startsWith("http://", ignoreCase = true) ||
                    cleanProxy.startsWith("https://", ignoreCase = true)
                ) {
                    cleanProxy
                } else {
                    val path = if (cleanProxy.startsWith("/")) cleanProxy else "/$cleanProxy"
                    "$cleanBase$path"
                }
                targets.add(UpdateTarget(url = resolved, sendAuthHeader = true))
            }
            val cleanDirect = directUrl?.trim()?.ifBlank { null }
            if (cleanDirect != null && targets.none { it.url == cleanDirect }) {
                targets.add(UpdateTarget(url = cleanDirect, sendAuthHeader = false))
            }
            return targets
        }
    }
}
