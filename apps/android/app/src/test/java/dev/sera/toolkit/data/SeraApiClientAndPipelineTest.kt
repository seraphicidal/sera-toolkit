package dev.sera.toolkit.data

import dev.sera.toolkit.domain.DeviceFileSaver
import dev.sera.toolkit.domain.DownloadPipeline
import dev.sera.toolkit.domain.PipelineResult
import dev.sera.toolkit.domain.SavedMediaFile
import dev.sera.toolkit.model.CreateJobRequest
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.JobState
import dev.sera.toolkit.model.MediaKind
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SeraApiClientAndPipelineTest {
    private lateinit var server: MockWebServer
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("").toString().trimEnd('/')
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test(timeout = 15_000)
    fun resolvesMediaAndCreatesJobWith202() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(sampleMediaInfoJson("info-1", "opt-1080")))
        server.enqueue(MockResponse().setResponseCode(202).setBody(sampleJobJson("0123456789abcdef", "queued", 0)))

        val client = SeraApiClient(
            sleeper = {},
            streamGraceMs = 200L,
            pollIntervalMs = 10L,
        )

        val info = client.resolveMedia(baseUrl, "https://youtu.be/dQw4w9WgXcQ")
        assertEquals("info-1", info.id)
        assertEquals("Sample Video", info.title)

        val job = client.createJob(
            baseUrl,
            CreateJobRequest(infoId = info.id, optionIds = listOf("opt-1080")),
        )
        assertEquals("0123456789abcdef", job.id)
        assertEquals(JobState.QUEUED, job.state)

        val req1 = server.takeRequest()
        assertEquals("/api/media/info", req1.path)
        val req2 = server.takeRequest()
        assertEquals("/api/jobs", req2.path)
    }

    @Test(timeout = 15_000)
    fun observeJobStreamsSseEventsIncludingPingUntilDone() = runBlocking {
        val ssePayload = buildString {
            append(": ping\n\n")
            append("event: state\n")
            append("data: {\"type\":\"state\",\"job\":${sampleJobJson("0123456789abcdef", "downloading", 25)}}\n\n")
            append("event: progress\n")
            append("data: {\"type\":\"progress\",\"job\":${sampleJobJson("0123456789abcdef", "downloading", 75)}}\n\n")
            append("event: done\n")
            append("data: {\"type\":\"done\",\"job\":${sampleReadyJobJson("0123456789abcdef")}}\n\n")
        }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "text/event-stream; charset=utf-8")
                .setBody(ssePayload),
        )

        val client = SeraApiClient(sleeper = {}, streamGraceMs = 500L, pollIntervalMs = 10L)
        val emitted = client.observeJob(baseUrl, "0123456789abcdef").toList()

        assertTrue(emitted.size >= 2)
        assertEquals(JobState.READY, emitted.last().state)
        assertEquals("/api/jobs/0123456789abcdef/download", emitted.last().result?.downloadPath)
    }

    @Test(timeout = 15_000)
    fun observeJobFallsBackToPollingWhenSseFails() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("Internal error"))
        server.enqueue(MockResponse().setResponseCode(200).setBody(sampleJobJson("abcdef0123456789", "downloading", 55)))
        server.enqueue(MockResponse().setResponseCode(200).setBody(sampleReadyJobJson("abcdef0123456789")))

        val client = SeraApiClient(sleeper = {}, streamGraceMs = 500L, pollIntervalMs = 10L)
        val emitted = client.observeJob(baseUrl, "abcdef0123456789").toList()

        assertEquals(JobState.DOWNLOADING, emitted.first().state)
        assertEquals(JobState.READY, emitted.last().state)
        assertEquals("/api/jobs/abcdef0123456789/events", server.takeRequest().path)
        assertEquals("/api/jobs/abcdef0123456789", server.takeRequest().path)
        assertEquals("/api/jobs/abcdef0123456789", server.takeRequest().path)
    }

    @Test(timeout = 15_000)
    fun honors429RetryAfterHeaderBeforeRetrying() = runBlocking {
        val sleptMs = mutableListOf<Long>()
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .addHeader("Retry-After", "3")
                .setBody("""{"error":{"code":"RATE_LIMITED","message":"Slow down","retryable":true}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(sampleMediaInfoJson("info-after-429", "opt-1080")),
        )

        val client = SeraApiClient(
            sleeper = { ms -> sleptMs.add(ms) },
            streamGraceMs = 200L,
            pollIntervalMs = 10L,
        )

        val info = client.resolveMedia(baseUrl, "https://youtu.be/dQw4w9WgXcQ")
        assertEquals("info-after-429", info.id)
        assertEquals(listOf(3_000L), sleptMs)
    }

    @Test(timeout = 15_000)
    fun pipelineRecoversOnceWhenJobReturns404AfterIpChange() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(202).setBody(sampleJobJson("1111111111111111", "queued", 0)))
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setBody("""{"error":{"code":"NOT_FOUND","message":"That download has expired.","retryable":false}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setBody("""{"error":{"code":"NOT_FOUND","message":"That download has expired.","retryable":false}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(sampleMediaInfoJson("info-refreshed", "opt-1080-fresh")),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(202)
                .setBody(sampleJobJson("2222222222222222", "queued", 0)),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "text/event-stream; charset=utf-8")
                .setBody("event: done\ndata: {\"type\":\"done\",\"job\":${sampleReadyJobJson("2222222222222222")}}\n\n"),
        )

        val client = SeraApiClient(sleeper = {}, streamGraceMs = 200L, pollIntervalMs = 10L)
        val savedPaths = mutableListOf<String>()
        val pipeline = DownloadPipeline(
            apiClient = client,
            fileSaver = DeviceFileSaver { _, downloadPath, filename, mimeType, _, _ ->
                savedPaths.add(downloadPath)
                SavedMediaFile("content://downloads/1", filename, mimeType, 1024L)
            },
        )

        val task = DownloadTaskRecord(
            id = "task-1",
            sourceUrl = "https://youtu.be/dQw4w9WgXcQ",
            serverUrl = baseUrl,
            title = "Sample Video",
            providerLabel = "YouTube",
            infoId = "info-initial",
            optionIds = listOf("opt-1080-old"),
            selectedKind = MediaKind.VIDEO,
            selectedQualityLabel = "1080p",
        )

        val result = pipeline.execute(task)
        assertTrue(result is PipelineResult.Completed)
        val completed = result as PipelineResult.Completed
        assertEquals("2222222222222222", completed.jobId)
        assertEquals(listOf("/api/jobs/2222222222222222/download"), savedPaths)

        val req1 = server.takeRequest()
        assertEquals("/api/jobs", req1.path)
        assertTrue(req1.body.readUtf8().contains("opt-1080-old"))
        server.takeRequest()
        server.takeRequest()
        val reqResolve = server.takeRequest()
        assertEquals("/api/media/info", reqResolve.path)
        val reqRecreate = server.takeRequest()
        assertEquals("/api/jobs", reqRecreate.path)
        val recreateBody = reqRecreate.body.readUtf8()
        assertTrue(recreateBody.contains("info-refreshed"))
        assertTrue(recreateBody.contains("opt-1080-fresh"))
    }

    @Test(timeout = 15_000)
    fun pipelineRecoversOnceWhenCreateJobReturnsExpiredAndFailsOnSecondExpiry() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(410)
                .setBody("""{"error":{"code":"EXPIRED","message":"Token expired.","retryable":true}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(sampleMediaInfoJson("info-2", "opt-audio-fresh")),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(410)
                .setBody("""{"error":{"code":"EXPIRED","message":"Still expired.","retryable":true}}"""),
        )

        val client = SeraApiClient(sleeper = {}, streamGraceMs = 200L, pollIntervalMs = 10L)
        val pipeline = DownloadPipeline(
            apiClient = client,
            fileSaver = DeviceFileSaver { _, _, filename, mimeType, _, _ ->
                SavedMediaFile("content://downloads/1", filename, mimeType, 100L)
            },
        )
        val task = DownloadTaskRecord(
            id = "task-2",
            sourceUrl = "https://youtu.be/dQw4w9WgXcQ",
            serverUrl = baseUrl,
            title = "Sample",
            infoId = "info-old",
            optionIds = listOf("opt-old"),
            selectedKind = MediaKind.AUDIO,
            selectedQualityLabel = "MP3 320kbps",
        )

        val result = pipeline.execute(task)
        assertTrue(result is PipelineResult.Failed)
        val failed = result as PipelineResult.Failed
        assertEquals(ErrorCodes.EXPIRED, failed.error.code)
        assertEquals("Still expired.", failed.error.message)
        assertEquals(3, server.requestCount)
    }

    private fun sampleMediaInfoJson(infoId: String, videoOptionId: String): String {
        return """
            {
              "id": "$infoId",
              "provider": "youtube",
              "providerLabel": "YouTube",
              "url": "https://youtu.be/dQw4w9WgXcQ",
              "type": "single",
              "title": "Sample Video",
              "duration": 180,
              "expiresIn": 1800,
              "items": [
                {
                  "id": "item-1",
                  "index": 1,
                  "kind": "video",
                  "options": [
                    {
                      "id": "$videoOptionId",
                      "itemId": "item-1",
                      "kind": "video",
                      "container": "mp4",
                      "label": "1080p",
                      "filesizeBytes": 12000000,
                      "requiresConversion": false,
                      "recommended": true
                    },
                    {
                      "id": "opt-audio-fresh",
                      "itemId": "item-1",
                      "kind": "audio",
                      "container": "mp3",
                      "label": "MP3 320kbps",
                      "filesizeBytes": 4000000,
                      "requiresConversion": true,
                      "recommended": false
                    }
                  ]
                }
              ]
            }
        """.trimIndent()
    }

    private fun sampleJobJson(id: String, state: String, percent: Int): String {
        return """{"id":"$id","state":"$state","step":"Downloading","progress":{"percent":$percent},"provider":"youtube","createdAt":"2026-11-28T00:00:00Z","updatedAt":"2026-11-28T00:00:01Z"}"""
    }

    private fun sampleReadyJobJson(id: String): String {
        return """{"id":"$id","state":"ready","step":"Ready","progress":{"percent":100},"provider":"youtube","createdAt":"2026-11-28T00:00:00Z","updatedAt":"2026-11-28T00:00:05Z","result":{"downloadPath":"/api/jobs/$id/download","filename":"sample.mp4","sizeBytes":1024,"mimeType":"video/mp4","isArchive":false,"expiresAt":"2026-11-28T00:30:00Z"}}"""
    }
}
