package dev.sera.toolkit.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt

class DownloadExpiredException(message: String) : IOException(message)

class DownloadHttpException(val statusCode: Int, message: String) : IOException(message)

data class TransferProgress(
    val percent: Int,
    val bytesRead: Long,
    val totalBytes: Long,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
)

interface ResumableByteSink : AutoCloseable {
    fun write(buffer: ByteArray, length: Int)
    fun reset()
    fun flush()
}

class FileChannelSink(private val channel: FileChannel) : ResumableByteSink {
    override fun write(buffer: ByteArray, length: Int) {
        val byteBuffer = ByteBuffer.wrap(buffer, 0, length)
        while (byteBuffer.hasRemaining()) {
            channel.write(byteBuffer)
        }
    }

    override fun reset() {
        channel.truncate(0L)
        channel.position(0L)
    }

    override fun flush() {
        channel.force(false)
    }

    override fun close() {
        channel.close()
    }
}

class ResumableDownloader(
    private val httpClient: OkHttpClient,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val maxResumeAttempts: Int = DEFAULT_MAX_RESUME_ATTEMPTS,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) {
    suspend fun downloadToSink(
        url: String,
        sink: ResumableByteSink,
        expectedSizeBytes: Long? = null,
        onProgress: suspend (TransferProgress) -> Unit = {},
    ): Long {
        var bytesWritten = 0L
        var knownTotalBytes = expectedSizeBytes?.takeIf { it > 0L } ?: -1L
        var ifRangeValidator: String? = null
        var resumeAttempts = 0

        while (true) {
            currentCoroutineContext().ensureActive()
            val requestBuilder = Request.Builder().url(url).get()
            if (bytesWritten > 0L) {
                requestBuilder.header("Range", "bytes=$bytesWritten-")
                if (!ifRangeValidator.isNullOrBlank()) {
                    requestBuilder.header("If-Range", ifRangeValidator)
                }
            }
            val request = requestBuilder.build()

            try {
                val response = executeCancellable(httpClient.newCall(request))
                val completed = response.use { res ->
                    when (res.code) {
                        404, 410 -> throw DownloadExpiredException("Download expired on server.")
                        416 -> {
                            val rangeTotal = parseTotalFromUnsatisfiableRange(res.header("Content-Range"))
                            if (rangeTotal != null && bytesWritten >= rangeTotal) {
                                knownTotalBytes = rangeTotal
                                true
                            } else if (knownTotalBytes > 0L && bytesWritten >= knownTotalBytes) {
                                true
                            } else {
                                sink.reset()
                                bytesWritten = 0L
                                ifRangeValidator = null
                                false
                            }
                        }
                        206 -> {
                            val rangeInfo = parseContentRange(res.header("Content-Range"))
                            if (rangeInfo == null || rangeInfo.start != bytesWritten) {
                                sink.reset()
                                bytesWritten = 0L
                                ifRangeValidator = null
                                false
                            } else {
                                if (rangeInfo.total != null && rangeInfo.total > 0L) {
                                    knownTotalBytes = rangeInfo.total
                                }
                                if (ifRangeValidator == null) {
                                    ifRangeValidator = extractValidator(res)
                                }
                                val body = res.body ?: throw IOException("Empty response body.")
                                val contentLength = body.contentLength()
                                val expectedEnd = if (knownTotalBytes > 0L) {
                                    knownTotalBytes
                                } else if (contentLength > 0L) {
                                    bytesWritten + contentLength
                                } else {
                                    -1L
                                }
                                bytesWritten = streamBody(
                                    body = body,
                                    sink = sink,
                                    startOffset = bytesWritten,
                                    totalBytes = expectedEnd,
                                    onProgress = onProgress,
                                )
                                expectedEnd <= 0L || bytesWritten >= expectedEnd
                            }
                        }
                        200 -> {
                            if (bytesWritten > 0L) {
                                sink.reset()
                                bytesWritten = 0L
                            }
                            ifRangeValidator = extractValidator(res)
                            val body = res.body ?: throw IOException("Empty response body.")
                            val contentLength = body.contentLength()
                            if (contentLength > 0L) {
                                knownTotalBytes = contentLength
                            }
                            bytesWritten = streamBody(
                                body = body,
                                sink = sink,
                                startOffset = 0L,
                                totalBytes = knownTotalBytes,
                                onProgress = onProgress,
                            )
                            knownTotalBytes <= 0L || bytesWritten >= knownTotalBytes
                        }
                        else -> throw DownloadHttpException(
                            res.code,
                            "Download failed (HTTP ${res.code}).",
                        )
                    }
                }

                if (completed) {
                    withContext(ioDispatcher) { sink.flush() }
                    val finalTotal = if (knownTotalBytes > 0L) knownTotalBytes else bytesWritten
                    onProgress(
                        TransferProgress(
                            percent = 100,
                            bytesRead = bytesWritten,
                            totalBytes = finalTotal,
                        ),
                    )
                    return bytesWritten
                }

                if (resumeAttempts >= maxResumeAttempts) {
                    throw IOException("Download interrupted before completion.")
                }
                resumeAttempts += 1
                sleeper(backoffMillis(resumeAttempts))
            } catch (e: CancellationException) {
                throw e
            } catch (e: DownloadExpiredException) {
                throw e
            } catch (e: DownloadHttpException) {
                throw e
            } catch (e: IOException) {
                if (!currentCoroutineContext().isActive) {
                    throw CancellationException("Download cancelled", e)
                }
                if (resumeAttempts >= maxResumeAttempts) {
                    throw e
                }
                resumeAttempts += 1
                sleeper(backoffMillis(resumeAttempts))
            }
        }
    }

    private suspend fun executeCancellable(call: Call): Response {
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (cont.isActive) {
                            cont.resumeWithException(e)
                        }
                    }

                    override fun onResponse(call: Call, response: Response) {
                        if (cont.isActive) {
                            cont.resume(response) {
                                response.close()
                            }
                        } else {
                            response.close()
                        }
                    }
                },
            )
        }
    }

    private suspend fun streamBody(
        body: okhttp3.ResponseBody,
        sink: ResumableByteSink,
        startOffset: Long,
        totalBytes: Long,
        onProgress: suspend (TransferProgress) -> Unit,
    ): Long {
        var bytesWritten = startOffset
        var lastNotifyAt = 0L
        val sessionStartAt = nowMillis()
        var sessionBytes = 0L

        val input = body.byteStream()
        try {
            val buffer = ByteArray(BUFFER_SIZE)
            while (true) {
                currentCoroutineContext().ensureActive()
                val read = withContext(ioDispatcher) { input.read(buffer) }
                if (read == -1) break
                withContext(ioDispatcher) { sink.write(buffer, read) }
                bytesWritten += read
                sessionBytes += read

                val now = nowMillis()
                if (now - lastNotifyAt >= PROGRESS_THROTTLE_MS || (totalBytes > 0L && bytesWritten >= totalBytes)) {
                    lastNotifyAt = now
                    val elapsedSec = ((now - sessionStartAt).coerceAtLeast(1L)) / 1000.0
                    val speed = if (elapsedSec >= 0.25 && sessionBytes > 0L) {
                        sessionBytes.toDouble() / elapsedSec
                    } else {
                        null
                    }
                    val eta = if (speed != null && speed > 0.0 && totalBytes > bytesWritten) {
                        (totalBytes - bytesWritten).toDouble() / speed
                    } else {
                        null
                    }
                    val pct = if (totalBytes > 0L) {
                        ((bytesWritten.toDouble() / totalBytes.toDouble()) * 100.0)
                            .roundToInt()
                            .coerceIn(0, 100)
                    } else {
                        0
                    }
                    onProgress(
                        TransferProgress(
                            percent = pct,
                            bytesRead = bytesWritten,
                            totalBytes = totalBytes,
                            speedBytesPerSecond = speed,
                            etaSeconds = eta,
                        ),
                    )
                }
            }
        } finally {
            runCatching { input.close() }
        }
        return bytesWritten
    }

    private data class ContentRangeInfo(
        val start: Long,
        val end: Long,
        val total: Long?,
    )

    private fun extractValidator(response: Response): String? {
        return response.header("ETag")?.trim()?.takeIf { it.isNotEmpty() }
            ?: response.header("Last-Modified")?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun parseContentRange(header: String?): ContentRangeInfo? {
        val raw = header?.trim() ?: return null
        val match = CONTENT_RANGE_PATTERN.matchEntire(raw) ?: return null
        val start = match.groupValues[1].toLongOrNull() ?: return null
        val end = match.groupValues[2].toLongOrNull() ?: return null
        val totalRaw = match.groupValues[3]
        val total = if (totalRaw == "*") null else totalRaw.toLongOrNull()
        return ContentRangeInfo(start, end, total)
    }

    private fun parseTotalFromUnsatisfiableRange(header: String?): Long? {
        val raw = header?.trim() ?: return null
        val match = UNSATISFIABLE_RANGE_PATTERN.matchEntire(raw) ?: return null
        return match.groupValues[1].toLongOrNull()
    }

    private fun backoffMillis(attempt: Int): Long {
        return (attempt * 1_000L).coerceAtMost(5_000L)
    }

    companion object {
        private const val BUFFER_SIZE = 64 * 1024
        private const val PROGRESS_THROTTLE_MS = 200L
        private const val DEFAULT_MAX_RESUME_ATTEMPTS = 5
        private val CONTENT_RANGE_PATTERN = Regex("^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$", RegexOption.IGNORE_CASE)
        private val UNSATISFIABLE_RANGE_PATTERN = Regex("^bytes\\s+\\*/(\\d+)$", RegexOption.IGNORE_CASE)
    }
}
