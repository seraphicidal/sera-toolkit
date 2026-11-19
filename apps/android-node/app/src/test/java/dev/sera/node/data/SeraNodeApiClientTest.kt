package dev.sera.node.data

import dev.sera.node.model.ClaimRequest
import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.FailedRequest
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SeraJson
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SeraNodeApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: SeraNodeApiClient
    private lateinit var baseUrl: String
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        client = SeraNodeApiClient(
            baseHttpClient = OkHttpClient(),
            githubApiBaseUrl = baseUrl,
            githubRawBaseUrl = baseUrl,
            githubWebBaseUrl = baseUrl,
        )
        tempDir = Files.createTempDirectory("sera-api-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    @Test
    fun claimHandlesTaskAndManifestHashHeader() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("X-Sera-Manifest-Hash", "hash-abc-123")
                .setBody(
                    """
                    {
                      "id": "0123456789abcdef0123456789abcdef",
                      "kind": "job",
                      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                      "providerId": "youtube",
                      "planKeys": ["video/mp4/1080p"],
                      "createdAt": 1700000000
                    }
                    """.trimIndent(),
                ),
        )

        val outcome = client.claim(
            baseUrl = baseUrl,
            token = "tok_123",
            requestPayload = ClaimRequest(
                nodeId = "pixel-node",
                providers = listOf("youtube", "instagram"),
                capacity = 2,
                networkClass = "residential",
                features = listOf("trim", "subtitles", "items", "instagram-session"),
                transport = "cellular",
                appVersion = "1.8.0",
                ytdlpVersion = "2026.10.26",
            ),
        )

        assertTrue(outcome is ClaimOutcome.Task)
        val taskOutcome = outcome as ClaimOutcome.Task
        assertEquals("0123456789abcdef0123456789abcdef", taskOutcome.task.id)
        assertEquals("hash-abc-123", taskOutcome.manifestHash)

        val req = server.takeRequest()
        assertEquals("/internal/extraction/claim", req.path)
        assertEquals("Bearer tok_123", req.getHeader("Authorization"))
        val sentJson = req.body.readUtf8()
        assertTrue(sentJson.contains("\"networkClass\":\"residential\""))
        assertTrue(sentJson.contains("\"transport\":\"cellular\""))
        assertTrue(sentJson.contains("instagram-session"))
    }

    @Test
    fun claimHandlesNoContentAndAuthFailure() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(204)
                .addHeader("X-Sera-Manifest-Hash", "hash-xyz"),
        )

        val emptyOutcome = client.claim(
            baseUrl = baseUrl,
            token = "tok_123",
            requestPayload = ClaimRequest(
                nodeId = "pixel-node",
                providers = listOf("youtube"),
                capacity = 1,
                features = listOf("trim"),
            ),
        )
        assertTrue(emptyOutcome is ClaimOutcome.NoTask)
        assertEquals("hash-xyz", (emptyOutcome as ClaimOutcome.NoTask).manifestHash)

        server.enqueue(MockResponse().setResponseCode(401))
        var authThrown = false
        try {
            client.claim(
                baseUrl = baseUrl,
                token = "bad_tok",
                requestPayload = ClaimRequest(
                    nodeId = "pixel-node",
                    providers = listOf("youtube"),
                    capacity = 1,
                    features = emptyList(),
                ),
            )
        } catch (err: FatalAuthException) {
            authThrown = err.statusCode == 401
        }
        assertTrue(authThrown)
    }

    @Test
    fun submitsResolvedMediaWithoutExplicitNulls() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accepted":true}"""))

        val media = ResolvedMedia(
            provider = "youtube",
            providerLabel = "YouTube",
            url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            type = "single",
            title = "Sample Video",
            items = listOf(
                ResolvedItem(
                    index = 0,
                    kind = "video",
                    plans = listOf(
                        ResolvedPlan(
                            kind = "audio",
                            container = "mp3",
                            label = "MP3 320k",
                            requiresConversion = true,
                            recommended = false,
                            fetch = FetchPlan.Direct("https://cdn.example.com/a.mp4"),
                            convert = ConversionSpec.Audio(container = "mp3", bitrateKbps = 320),
                        ),
                    ),
                ),
            ),
        )

        val res = client.submitResolved(baseUrl, "tok_123", "0123456789abcdef", media)
        assertTrue(res.accepted)

        val req = server.takeRequest()
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"via\":\"direct\""))
        assertTrue(body.contains("\"kind\":\"audio\""))
        assertFalse(body.contains(":null"))
    }

    @Test
    fun uploadsFileStreamsAndHandlesCancellation() = runTest {
        val file = File(tempDir, "video clip.mp4").apply {
            writeBytes("binary-mp4-stream-payload".toByteArray())
        }
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accepted":true,"sizeBytes":25}"""))

        var streamedBytes = 0L
        val uploaded = client.uploadFile(
            baseUrl = baseUrl,
            token = "tok_123",
            taskId = "0123456789abcdef",
            file = file,
            fileName = "video clip.mp4",
            mimeType = "video/mp4",
            onBytesDelta = { streamedBytes += it },
        )

        assertTrue(uploaded.accepted)
        assertEquals(25L, streamedBytes)
        val req = server.takeRequest()
        assertEquals("/internal/extraction/0123456789abcdef/file?name=video%20clip.mp4&mime=video%2Fmp4", req.path)
        assertEquals("application/octet-stream", req.getHeader("Content-Type"))
        assertEquals("binary-mp4-stream-payload", req.body.readUtf8())

        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"accepted":false,"cancelled":true}"""))
        var cancelledThrown = false
        try {
            client.uploadFile(baseUrl, "tok_123", "0123456789abcdef", file, "video.mp4", "video/mp4")
        } catch (_: TaskCancelledException) {
            cancelledThrown = true
        }
        assertTrue(cancelledThrown)
        val cancelReq = server.takeRequest()
        assertEquals("/internal/extraction/0123456789abcdef/file?name=video.mp4&mime=video%2Fmp4", cancelReq.path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accepted":true}"""))
        assertTrue(client.completeTask(baseUrl, "tok_123", "0123456789abcdef").accepted)
        val completeReq = server.takeRequest()
        assertEquals("/internal/extraction/0123456789abcdef/complete", completeReq.path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accepted":true}"""))
        client.failTask(
            baseUrl,
            "tok_123",
            "0123456789abcdef",
            FailedRequest(code = "MEDIA_UNAVAILABLE", message = "Video unavailable"),
        )
        val failReq = server.takeRequest()
        assertEquals("/internal/extraction/0123456789abcdef/failed", failReq.path)
    }

    @Test
    fun parsesUpdateManifestAndGithubReleaseFallback() = runTest {
        val manifestJson = """
            {
              "manifestHash": "m-hash-99",
              "generatedAt": "2026-11-18T17:00:00Z",
              "ytdlp": {
                "version": "2026.10.26",
                "assetName": "yt-dlp",
                "sha256": "${"a".repeat(64)}",
                "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp",
                "proxyPath": "/internal/extraction/updates/ytdlp"
              },
              "androidNodeApp": {
                "versionCode": 2,
                "versionName": "1.8.1",
                "sha256": "${"b".repeat(64)}",
                "apkUrl": "https://github.com/seraphicidal/sera-toolkit/releases/download/v1.8.1/sera-node.apk",
                "proxyPath": "/internal/extraction/updates/apk",
                "releaseNotes": "Bug fixes"
              },
              "providerConfig": {
                "youtube": {
                  "playerClients": ["web_safari", "android"],
                  "extraArgs": [],
                  "remoteComponents": ["ejs:github"]
                },
                "instagram": {
                  "webApiAppId": "936619743392459",
                  "cdnHosts": ["cdninstagram.com", "fbcdn.net"],
                  "strategyOrder": ["ytdlp", "web-api", "oembed"]
                }
              }
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(manifestJson))

        val manifest = client.fetchUpdateManifest(baseUrl, "tok_123")
        assertEquals("m-hash-99", manifest.manifestHash)
        assertEquals("2026.10.26", manifest.ytdlp.version)
        assertEquals(2, manifest.androidNodeApp?.versionCode)
        assertEquals(listOf("web_safari", "android"), manifest.providerConfig.youtube.playerClients)

        val ghRelease = """
            {
              "tag_name": "android-node-v1.8.2",
              "body": "Release notes",
              "assets": [
                {
                  "name": "android-node-manifest.json",
                  "browser_download_url": "${baseUrl}/assets/android-node-manifest.json"
                }
              ]
            }
        """.trimIndent()
        val ghAssetManifest = """
            {
              "versionCode": 5,
              "versionName": "1.8.2",
              "sha256": "${"c".repeat(64)}",
              "apkUrl": "https://github.com/seraphicidal/sera-toolkit/releases/download/v1.8.2/app.apk",
              "proxyPath": ""
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(ghRelease))
        server.enqueue(MockResponse().setResponseCode(200).setBody(ghAssetManifest))

        val ghUpdate = client.fetchGithubLatestAndroidUpdate("seraphicidal/sera-toolkit")
        assertEquals(5, ghUpdate?.versionCode)
        assertEquals("1.8.2", ghUpdate?.versionName)

        assertEquals(42, SeraNodeApiClient.parseVersionCodeFromTag("android-node-v1.8.0+42"))
        val ghReleaseAssetNameOnly = """
            {
              "tag_name": "android-node-v1.8.3+43",
              "body": "Notes",
              "assets": [
                {
                  "name": "android-node-manifest.json",
                  "browser_download_url": "${baseUrl}/assets/manifest-2.json"
                },
                {
                  "name": "sera-node-arm64-v8a-release.apk",
                  "browser_download_url": "${baseUrl}/assets/sera-node-arm64-v8a-release.apk"
                }
              ]
            }
        """.trimIndent()
        val ghAssetNameManifest = """
            {
              "versionCode": 43,
              "versionName": "1.8.3",
              "sha256": "${"d".repeat(64)}",
              "assetName": "sera-node-arm64-v8a-release.apk"
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(ghReleaseAssetNameOnly))
        server.enqueue(MockResponse().setResponseCode(200).setBody(ghAssetNameManifest))

        val ghUpdateByAsset = client.fetchGithubLatestAndroidUpdate("seraphicidal/sera-toolkit")
        assertEquals(43, ghUpdateByAsset?.versionCode)
        assertEquals("${baseUrl}/assets/sera-node-arm64-v8a-release.apk", ghUpdateByAsset?.apkUrl)

        val decodedRoundTrip = SeraJson.decodeFromString<dev.sera.node.model.NodeUpdateManifest>(manifestJson)
        assertEquals(listOf("ejs:github"), decodedRoundTrip.providerConfig.youtube.remoteComponents)
    }

    @Test
    fun supportsFileStatusAndOffsetResumeUpload() = runTest {
        val fullBytes = "0123456789abcdefghij".toByteArray()
        val file = File(tempDir, "resume.bin").apply { writeBytes(fullBytes) }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"exists":true,"complete":false,"sizeBytes":10}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"accepted":true,"sizeBytes":20}"""),
        )

        val status = client.queryFileStatus(baseUrl, "tok_123", "0123456789abcdef", "resume.bin")
        assertTrue(status.exists)
        assertFalse(status.complete)
        assertEquals(10L, status.sizeBytes)

        var deltaBytes = 0L
        val resumed = client.uploadFile(
            baseUrl = baseUrl,
            token = "tok_123",
            taskId = "0123456789abcdef",
            file = file,
            fileName = "resume.bin",
            mimeType = "application/octet-stream",
            offsetBytes = status.sizeBytes,
            onBytesDelta = { deltaBytes += it },
        )
        assertTrue(resumed.accepted)
        assertEquals(10L, deltaBytes)

        val statusReq = server.takeRequest()
        assertEquals("GET", statusReq.method)
        assertEquals("/internal/extraction/0123456789abcdef/file?name=resume.bin", statusReq.path)

        val resumeReq = server.takeRequest()
        assertEquals("POST", resumeReq.method)
        assertEquals(
            "/internal/extraction/0123456789abcdef/file?name=resume.bin&mime=application%2Foctet-stream&offset=10",
            resumeReq.path,
        )
        assertEquals("bytes 10-19/20", resumeReq.getHeader("Content-Range"))
        assertEquals("abcdefghij", resumeReq.body.readUtf8())
    }
}
