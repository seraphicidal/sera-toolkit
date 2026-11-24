package dev.sera.node.extractor

import android.content.Context
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.ToolsVersionInfo
import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val VERSION_CACHE_TTL_MS = 10 * 60_000L
private const val NEGATIVE_VERSION_CACHE_TTL_MS = 60_000L

private data class CachedToolVersion(
    val version: String?,
    val expiresAtMs: Long,
)

class SeraToolsManager(
    context: Context,
    httpClient: OkHttpClient = OkHttpClient(),
) : ExtractionToolsManager {

    private val appContext = context.applicationContext
    private val initMutex = Mutex()
    private val updateMutex = Mutex()
    private val ytdlpVersionMutex = Mutex()
    private val ffmpegVersionMutex = Mutex()
    private val ffprobeVersionMutex = Mutex()
    private val archiveUpdater = YtdlpArchiveUpdater(httpClient)

    @Volatile
    private var ready = false

    @Volatile
    private var initError: String? = null

    @Volatile
    private var cachedYtdlpVersion: CachedToolVersion? = null

    @Volatile
    private var cachedFfmpegVersion: CachedToolVersion? = null

    @Volatile
    private var cachedFfprobeVersion: CachedToolVersion? = null

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
                    repairCorruptedRuntimeDirectories()
                    YoutubeDL.getInstance().init(appContext)
                    FFmpeg.getInstance().init(appContext)
                    if (ytdlpBinaryFile.isFile) {
                        ytdlpBinaryFile.setExecutable(true, true)
                    }
                    ejsCacheDir.mkdirs()
                    initError = null
                    ready = true
                } catch (error: Throwable) {
                    val causeDetail = formatInitFailure(error)
                    initError = causeDetail
                    throw seraError(
                        SeraErrorCode.INTERNAL,
                        message = "Failed to initialize embedded extraction runtime: $causeDetail",
                        detail = causeDetail,
                        cause = error,
                    )
                }
            }
        }
    }

    private fun repairCorruptedRuntimeDirectories() {
        val pythonPkgDir = File(youtubedlBaseDir, "packages/python")
        if (pythonPkgDir.exists()) {
            val hasPythonLib = hasBundledPythonLibrary(pythonLibDir)
            if (!hasPythonLib || !sslCertFile.isFile) {
                runCatching { pythonPkgDir.deleteRecursively() }
            }
        }
        val ffmpegPkgDir = File(youtubedlBaseDir, "packages/ffmpeg")
        if (ffmpegPkgDir.exists()) {
            val hasFfmpegLibs = ffmpegLibDir.isDirectory && !(ffmpegLibDir.list().isNullOrEmpty())
            if (!hasFfmpegLibs) {
                runCatching { ffmpegPkgDir.deleteRecursively() }
            }
        }
        if (ytdlpBinaryFile.exists() && (!ytdlpBinaryFile.isFile || ytdlpBinaryFile.length() < 100_000L)) {
            runCatching { ytdlpBinaryFile.delete() }
        }
    }

    private fun formatInitFailure(error: Throwable): String {
        val parts = ArrayList<String>()
        var current: Throwable? = error
        var depth = 0
        while (current != null && depth < 6) {
            val msg = current.message?.trim()?.takeIf {
                it.isNotEmpty() && !it.equals("failed to initialize", ignoreCase = true)
            }
            val label = if (msg != null) {
                "${current.javaClass.simpleName}: $msg"
            } else {
                current.javaClass.simpleName
            }
            if (parts.lastOrNull() != label) {
                parts.add(label)
            }
            current = current.cause
            depth += 1
        }
        return parts.joinToString(" <- ").ifEmpty { error.javaClass.simpleName }
    }

    override suspend fun getToolsVersions(): ToolsVersionInfo {
        if (!ready) {
            runCatching { ensureReady() }
        }
        return coroutineScope {
            val ytdlpDeferred = async { readYtdlpVersion() }
            val ffmpegDeferred = async { readFfmpegVersion() }
            val ffprobeDeferred = async { readFfprobeVersion() }
            val ytdlpVer = ytdlpDeferred.await()
            val ffmpegVer = ffmpegDeferred.await()
            val ffprobeVer = ffprobeDeferred.await()
            val qjsPath = libQjsFile.takeIf { it.isFile }?.absolutePath
            val ejsReady = (ejsCacheDir.isDirectory && !(ejsCacheDir.list().isNullOrEmpty())) ||
                ytdlpBinaryFile.isFile

            ToolsVersionInfo(
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
    }

    override suspend fun updateYtdlpFromManifest(
        manifest: YtdlpUpdateInfo,
        authToken: String?,
        apiBaseUrl: String?,
    ): ToolUpdateResult = updateMutex.withLock {
        ensureReady()
        val currentVersion = readYtdlpVersion()
        val result = archiveUpdater.updateFromManifest(
            manifest = manifest,
            targetBinaryFile = ytdlpBinaryFile,
            versionMarkerFile = ytdlpVersionMarkerFile,
            currentInstalledVersion = currentVersion,
            authToken = authToken,
            apiBaseUrl = apiBaseUrl,
            force = false,
        )
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
            archiveUpdater.updateFromManifest(
                manifest = manifest,
                targetBinaryFile = ytdlpBinaryFile,
                versionMarkerFile = ytdlpVersionMarkerFile,
                currentInstalledVersion = currentVersion,
                authToken = authToken,
                apiBaseUrl = apiBaseUrl,
                force = true,
            )
        } else {
            ToolUpdateResult(
                updated = false,
                previousVersion = currentVersion,
                currentVersion = currentVersion,
                sha256Verified = false,
                message = "Refused unverified yt-dlp refresh: no signed manifest available",
            )
        }
        resetEjsCache()
        invalidateYtdlpCache()
        val refreshed = readYtdlpVersion()
        result.copy(currentVersion = refreshed ?: result.currentVersion)
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
        cachedYtdlpVersion?.let { cached ->
            if (now < cached.expiresAtMs) return cached.version
        }
        if (!ready) return null
        return ytdlpVersionMutex.withLock {
            val checkNow = System.currentTimeMillis()
            cachedYtdlpVersion?.let { cached ->
                if (checkNow < cached.expiresAtMs) return@withLock cached.version
            }
            val resolved = withContext(Dispatchers.IO) {
                val processId = "ver-${UUID.randomUUID()}"
                val ytdlp = YoutubeDL.getInstance()
                val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
                    if (cause != null) {
                        runCatching { ytdlp.destroyProcessById(processId) }
                    }
                }
                val probed = try {
                    withTimeoutOrNull(15_000L) {
                        runCatching {
                            val req = YoutubeDLRequest(emptyList()).addOption("--version")
                            val res = ytdlp.execute(req, processId, false, null)
                            res.out.trim().lineSequence().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                        }.getOrNull()
                    }
                } finally {
                    cancelHandle?.dispose()
                    runCatching { ytdlp.destroyProcessById(processId) }
                }
                (
                    probed
                        ?: ytdlpVersionMarkerFile.takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
                        ?: runCatching { ytdlp.version(appContext) }.getOrNull()?.trim()?.ifEmpty { null }
                    )?.take(64)
            }
            val ttl = if (resolved != null) VERSION_CACHE_TTL_MS else NEGATIVE_VERSION_CACHE_TTL_MS
            cachedYtdlpVersion = CachedToolVersion(resolved, System.currentTimeMillis() + ttl)
            resolved
        }
    }

    private suspend fun readFfmpegVersion(): String? {
        val now = System.currentTimeMillis()
        cachedFfmpegVersion?.let { cached ->
            if (now < cached.expiresAtMs) return cached.version
        }
        val bin = libFfmpegFile.takeIf { it.isFile } ?: return null
        return ffmpegVersionMutex.withLock {
            val checkNow = System.currentTimeMillis()
            cachedFfmpegVersion?.let { cached ->
                if (checkNow < cached.expiresAtMs) return@withLock cached.version
            }
            val output = runQuickVersionCommand(bin, listOf("-hide_banner", "-version"))
            val firstLine = output?.lineSequence()?.firstOrNull().orEmpty()
            val match = Regex("""ffmpeg version (\S+)""").find(firstLine)?.groupValues?.get(1)
            val resolved = (match ?: firstLine.trim().takeIf { it.isNotEmpty() })?.take(64)
            val ttl = if (resolved != null) VERSION_CACHE_TTL_MS else NEGATIVE_VERSION_CACHE_TTL_MS
            cachedFfmpegVersion = CachedToolVersion(resolved, System.currentTimeMillis() + ttl)
            resolved
        }
    }

    private suspend fun readFfprobeVersion(): String? {
        val now = System.currentTimeMillis()
        cachedFfprobeVersion?.let { cached ->
            if (now < cached.expiresAtMs) return cached.version
        }
        val bin = libFfprobeFile.takeIf { it.isFile } ?: return null
        return ffprobeVersionMutex.withLock {
            val checkNow = System.currentTimeMillis()
            cachedFfprobeVersion?.let { cached ->
                if (checkNow < cached.expiresAtMs) return@withLock cached.version
            }
            val output = runQuickVersionCommand(bin, listOf("-hide_banner", "-version"))
            val firstLine = output?.lineSequence()?.firstOrNull().orEmpty()
            val match = Regex("""ffprobe version (\S+)""").find(firstLine)?.groupValues?.get(1)
            val resolved = (match ?: firstLine.trim().takeIf { it.isNotEmpty() })?.take(64)
            val ttl = if (resolved != null) VERSION_CACHE_TTL_MS else NEGATIVE_VERSION_CACHE_TTL_MS
            cachedFfprobeVersion = CachedToolVersion(resolved, System.currentTimeMillis() + ttl)
            resolved
        }
    }

    private suspend fun runQuickVersionCommand(binary: File, args: List<String>): String? {
        return withContext(Dispatchers.IO) {
            var proc: Process? = null
            val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
                if (cause != null) {
                    runCatching { proc?.destroyForcibly() }
                }
            }
            try {
                val pb = ProcessBuilder(listOf(binary.absolutePath) + args)
                pb.environment().putAll(buildNativeProcessEnv())
                pb.redirectErrorStream(true)
                val started = pb.start()
                proc = started
                coroutineScope {
                    val readerDeferred = async(Dispatchers.IO) {
                        runCatching {
                            BufferedReader(InputStreamReader(started.inputStream, Charsets.UTF_8)).use { it.readText() }
                        }.getOrNull()
                    }
                    val finished = withTimeoutOrNull(10_000L) {
                        while (!started.waitFor(100, TimeUnit.MILLISECONDS)) {
                            if (!isActive) {
                                started.destroyForcibly()
                                throw CancellationException("Version command cancelled")
                            }
                        }
                        true
                    } ?: false
                    if (!finished) {
                        started.destroyForcibly()
                        readerDeferred.cancel()
                        return@coroutineScope null
                    }
                    val text = withTimeoutOrNull(2_000L) { readerDeferred.await() }
                    if (started.exitValue() == 0) text else null
                }
            } catch (cancelled: CancellationException) {
                runCatching { proc?.destroyForcibly() }
                throw cancelled
            } catch (_: Throwable) {
                runCatching { proc?.destroyForcibly() }
                null
            } finally {
                cancelHandle?.dispose()
                if (proc?.isAlive == true) {
                    runCatching { proc?.destroyForcibly() }
                }
            }
        }
    }

    companion object {
        fun hasBundledPythonLibrary(libDir: File): Boolean {
            if (!libDir.isDirectory) return false
            return libDir.listFiles()?.any { file ->
                file.isFile &&
                    file.name.startsWith("libpython3.") &&
                    file.name.contains(".so")
            } == true
        }
    }
}
