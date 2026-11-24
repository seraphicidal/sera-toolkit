package dev.sera.node.extractor

import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import dev.sera.node.model.SeraJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.math.roundToLong

@Serializable
private data class RawFfprobeDisposition(
    val attached_pic: Int? = null,
)

@Serializable
private data class RawFfprobeStream(
    val codec_type: String? = null,
    val codec_name: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val channels: Int? = null,
    val sample_rate: String? = null,
    val bit_rate: String? = null,
    val avg_frame_rate: String? = null,
    val disposition: RawFfprobeDisposition? = null,
)

@Serializable
private data class RawFfprobeFormat(
    val duration: String? = null,
    val format_name: String? = null,
    val size: String? = null,
    val bit_rate: String? = null,
)

@Serializable
private data class RawFfprobeOutput(
    val format: RawFfprobeFormat? = null,
    val streams: List<RawFfprobeStream>? = null,
)

class AndroidMediaExecutor(
    private val toolsManager: SeraToolsManager,
) : MediaCommandExecutor {

    override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
        withContext(Dispatchers.IO) {
            assertPublicUrlForExternalTool(url, allowPrivateAddresses = options.allowPrivateAddresses)
        }
        toolsManager.ensureReady()
        val runtimePaths = YtdlpRuntimePaths(
            ffmpegLocation = null,
            quickjsPath = null,
            ejsCacheDir = toolsManager.ejsCacheDir,
        )
        val args = YtdlpCommandBuilder.buildDumpInfoArgs(url, options, runtimePaths)
        val request = buildRequestFromArgs(args)
        val response = executeYtdlp(
            request = request,
            timeoutMs = options.timeoutMs,
            isCancelled = options.isCancelled,
            callback = null,
        )
        return parseYtdlpInfo(response.stdout)
    }

    override suspend fun download(options: YtdlpDownloadOptions) {
        withContext(Dispatchers.IO) {
            assertPublicUrlForExternalTool(options.url, allowPrivateAddresses = options.allowPrivateAddresses)
        }
        toolsManager.ensureReady()
        val runtimePaths = YtdlpRuntimePaths(
            ffmpegLocation = null,
            quickjsPath = null,
            ejsCacheDir = toolsManager.ejsCacheDir,
        )
        val args = YtdlpCommandBuilder.buildDownloadArgs(options, runtimePaths)
        val request = buildRequestFromArgs(args)
        val parser = YtdlpProgressParser(
            expectedTotalBytes = options.expectedTotalBytes,
            hasMergeContainer = !options.mergeContainer.isNullOrBlank(),
            onProgress = options.onProgress,
        )
        val sawStructuredProgress = AtomicBoolean(false)
        executeYtdlp(
            request = request,
            timeoutMs = options.timeoutMs,
            isCancelled = options.isCancelled,
            callback = { pct, eta, line ->
                if (line.startsWith("SERA-PROGRESS") || line.startsWith("SERA-POSTPROCESS")) {
                    sawStructuredProgress.set(true)
                    parser.feedLine(line)
                } else if (!sawStructuredProgress.get() && pct in 0.0f..100.0f) {
                    options.onProgress(
                        YtdlpProgress(
                            percent = pct.toDouble(),
                            bytesDownloaded = 0L,
                            bytesTotal = options.expectedTotalBytes,
                            etaSeconds = eta.takeIf { it >= 0L }?.toDouble(),
                        ),
                    )
                }
            },
        )
    }

    override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions): File {
        withContext(Dispatchers.IO) {
            assertPublicUrlForExternalTool(options.url, allowPrivateAddresses = options.allowPrivateAddresses)
        }
        toolsManager.ensureReady()
        val runtimePaths = YtdlpRuntimePaths(
            ffmpegLocation = null,
            quickjsPath = null,
            ejsCacheDir = toolsManager.ejsCacheDir,
        )
        val args = YtdlpCommandBuilder.buildSubtitleArgs(options, runtimePaths)
        val request = buildRequestFromArgs(args)
        executeYtdlp(
            request = request,
            timeoutMs = options.timeoutMs,
            isCancelled = options.isCancelled,
            callback = null,
        )
        val written = withContext(Dispatchers.IO) {
            options.workdir.listFiles()
                ?.firstOrNull { it.isFile && it.name.endsWith(".${options.format}") }
        } ?: throw seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "Those subtitles are not available any more.",
            detail = "no .${options.format} written for ${options.lang}",
        )
        return written
    }

    override suspend fun probeMedia(
        path: File,
        timeoutMs: Long,
        isCancelled: () -> Boolean,
    ): FfprobeResult {
        toolsManager.ensureReady()
        val ffprobe = toolsManager.libFfprobeFile
        val result = runProcess(
            binary = ffprobe,
            args = listOf(
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,data",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-i",
                path.absolutePath,
            ),
            workDir = path.parentFile ?: File("."),
            timeoutMs = min(timeoutMs, 30_000L),
            captureStdout = true,
            maxStdoutBytes = 4 * 1024 * 1024,
            onStdoutLine = null,
            isCancelled = isCancelled,
        )
        if (result.exitCode != 0) {
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                message = "The downloaded file could not be read.",
                detail = "ffprobe exit ${result.exitCode}: ${result.stderrTail.takeLast(400)}",
            )
        }
        val parsed = try {
            SeraJson.decodeFromString(RawFfprobeOutput.serializer(), result.stdout)
        } catch (cause: Exception) {
            throw seraError(SeraErrorCode.CONVERSION_FAILED, detail = "unparseable ffprobe output", cause = cause)
        }
        val videoStream = parsed.streams?.firstOrNull {
            it.codec_type == "video" && it.disposition?.attached_pic != 1
        }
        val audioStream = parsed.streams?.firstOrNull { it.codec_type == "audio" }
        val duration = parsed.format?.duration?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0.0 }
        val sizeBytes = parsed.format?.size?.toLongOrNull()?.takeIf { it >= 0L }
        val bitrate = parsed.format?.bit_rate?.toLongOrNull()?.takeIf { it >= 0L }

        return FfprobeResult(
            durationSeconds = duration,
            formatName = parsed.format?.format_name,
            sizeBytes = sizeBytes,
            bitrate = bitrate,
            video = videoStream?.codec_name?.let { codec ->
                FfprobeVideoStream(
                    codec = codec,
                    width = videoStream.width?.takeIf { it > 0 },
                    height = videoStream.height?.takeIf { it > 0 },
                    fps = parseFrameRate(videoStream.avg_frame_rate),
                )
            },
            audio = audioStream?.codec_name?.let { codec ->
                FfprobeAudioStream(
                    codec = codec,
                    channels = audioStream.channels?.takeIf { it > 0 },
                    sampleRate = audioStream.sample_rate?.toIntOrNull()?.takeIf { it > 0 },
                    bitrate = audioStream.bit_rate?.toLongOrNull()?.takeIf { it > 0L },
                )
            },
        )
    }

    override suspend fun keyframeAtOrBefore(
        path: File,
        seconds: Double,
        timeoutMs: Long,
        isCancelled: () -> Boolean,
    ): Double? {
        toolsManager.ensureReady()
        val from = kotlin.math.max(0.0, seconds - 30.0)
        val result = runProcess(
            binary = toolsManager.libFfprobeFile,
            args = listOf(
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,data",
                "-select_streams",
                "v:0",
                "-skip_frame",
                "nokey",
                "-show_entries",
                "frame=pts_time",
                "-of",
                "csv=p=0",
                "-read_intervals",
                "$from%${seconds + 1.0}",
                "-i",
                path.absolutePath,
            ),
            workDir = path.parentFile ?: File("."),
            timeoutMs = min(timeoutMs, 30_000L),
            captureStdout = true,
            maxStdoutBytes = 1024 * 1024,
            onStdoutLine = null,
            isCancelled = isCancelled,
        )
        if (result.exitCode != 0) return null
        return result.stdout.lineSequence()
            .mapNotNull { it.trim().toDoubleOrNull() }
            .filter { it.isFinite() && it <= seconds + 0.01 }
            .maxOrNull()
    }

    override suspend fun runFfmpeg(
        args: List<String>,
        workDir: File,
        timeoutMs: Long,
        onStdoutLine: ((String) -> Unit)?,
        isCancelled: () -> Boolean,
    ): CommandOutput {
        toolsManager.ensureReady()
        return runProcess(
            binary = toolsManager.libFfmpegFile,
            args = args,
            workDir = workDir,
            timeoutMs = timeoutMs,
            captureStdout = false,
            maxStdoutBytes = 256 * 1024,
            onStdoutLine = onStdoutLine,
            isCancelled = isCancelled,
        )
    }

    private fun buildRequestFromArgs(args: List<String>): YoutubeDLRequest {
        val request = YoutubeDLRequest(emptyList())
        val extraCommands = ArrayList<String>()
        var i = 0
        while (i < args.size) {
            val token = args[i]
            if (token == "--") {
                for (j in i until args.size) {
                    extraCommands.add(args[j])
                }
                break
            }
            if (token == "--cache-dir" && i + 1 < args.size) {
                request.addOption("--cache-dir", args[i + 1])
                i += 2
                continue
            }
            extraCommands.add(token)
            i += 1
        }
        if (extraCommands.isNotEmpty()) {
            request.addCommands(extraCommands)
        }
        return request
    }

    private suspend fun executeYtdlp(
        request: YoutubeDLRequest,
        timeoutMs: Long,
        isCancelled: () -> Boolean,
        callback: ((Float, Long, String) -> Unit)?,
    ): CommandOutput {
        val processId = "sera-${UUID.randomUUID()}"
        val ytdlp = YoutubeDL.getInstance()

        return try {
            withTimeout(timeoutMs.coerceAtLeast(5_000L)) {
                coroutineScope {
                    val destroyHandle = coroutineContext[Job]?.invokeOnCompletion { cause ->
                        if (cause != null) {
                            runCatching { ytdlp.destroyProcessById(processId) }
                        }
                    }
                    val cancelMonitor = launch {
                        while (isActive) {
                            if (isCancelled()) {
                                runCatching { ytdlp.destroyProcessById(processId) }
                                break
                            }
                            delay(100L)
                        }
                    }
                    try {
                        withContext(Dispatchers.IO) {
                            val response = ytdlp.execute(request, processId, false, callback)
                            if (isCancelled()) {
                                throw seraError(SeraErrorCode.CANCELLED)
                            }
                            if (response.exitCode != 0) {
                                throw classifyYtdlpFailure(response.err, response.exitCode)
                            }
                            CommandOutput(
                                exitCode = response.exitCode,
                                stdout = response.out,
                                stderrTail = response.err.takeLast(4096),
                            )
                        }
                    } finally {
                        cancelMonitor.cancel()
                        destroyHandle?.dispose()
                        runCatching { ytdlp.destroyProcessById(processId) }
                    }
                }
            }
        } catch (error: TimeoutCancellationException) {
            runCatching { ytdlp.destroyProcessById(processId) }
            throw seraError(SeraErrorCode.TIMEOUT, detail = "yt-dlp timed out after ${timeoutMs}ms", cause = error)
        } catch (error: YoutubeDL.CanceledException) {
            if (!currentCoroutineContext().isActive) {
                throw CancellationException("yt-dlp process cancelled", error)
            }
            throw seraError(SeraErrorCode.CANCELLED, cause = error)
        } catch (error: CancellationException) {
            runCatching { ytdlp.destroyProcessById(processId) }
            throw error
        } catch (error: YoutubeDLException) {
            if (!currentCoroutineContext().isActive) {
                throw CancellationException("yt-dlp process cancelled", error)
            }
            if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED, cause = error)
            throw classifyYtdlpFailure(error.message.orEmpty(), 1)
        } catch (error: InterruptedException) {
            runCatching { ytdlp.destroyProcessById(processId) }
            throw seraError(SeraErrorCode.CANCELLED, cause = error)
        }
    }

    private suspend fun runProcess(
        binary: File,
        args: List<String>,
        workDir: File,
        timeoutMs: Long,
        captureStdout: Boolean,
        maxStdoutBytes: Int,
        onStdoutLine: ((String) -> Unit)?,
        isCancelled: () -> Boolean,
    ): CommandOutput {
        if (!binary.isFile) {
            throw seraError(SeraErrorCode.INTERNAL, detail = "missing native binary ${binary.name}")
        }
        return runNativeProcess(
            binary = binary,
            args = args,
            workDir = workDir,
            env = toolsManager.buildNativeProcessEnv(),
            timeoutMs = timeoutMs,
            captureStdout = captureStdout,
            maxStdoutBytes = maxStdoutBytes,
            onStdoutLine = onStdoutLine,
            isCancelled = isCancelled,
        )
    }

    private fun parseFrameRate(raw: String?): Double? {
        if (raw.isNullOrBlank()) return null
        val parts = raw.split('/')
        if (parts.size != 2) return null
        val num = parts[0].toDoubleOrNull() ?: return null
        val den = parts[1].toDoubleOrNull() ?: return null
        if (!num.isFinite() || !den.isFinite() || num == 0.0 || den <= 0.0) return null
        val fps = ((num / den) * 100.0).roundToLong() / 100.0
        return if (fps.isFinite() && fps > 0.0) fps else null
    }

    companion object {
        internal suspend fun runNativeProcess(
            binary: File,
            args: List<String>,
            workDir: File?,
            env: Map<String, String>,
            timeoutMs: Long,
            captureStdout: Boolean,
            maxStdoutBytes: Int,
            onStdoutLine: ((String) -> Unit)?,
            isCancelled: () -> Boolean,
        ): CommandOutput = withContext(Dispatchers.IO) {
            val pb = ProcessBuilder(listOf(binary.absolutePath) + args)
            if (workDir != null && workDir.isDirectory) pb.directory(workDir)
            pb.environment().putAll(env)

            val process = pb.start()
            val destroyHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
                if (cause != null && process.isAlive) {
                    process.destroyForcibly()
                }
            }

            try {
                coroutineScope {
                    val stderrJob = async(Dispatchers.IO) {
                        val stderrTail = StringBuilder()
                        try {
                            BufferedReader(InputStreamReader(process.errorStream, Charsets.UTF_8)).use { reader ->
                                val buf = CharArray(4096)
                                while (true) {
                                    val read = reader.read(buf)
                                    if (read <= 0) break
                                    stderrTail.append(buf, 0, read)
                                    if (stderrTail.length > 8192) {
                                        stderrTail.delete(0, stderrTail.length - 8192)
                                    }
                                }
                            }
                        } catch (_: Exception) {
                        }
                        stderrTail.toString()
                    }

                    val stdoutJob = async(Dispatchers.IO) {
                        val stdoutBuilder = StringBuilder()
                        try {
                            BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8)).use { reader ->
                                while (true) {
                                    val line = reader.readLine() ?: break
                                    onStdoutLine?.invoke(line)
                                    if (captureStdout && stdoutBuilder.length < maxStdoutBytes) {
                                        if (stdoutBuilder.isNotEmpty()) stdoutBuilder.append('\n')
                                        stdoutBuilder.append(line)
                                    }
                                }
                            }
                        } catch (_: Exception) {
                        }
                        stdoutBuilder.toString()
                    }

                    val deadline = System.currentTimeMillis() + timeoutMs.coerceAtLeast(1_000L)
                    while (true) {
                        if (isCancelled()) {
                            process.destroyForcibly()
                            throw seraError(SeraErrorCode.CANCELLED)
                        }
                        if (!isActive) {
                            process.destroyForcibly()
                            throw CancellationException("Process cancelled")
                        }
                        if (process.waitFor(100L, TimeUnit.MILLISECONDS)) {
                            break
                        }
                        if (System.currentTimeMillis() > deadline) {
                            process.destroyForcibly()
                            throw seraError(SeraErrorCode.TIMEOUT, detail = "${binary.name} timed out after ${timeoutMs}ms")
                        }
                    }

                    val stdout = withTimeoutOrNull(2_000L) { stdoutJob.await() }.orEmpty()
                    val stderr = withTimeoutOrNull(2_000L) { stderrJob.await() }.orEmpty()
                    CommandOutput(
                        exitCode = process.exitValue(),
                        stdout = stdout,
                        stderrTail = stderr,
                    )
                }
            } finally {
                destroyHandle?.dispose()
                if (process.isAlive) process.destroyForcibly()
            }
        }
    }
}
