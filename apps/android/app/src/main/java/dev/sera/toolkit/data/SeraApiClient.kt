package dev.sera.toolkit.data

import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.model.ApiErrorBody
import dev.sera.toolkit.model.CreateJobRequest
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.HealthReport
import dev.sera.toolkit.model.ImportRequest
import dev.sera.toolkit.model.Job
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.JobState
import dev.sera.toolkit.model.LegalReportRequest
import dev.sera.toolkit.model.LegalReportResponse
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.ResolveRequest
import dev.sera.toolkit.model.ServiceInfo
import dev.sera.toolkit.model.SseJobEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SeraApiException(val apiError: JobError) : Exception(apiError.message)

class SeraApiClient(
    val httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val sseClient: OkHttpClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = false
    }

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
        return withContext(Dispatchers.IO) {
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

            pollJob = launch(Dispatchers.IO) {
                var currentDelayMs = POLL_INTERVAL_MS
                while (isActive && !stopped.get()) {
                    try {
                        val next = applyMonotonic(getJob(baseUrl, safeJobId))
                        trySend(next)
                        if (next.state.isTerminal) {
                            finishStream()
                            return@launch
                        }
                        delay(currentDelayMs)
                        currentDelayMs = (currentDelayMs * 5L / 4L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                    } catch (e: SeraApiException) {
                        if (!e.apiError.retryable) {
                            val nowIso = Instant.now().toString()
                            val prev = latestJob
                            val synthetic = Job(
                                id = safeJobId,
                                state = if (e.apiError.code == ErrorCodes.EXPIRED) JobState.EXPIRED else JobState.FAILED,
                                step = "Failed",
                                progress = prev?.progress ?: dev.sera.toolkit.model.JobProgress(percent = 0.0),
                                provider = prev?.provider ?: "generic",
                                createdAt = prev?.createdAt ?: nowIso,
                                updatedAt = nowIso,
                                error = e.apiError,
                            )
                            trySend(synthetic)
                            finishStream()
                            return@launch
                        }
                        currentDelayMs = (currentDelayMs * 2L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                        delay(currentDelayMs)
                    } catch (_: Exception) {
                        currentDelayMs = (currentDelayMs * 2L).coerceAtMost(MAX_POLL_INTERVAL_MS)
                        delay(currentDelayMs)
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

        graceJob = launch {
            delay(STREAM_GRACE_MS)
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
        return withContext(Dispatchers.IO) {
            val response = try {
                httpClient.newCall(request).execute()
            } catch (_: IOException) {
                throw SeraApiException(NETWORK_FAILURE)
            }
            response.use { res ->
                val rawBody = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val parsedError = try {
                        json.decodeFromString<ApiErrorBody>(rawBody).error
                    } catch (_: Exception) {
                        null
                    }
                    throw SeraApiException(
                        parsedError ?: JobError(
                            code = ErrorCodes.INTERNAL,
                            message = "Something went wrong on our side (HTTP ${res.code}).",
                            retryable = res.code >= 500 || res.code == 429,
                        ),
                    )
                }
                try {
                    json.decodeFromString<T>(rawBody)
                } catch (_: Exception) {
                    throw SeraApiException(
                        JobError(
                            code = ErrorCodes.INTERNAL,
                            message = "Received an unexpected response from the server.",
                            retryable = true,
                        ),
                    )
                }
            }
        }
    }

    companion object {
        const val STREAM_GRACE_MS = 6_000L
        const val POLL_INTERVAL_MS = 1_500L
        private const val MAX_POLL_INTERVAL_MS = 4_000L
        private val JOB_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")

        private val NETWORK_FAILURE = JobError(
            code = ErrorCodes.NETWORK_ERROR,
            message = "We couldn't reach the server.",
            hint = "Check your connection and server URL, then try again.",
            retryable = true,
        )

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
