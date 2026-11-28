package dev.sera.toolkit.data

import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.model.ApiErrorBody
import dev.sera.toolkit.model.CreateJobRequest
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.HealthReport
import dev.sera.toolkit.model.ImportRequest
import dev.sera.toolkit.model.Job
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.JobProgress
import dev.sera.toolkit.model.JobState
import dev.sera.toolkit.model.LegalReportRequest
import dev.sera.toolkit.model.LegalReportResponse
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.ResolveRequest
import dev.sera.toolkit.model.SeraJson
import dev.sera.toolkit.model.ServiceInfo
import dev.sera.toolkit.model.SseJobEvent
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

class SeraApiException(
    val apiError: JobError,
    val httpStatus: Int? = null,
    val retryAfterSeconds: Long? = null,
) : Exception(apiError.message)

class SeraApiClient(
    val httpClient: OkHttpClient = defaultHttpClient(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val streamGraceMs: Long = STREAM_GRACE_MS,
    private val pollIntervalMs: Long = POLL_INTERVAL_MS,
    private val maxRateLimitRetries: Int = DEFAULT_RATE_LIMIT_RETRIES,
) {
    private val sseClient: OkHttpClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val json = SeraJson

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun fetchHealth(baseUrl: String): HealthReport {
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/health")
            .header("Cache-Control", "no-store")
            .get()
            .build()
        return executeJson(request)
    }

    suspend fun fetchServiceInfo(baseUrl: String): ServiceInfo {
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/info")
            .get()
            .build()
        return executeJson(request)
    }

    suspend fun resolveMedia(baseUrl: String, url: String): MediaInfo {
        val body = json.encodeToString(ResolveRequest(url = url)).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/media/info")
            .post(body)
            .build()
        return executeJson(request)
    }

    suspend fun importMedia(baseUrl: String, importRequest: ImportRequest): MediaInfo {
        val body = json.encodeToString(importRequest).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/media/import")
            .post(body)
            .build()
        return executeJson(request)
    }

    suspend fun createJob(baseUrl: String, createRequest: CreateJobRequest): Job {
        val body = json.encodeToString(createRequest).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/jobs")
            .post(body)
            .build()
        return executeJson(request)
    }

    suspend fun getJob(baseUrl: String, jobId: String): Job {
        val safeJobId = requireValidJobId(jobId)
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/jobs/$safeJobId")
            .header("Cache-Control", "no-store")
            .get()
            .build()
        return executeJson(request)
    }

    suspend fun cancelJob(baseUrl: String, jobId: String): Boolean {
        val safeJobId = jobId.takeIf { JOB_ID_PATTERN.matches(it) } ?: return false
        return withContext(ioDispatcher) {
            val request = Request.Builder()
                .url("${normalizeBaseUrl(baseUrl)}/api/jobs/$safeJobId")
                .delete()
                .build()
            try {
                httpClient.newCall(request).execute().use { response ->
                    response.isSuccessful
                }
            } catch (_: Exception) {
                false
            }
        }
    }

    suspend fun submitLegalReport(
        baseUrl: String,
        reportRequest: LegalReportRequest,
    ): LegalReportResponse {
        val body = json.encodeToString(reportRequest).toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/legal/report")
            .post(body)
            .build()
        return executeJson(request)
    }

    fun observeJob(
        baseUrl: String,
        jobId: String,
        initialJob: Job? = null,
    ): Flow<Job> = callbackFlow {
        val safeJobId = requireValidJobId(jobId)
        var latestJob: Job? = initialJob
        if (initialJob != null) {
            trySend(initialJob)
            if (initialJob.state.isTerminal) {
                close()
                awaitClose { }
                return@callbackFlow
            }
        }

        val stopped = AtomicBoolean(false)
        val pollingStarted = AtomicBoolean(false)
        val sawStreamEvent = AtomicBoolean(false)
        var eventSource: EventSource? = null
        var pollJob: kotlinx.coroutines.Job? = null
        var graceJob: kotlinx.coroutines.Job? = null

        fun applyMonotonic(next: Job): Job {
            val prev = latestJob
            val merged =
                if (prev != null && prev.progress.percent > next.progress.percent && !next.state.isTerminal) {
                    next.copy(progress = prev.progress)
                } else {
                    next
                }
            latestJob = merged
            return merged
        }

        fun finishStream() {
            if (stopped.compareAndSet(false, true)) {
                eventSource?.cancel()
                graceJob?.cancel()
                pollJob?.cancel()
                close()
            }
        }

        fun startPolling() {
            if (stopped.get() || !pollingStarted.compareAndSet(false, true)) return
            graceJob?.cancel()
            eventSource?.cancel()
            eventSource = null

            pollJob = launch(ioDispatcher) {
                var currentDelayMs = pollIntervalMs
                while (isActive && !stopped.get()) {
                    try {
                        val next = applyMonotonic(getJob(baseUrl, safeJobId))
                        trySend(next)
                        if (next.state.isTerminal) {
                            finishStream()
                            return@launch
                        }
                        sleeper(currentDelayMs)
                        currentDelayMs = (currentDelayMs * 5L / 4L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                    } catch (e: SeraApiException) {
                        if (!e.apiError.retryable) {
                            val nowIso = Instant.now().toString()
                            val prev = latestJob
                            val syntheticState = when {
                                e.apiError.code == ErrorCodes.EXPIRED -> JobState.EXPIRED
                                e.httpStatus == 404 || e.apiError.code == ErrorCodes.NOT_FOUND -> JobState.EXPIRED
                                else -> JobState.FAILED
                            }
                            val synthetic = Job(
                                id = safeJobId,
                                state = syntheticState,
                                step = if (syntheticState == JobState.EXPIRED) "Expired" else "Failed",
                                progress = prev?.progress ?: JobProgress(percent = 0.0),
                                provider = prev?.provider ?: "generic",
                                createdAt = prev?.createdAt ?: nowIso,
                                updatedAt = nowIso,
                                error = e.apiError,
                            )
                            trySend(synthetic)
                            finishStream()
                            return@launch
                        }
                        val retryMs = e.retryAfterSeconds?.times(1000L)
                        currentDelayMs = if (retryMs != null && retryMs > 0L) {
                            retryMs.coerceAtMost(MAX_RETRY_AFTER_MS)
                        } else {
                            (currentDelayMs * 2L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                        }
                        sleeper(currentDelayMs)
                    } catch (_: Exception) {
                        currentDelayMs = (currentDelayMs * 2L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                        sleeper(currentDelayMs)
                    }
                }
            }
        }

        val request = Request.Builder()
            .url("${normalizeBaseUrl(baseUrl)}/api/jobs/$safeJobId/events")
            .header("Accept", "text/event-stream")
            .build()

        val factory = EventSources.createFactory(sseClient)
        eventSource = factory.newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(
                    eventSource: EventSource,
                    id: String?,
                    type: String?,
                    data: String,
                ) {
                    if (stopped.get()) return
                    sawStreamEvent.set(true)
                    val parsed = try {
                        json.decodeFromString<SseJobEvent>(data)
                    } catch (_: Exception) {
                        return
                    }
                    if (parsed.type == "ping" || type == "ping") return
                    val job = parsed.job
                    if (job == null) {
                        startPolling()
                        return
                    }
                    val merged = applyMonotonic(job)
                    trySend(merged)
                    if (merged.state.isTerminal) {
                        finishStream()
                    }
                }

                override fun onFailure(
                    eventSource: EventSource,
                    t: Throwable?,
                    response: Response?,
                ) {
                    if (!stopped.get()) {
                        startPolling()
                    }
                }

                override fun onClosed(eventSource: EventSource) {
                    if (!stopped.get() && latestJob?.state?.isTerminal != true) {
                        startPolling()
                    }
                }
            },
        )

        graceJob = launch(ioDispatcher) {
            delay(streamGraceMs)
            if (!sawStreamEvent.get() && !stopped.get()) {
                startPolling()
            }
        }

        awaitClose {
            stopped.set(true)
            eventSource?.cancel()
            graceJob?.cancel()
            pollJob?.cancel()
        }
    }

    private suspend inline fun <reified T> executeJson(request: Request): T {
        var attempt = 0
        while (true) {
            val outcome = withContext(ioDispatcher) {
                val response = try {
                    httpClient.newCall(request).execute()
                } catch (_: IOException) {
                    throw SeraApiException(NETWORK_FAILURE)
                }
                response.use { res ->
                    val rawBody = res.body?.string().orEmpty()
                    val retryAfter = parseRetryAfterSeconds(res.header("Retry-After"))
                    if (!res.isSuccessful) {
                        val parsedError = try {
                            json.decodeFromString<ApiErrorBody>(rawBody).error
                        } catch (_: Exception) {
                            null
                        }
                        val fallbackCode = when (res.code) {
                            404 -> ErrorCodes.NOT_FOUND
                            429 -> ErrorCodes.RATE_LIMITED
                            403 -> ErrorCodes.FORBIDDEN
                            413 -> ErrorCodes.TOO_LARGE
                            else -> ErrorCodes.INTERNAL
                        }
                        val error = parsedError ?: JobError(
                            code = fallbackCode,
                            message = when (res.code) {
                                429 -> "Too many requests. Try again in a moment."
                                404 -> "That download has expired."
                                else -> "Something went wrong on our side (HTTP ${res.code})."
                            },
                            retryable = res.code >= 500 || res.code == 429,
                        )
                        HttpJsonOutcome.Error(
                            SeraApiException(
                                apiError = error,
                                httpStatus = res.code,
                                retryAfterSeconds = retryAfter,
                            ),
                        )
                    } else {
                        try {
                            HttpJsonOutcome.Success(json.decodeFromString<T>(rawBody))
                        } catch (_: Exception) {
                            HttpJsonOutcome.Error(
                                SeraApiException(
                                    apiError = JobError(
                                        code = ErrorCodes.INTERNAL,
                                        message = "Received an unexpected response from the server.",
                                        retryable = true,
                                    ),
                                    httpStatus = res.code,
                                ),
                            )
                        }
                    }
                }
            }

            when (outcome) {
                is HttpJsonOutcome.Success -> return outcome.value
                is HttpJsonOutcome.Error -> {
                    val ex = outcome.exception
                    if (ex.httpStatus == 429 && attempt < maxRateLimitRetries) {
                        val waitSeconds = (ex.retryAfterSeconds ?: DEFAULT_RETRY_AFTER_SECONDS)
                            .coerceIn(1L, MAX_AUTO_RETRY_AFTER_SECONDS)
                        attempt += 1
                        sleeper(waitSeconds * 1000L)
                        continue
                    }
                    throw ex
                }
            }
        }
    }

    private sealed interface HttpJsonOutcome<out T> {
        data class Success<T>(val value: T) : HttpJsonOutcome<T>
        data class Error(val exception: SeraApiException) : HttpJsonOutcome<Nothing>
    }

    companion object {
        const val STREAM_GRACE_MS = 6_000L
        const val POLL_INTERVAL_MS = 1_500L
        private const val MAX_POLL_INTERVAL_MS = 4_000L
        private const val DEFAULT_RATE_LIMIT_RETRIES = 2
        private const val DEFAULT_RETRY_AFTER_SECONDS = 2L
        private const val MAX_AUTO_RETRY_AFTER_SECONDS = 60L
        private const val MAX_RETRY_AFTER_MS = 60_000L
        private val JOB_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")

        private val NETWORK_FAILURE = JobError(
            code = ErrorCodes.NETWORK_ERROR,
            message = "We couldn't reach the server.",
            hint = "Check your connection and server URL, then try again.",
            retryable = true,
        )

        fun parseRetryAfterSeconds(
            headerValue: String?,
            nowEpochMillis: Long = System.currentTimeMillis(),
        ): Long? {
            val trimmed = headerValue?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            trimmed.toLongOrNull()?.let { seconds ->
                return max(0L, seconds)
            }
            return runCatching {
                val parsed = ZonedDateTime.parse(trimmed, DateTimeFormatter.RFC_1123_DATE_TIME)
                val diffMs = parsed.toInstant().toEpochMilli() - nowEpochMillis
                max(0L, (diffMs + 999L) / 1000L)
            }.getOrNull()
        }

        private fun requireValidJobId(jobId: String): String {
            val trimmed = jobId.trim()
            if (!JOB_ID_PATTERN.matches(trimmed)) {
                throw SeraApiException(
                    JobError(
                        code = ErrorCodes.INVALID_URL,
                        message = "Invalid job identifier.",
                        retryable = false,
                    ),
                )
            }
            return trimmed
        }

        fun defaultHttpClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        }

        fun normalizeBaseUrl(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return DEFAULT_SERVER_URL
            val withScheme = if (trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true)
            ) {
                trimmed
            } else {
                "https://$trimmed"
            }
            val parsed = withScheme.toHttpUrlOrNull() ?: return DEFAULT_SERVER_URL
            if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
                return DEFAULT_SERVER_URL
            }
            return parsed.newBuilder()
                .query(null)
                .fragment(null)
                .build()
                .toString()
                .trimEnd('/')
        }

        fun resolveApiPath(baseUrl: String, path: String?): String? {
            if (!Formatters.isSafeDownloadPath(path)) return null
            return "${normalizeBaseUrl(baseUrl)}$path"
        }
    }
}
