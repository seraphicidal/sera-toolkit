package dev.sera.node.extractor

import android.content.Context
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.ToolsVersionInfo
import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val VERSION_CACHE_TTL_MS = 10 * 60_000L

class SeraToolsManager(
    context: Context,
    httpClient: OkHttpClient = OkHttpClient(),
) : ExtractionToolsManager {

    private val appContext = context.applicationContext
    private val initMutex = Mutex()
    private val updateMutex = Mutex()
    private val archiveUpdater = YtdlpArchiveUpdater(httpClient)

    @Volatile
    private var ready = false

    @Volatile
    private var initError: String? = null

    @Volatile
    private var cachedYtdlpVersion: Pair<String, Long>? = null

    @Volatile
    private var cachedFfmpegVersion: Pair<String, Long>? = null

    @Volatile
    private var cachedFfprobeVersion: Pair<String, Long>? = null

    val nativeLibDir: File
        get() = File(appContext.applicationInfo.nativeLibraryDir)

    val libPythonFile: File
        get() = File(nativeLibDir, "libpython.so")

    val libFfmpegFile: File
        get() = File(nativeLibDir, "libffmpeg.so")

    val libFfprobeFile: File
        get() = File(nativeLibDir, "libffprobe.so")

    val libQjsFile: File
        get() = File(nativeLibDir, "libqjs.so")

    val youtubedlBaseDir: File
        get() = File(appContext.noBackupFilesDir, "youtubedl-android")

    val ytdlpBinaryFile: File
        get() = File(File(youtubedlBaseDir, "yt-dlp"), "yt-dlp")

    val ytdlpVersionMarkerFile: File
        get() = File(File(youtubedlBaseDir, "yt-dlp"), "yt-dlp.sera-version")

    val ejsCacheDir: File
        get() = File(appContext.noBackupFilesDir, "sera-ejs-cache")

    val ffmpegLibDir: File
        get() = File(youtubedlBaseDir, "packages/ffmpeg/usr/lib")

    val pythonLibDir: File
        get() = File(youtubedlBaseDir, "packages/python/usr/lib")

    val sslCertFile: File
        get() = File(youtubedlBaseDir, "packages/python/usr/etc/tls/cert.pem")

    fun buildNativeProcessEnv(): Map<String, String> {
        val ldParts = listOf(ffmpegLibDir, pythonLibDir, nativeLibDir)
            .filter { it.exists() }
            .map { it.absolutePath }
        val env = LinkedHashMap<String, String>()
        if (ldParts.isNotEmpty()) {
            env["LD_LIBRARY_PATH"] = ldParts.joinToString(":")
        }
        env["TMPDIR"] = appContext.cacheDir.apply { mkdirs() }.absolutePath
        if (sslCertFile.isFile) {
            env["SSL_CERT_FILE"] = sslCertFile.absolutePath
        }
        return env
    }

    override suspend fun ensureReady() {
        if (ready) return
        initMutex.withLock {
            if (ready) return
            withContext(Dispatchers.IO) {
                try {
                    YoutubeDL.getInstance().init(appContext)
                    FFmpeg.getInstance().init(appContext)
                    ejsCacheDir.mkdirs()
                    initError = null
                    ready = true
                } catch (error: Throwable) {
                    initError = error.message ?: error.javaClass.simpleName
                    throw seraError(
                        SeraErrorCode.INTERNAL,
                        message = "Failed to initialize embedded extraction runtime.",
                        detail = initError,
                        cause = error,
                    )
                }
            }
        }
    }

    override suspend fun getToolsVersions(): ToolsVersionInfo {
        if (!ready) {
            runCatching { ensureReady() }
        }
        val ytdlpVer = readYtdlpVersion()
        val ffmpegVer = readFfmpegVersion()
        val ffprobeVer = readFfprobeVersion()
        val qjsPath = libQjsFile.takeIf { it.isFile }?.absolutePath
        val ejsReady = (ejsCacheDir.isDirectory && !(ejsCacheDir.list().isNullOrEmpty())) ||
            ytdlpBinaryFile.isFile

        return ToolsVersionInfo(
            ready = ready,
            ytdlpVersion = ytdlpVer,
            ffmpegVersion = ffmpegVer,
            ffprobeVersion = ffprobeVer,
            jsRuntimeName = if (qjsPath != null) "quickjs" else null,
            jsRuntimePath = qjsPath,
            ejsScriptsReady = ejsReady,
            error = initError,
        )
    }

    override suspend fun updateYtdlpFromManifest(
        manifest: YtdlpUpdateInfo,
        authToken: String?,
        apiBaseUrl: String?,
    ): ToolUpdateResult = updateMutex.withLock {
        ensureReady()
        val currentVersion = readYtdlpVersion()
        val rawSha = manifest.sha256?.trim()?.ifEmpty { null }
        val result = if (rawSha != null) {
            archiveUpdater.updateFromManifest(
                manifest = manifest,
                targetBinaryFile = ytdlpBinaryFile,
                versionMarkerFile = ytdlpVersionMarkerFile,
                currentInstalledVersion = currentVersion,
                authToken = authToken,
                apiBaseUrl = apiBaseUrl,
                force = false,
            )
        } else {
            val proxyResult = archiveUpdater.updateFromManifest(
                manifest = manifest,
                targetBinaryFile = ytdlpBinaryFile,
                versionMarkerFile = ytdlpVersionMarkerFile,
                currentInstalledVersion = currentVersion,
                authToken = authToken,
                apiBaseUrl = apiBaseUrl,
                force = false,
            )
            if (proxyResult.updated || proxyResult.sha256Verified) {
                proxyResult
            } else {
                updateViaBuiltinUpdater(currentVersion)
            }
        }
        if (result.updated) {
            invalidateYtdlpCache()
            resetEjsCache()
            readYtdlpVersion()
        }
        result
    }

    override suspend fun forceRefreshTools(
        manifest: YtdlpUpdateInfo?,
        authToken: String?,
        apiBaseUrl: String?,
    ): ToolUpdateResult = updateMutex.withLock {
        ensureReady()
        val currentVersion = readYtdlpVersion()
        val result = if (manifest != null) {
            val rawSha = manifest.sha256?.trim()?.ifEmpty { null }
            val manifestResult = archiveUpdater.updateFromManifest(
                manifest = manifest,
                targetBinaryFile = ytdlpBinaryFile,
                versionMarkerFile = ytdlpVersionMarkerFile,
                currentInstalledVersion = currentVersion,
                authToken = authToken,
                apiBaseUrl = apiBaseUrl,
                force = true,
            )
            if (rawSha == null && !manifestResult.updated && !manifestResult.sha256Verified) {
                updateViaBuiltinUpdater(currentVersion)
            } else {
                manifestResult
            }
        } else {
            updateViaBuiltinUpdater(currentVersion)
        }
        resetEjsCache()
        invalidateYtdlpCache()
        val refreshed = readYtdlpVersion()
        result.copy(currentVersion = refreshed ?: result.currentVersion)
    }

    private suspend fun updateViaBuiltinUpdater(previousVersion: String?): ToolUpdateResult =
        withContext(Dispatchers.IO) {
            try {
                val status = YoutubeDL.getInstance().updateYoutubeDL(
                    appContext,
                    YoutubeDL.UpdateChannel._STABLE,
                )
                ytdlpVersionMarkerFile.delete()
                invalidateYtdlpCache()
                val latest = readYtdlpVersion()
                val updated = status == YoutubeDL.UpdateStatus.DONE
                ToolUpdateResult(
                    updated = updated,
                    previousVersion = previousVersion,
                    currentVersion = latest,
                    sha256Verified = false,
                    message = if (updated) {
                        "Updated yt-dlp to ${latest ?: "latest"} via built-in updater"
                    } else {
                        "yt-dlp ${latest ?: previousVersion ?: "unknown"} already up to date"
                    },
                )
            } catch (error: Throwable) {
                ToolUpdateResult(
                    updated = false,
                    previousVersion = previousVersion,
                    currentVersion = previousVersion,
                    sha256Verified = false,
                    message = error.message ?: "Built-in yt-dlp update failed",
                )
            }
        }

    private fun resetEjsCache() {
        runCatching {
            if (ejsCacheDir.exists()) ejsCacheDir.deleteRecursively()
            ejsCacheDir.mkdirs()
        }
    }

    private fun invalidateYtdlpCache() {
        cachedYtdlpVersion = null
    }

    private suspend fun readYtdlpVersion(): String? {
        val now = System.currentTimeMillis()
        cachedYtdlpVersion?.let { (ver, expiresAt) ->
            if (now < expiresAt) return ver
        }
        if (!ready) return null
        return withContext(Dispatchers.IO) {
            val probed = runCatching {
                val req = YoutubeDLRequest(emptyList()).addOption("--version")
                val res = YoutubeDL.getInstance().execute(req, "ver-${UUID.randomUUID()}", false, null)
                res.out.trim().lineSequence().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
            }.getOrNull()
            val resolved = probed
                ?: ytdlpVersionMarkerFile.takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
                ?: runCatching { YoutubeDL.getInstance().version(appContext) }.getOrNull()?.trim()?.ifEmpty { null }
            if (resolved != null) {
                cachedYtdlpVersion = resolved to (System.currentTimeMillis() + VERSION_CACHE_TTL_MS)
            }
            resolved
        }
    }

    private suspend fun readFfmpegVersion(): String? {
        val now = System.currentTimeMillis()
        cachedFfmpegVersion?.let { (ver, expiresAt) ->
            if (now < expiresAt) return ver
        }
        val bin = libFfmpegFile.takeIf { it.isFile } ?: return null
        return withContext(Dispatchers.IO) {
            val output = runQuickVersionCommand(bin, listOf("-hide_banner", "-version"))
            val firstLine = output?.lineSequence()?.firstOrNull().orEmpty()
            val match = Regex("""ffmpeg version (\S+)""").find(firstLine)?.groupValues?.get(1)
            val resolved = match ?: firstLine.trim().takeIf { it.isNotEmpty() }
            if (resolved != null) {
                cachedFfmpegVersion = resolved to (System.currentTimeMillis() + VERSION_CACHE_TTL_MS)
            }
            resolved
        }
    }

    private suspend fun readFfprobeVersion(): String? {
        val now = System.currentTimeMillis()
        cachedFfprobeVersion?.let { (ver, expiresAt) ->
            if (now < expiresAt) return ver
        }
        val bin = libFfprobeFile.takeIf { it.isFile } ?: return null
        return withContext(Dispatchers.IO) {
            val output = runQuickVersionCommand(bin, listOf("-hide_banner", "-version"))
            val firstLine = output?.lineSequence()?.firstOrNull().orEmpty()
            val match = Regex("""ffprobe version (\S+)""").find(firstLine)?.groupValues?.get(1)
            val resolved = match ?: firstLine.trim().takeIf { it.isNotEmpty() }
            if (resolved != null) {
                cachedFfprobeVersion = resolved to (System.currentTimeMillis() + VERSION_CACHE_TTL_MS)
            }
            resolved
        }
    }

    private fun runQuickVersionCommand(binary: File, args: List<String>): String? {
        return runCatching {
            val pb = ProcessBuilder(listOf(binary.absolutePath) + args)
            pb.environment().putAll(buildNativeProcessEnv())
            pb.redirectErrorStream(true)
            val proc = pb.start()
            val text = BufferedReader(InputStreamReader(proc.inputStream)).use { it.readText() }
            val finished = proc.waitFor(10, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return null
            }
            if (proc.exitValue() == 0) text else null
        }.getOrNull()
    }
}
