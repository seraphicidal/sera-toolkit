package dev.sera.node.extractor

import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.RemoteSubtitleSpec
import dev.sera.node.model.RemoteTask
import dev.sera.node.model.RemoteTaskItem
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.TaskExecutionOutcome
import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.ToolsVersionInfo
import dev.sera.node.model.YoutubeHotConfig
import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ExtractorLadderAndTaskRunnerTest {
    private lateinit var server: MockWebServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = Files.createTempDirectory("sera-runner-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    private fun noopToolsManager(): ExtractionToolsManager = object : ExtractionToolsManager {
        override suspend fun ensureReady() = Unit
        override suspend fun getToolsVersions() = ToolsVersionInfo(ready = true, ytdlpVersion = "2026.10.26")
        override suspend fun updateYtdlpFromManifest(manifest: YtdlpUpdateInfo, authToken: String?, apiBaseUrl: String?) =
            ToolUpdateResult(false, message = "noop")
        override suspend fun forceRefreshTools(manifest: YtdlpUpdateInfo?, authToken: String?, apiBaseUrl: String?) =
            ToolUpdateResult(false, message = "noop")
    }

    @Test
    fun youtubeFallsBackAcrossPlayerClientsOnBotOrFormatFailure() = runTest {
        val seenClientArgs = mutableListOf<List<String>>()
        val seenRemoteComponents = mutableListOf<List<String>>()
        val validJson = """
            {
              "id": "abc123",
              "title": "Fallback Success",
              "webpage_url": "https://www.youtube.com/watch?v=abc123",
              "formats": [
                { "format_id": "18", "ext": "mp4", "protocol": "https", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "width": 640, "height": 360 }
              ]
            }
        """.trimIndent()

        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                seenClientArgs.add(options.extractorArgs)
                seenRemoteComponents.add(options.remoteComponents)
                if (seenClientArgs.size == 1) {
                    throw seraError(SeraErrorCode.SOURCE_BLOCKED, detail = "Sign in to confirm you're not a bot")
                }
                return parseYtdlpInfo(validJson)
            }

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val extractor = YoutubeExtractor(executor)
        val context = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
            hotConfig = ProviderHotConfig(
                youtube = YoutubeHotConfig(
                    playerClients = listOf("web"),
                    remoteComponents = listOf("ejs:github"),
                    potProviderUrl = "http://127.0.0.1:4416",
                ),
            ),
        )
        val res = extractor.resolve("https://www.youtube.com/watch?v=abc123".toHttpUrl(), context)
        assertEquals("Fallback Success", res.media.title)
        assertEquals(2, seenClientArgs.size)
        assertEquals(listOf("youtube:player_client=web", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"), seenClientArgs[0])
        assertEquals(listOf("youtube:player_client=web_safari", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"), seenClientArgs[1])
        assertEquals(listOf("ejs:github"), seenRemoteComponents[0])
        assertEquals("ytdlp:web_safari", res.media.metadata?.get("extractionStrategy")?.content)
        val wireExtractorArgs = res.media.items.flatMap { it.plans }
            .mapNotNull { (it.fetch as? FetchPlan.Ytdlp)?.extractorArgs }
            .flatten()
        assertTrue(wireExtractorArgs.isNotEmpty())
        assertTrue(wireExtractorArgs.all { it == "youtube:player_client=web_safari" })
        assertTrue(wireExtractorArgs.none { it.contains("base_url=") })
    }

    @Test
    fun instagramFallsBackToOembedAndWrapsAuthRequiredWhenNoSession() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """
                    {
                      "title": "Nice photo",
                      "author_name": "photographer",
                      "thumbnail_url": "${server.url("/thumb.jpg")}",
                      "thumbnail_width": 1080,
                      "thumbnail_height": 1080
                    }
                    """.trimIndent(),
                ),
        )
        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "ERROR: [Instagram] x: No video formats found!")
            }

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }
        val fetcher = OkHttpFetcher(OkHttpClient())
        val igExtractor = InstagramExtractor(executor, fetcher)
        val ctxNoDegraded = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(
                apiBaseUrl = "https://api.example.com",
                nodeToken = "tok",
                allowPrivateAddresses = true,
            ),
            hotConfig = null,
            allowDegraded = false,
        )
        val err = org.junit.Assert.assertThrows(SeraException::class.java) {
            kotlinx.coroutines.runBlocking {
                igExtractor.resolve("https://www.instagram.com/p/DcOX3hWFiey".toHttpUrl(), ctxNoDegraded)
            }
        }
        assertEquals(SeraErrorCode.PROVIDER_AUTH_REQUIRED, err.code)

        val fakeOembedUrl = server.url("/api/v1/oembed/?url=test")
        val oembedResp = fetcher.fetchText(fakeOembedUrl, allowPrivateAddresses = true)
        val oembed = dev.sera.node.model.SeraJson.decodeFromString(InstagramOembed.serializer(), oembedResp.body)
        assertEquals("photographer", oembed.author_name)
    }

    @Test
    fun taskRunnerResolvesAndExecutesYoutubeJobWithInfoJsonRetryAndHeightFallback() = runTest {
        val sampleJson = """
            {
              "id": "vid1",
              "title": "Test Clip",
              "uploader": "Channel",
              "webpage_url": "https://www.youtube.com/watch?v=vid1",
              "duration": 10,
              "formats": [
                { "format_id": "137", "ext": "mp4", "protocol": "https", "vcodec": "avc1.640028", "acodec": "mp4a.40.2", "width": 1920, "height": 1080, "tbr": 3000 },
                { "format_id": "136", "ext": "mp4", "protocol": "https", "vcodec": "avc1.4d401f", "acodec": "mp4a.40.2", "width": 1280, "height": 720, "tbr": 1500 }
              ]
            }
        """.trimIndent()
        val downloadAttempts = mutableListOf<Pair<String, Boolean>>()
        val fakeMp4 = byteArrayOf(0, 0, 0, 0x20) + "ftypisom".toByteArray() + ByteArray(64)

        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput =
                parseYtdlpInfo(sampleJson)

            override suspend fun download(options: YtdlpDownloadOptions) {
                downloadAttempts.add(options.format to (options.loadInfoJsonPath != null))
                if (downloadAttempts.size <= 4) {
                    throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "Requested format is not available")
                }
                File(options.workdir, "media.mp4").writeBytes(fakeMp4)
            }

            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()

            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = FfprobeResult(
                durationSeconds = 10.0,
                formatName = "mp4",
                sizeBytes = path.length(),
                video = FfprobeVideoStream("h264", 1280, 720, 30.0),
                audio = FfprobeAudioStream("aac", 2, 44100, 128_000L),
            )

            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = executor,
            httpFetcher = OkHttpFetcher(OkHttpClient()),
            defaultWorkRoot = tempDir,
        )
        val config = NodeRuntimeConfig(
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
            nodeToken = "tok",
            workDirPath = tempDir.absolutePath,
            allowPrivateAddresses = true,
        )

        val resolveOutcome = runner.executeTask(
            task = RemoteTask(
                id = "t1",
                kind = "resolve",
                url = "https://youtu.be/vid1?si=track",
                providerId = "youtube",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(resolveOutcome is TaskExecutionOutcome.Resolved)
        val resolvedMedia = (resolveOutcome as TaskExecutionOutcome.Resolved).media
        assertEquals("https://www.youtube.com/watch?v=vid1", resolvedMedia.url)

        val jobOutcome = runner.executeTask(
            task = RemoteTask(
                id = "t2",
                kind = "job",
                url = "https://www.youtube.com/watch?v=vid1",
                providerId = "youtube",
                planKeys = listOf("video/mp4/1080p"),
                items = listOf(RemoteTaskItem(index = 0, sourceId = "vid1")),
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(jobOutcome is TaskExecutionOutcome.JobFiles)
        val jobFiles = jobOutcome as TaskExecutionOutcome.JobFiles
        assertEquals(1, jobFiles.files.size)
        assertEquals("Channel - Test Clip.mp4", jobFiles.files[0].name)
        assertTrue(downloadAttempts.any { it.second })
        assertTrue(downloadAttempts.any { !it.second })
        assertTrue(downloadAttempts.last().first.startsWith("136"))
    }

    @Test
    fun taskRunnerDownloadsDirectThumbnailAndRejectsHtmlImposter() = runTest {
        val jpgBytes = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte()) + ByteArray(32)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(jpgBytes)))

        val thumbUrl = server.url("/cover.jpg").toString()
        val infoJson = """
            {
              "id": "vid2",
              "title": "Thumb Test",
              "webpage_url": "https://www.youtube.com/watch?v=vid2",
              "thumbnail": "$thumbUrl",
              "formats": [
                { "format_id": "18", "ext": "mp4", "protocol": "https", "vcodec": "avc1", "acodec": "mp4a", "width": 640, "height": 360 }
              ]
            }
        """.trimIndent()
        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = object : MediaCommandExecutor {
                override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions) = parseYtdlpInfo(infoJson)
                override suspend fun download(options: YtdlpDownloadOptions) = Unit
                override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
                override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
                override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
                override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            },
            httpFetcher = OkHttpFetcher(OkHttpClient()),
            defaultWorkRoot = tempDir,
        )

        val outcome = runner.executeTask(
            task = RemoteTask(
                id = "t3",
                kind = "job",
                url = "https://www.youtube.com/watch?v=vid2",
                providerId = "youtube",
                planKeys = listOf("image/jpg/Thumbnail"),
            ),
            config = NodeRuntimeConfig(
                apiBaseUrl = server.url("/").toString().trimEnd('/'),
                nodeToken = "tok",
                workDirPath = tempDir.absolutePath,
                allowPrivateAddresses = true,
            ),
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(outcome is TaskExecutionOutcome.JobFiles)
        val produced = (outcome as TaskExecutionOutcome.JobFiles).files.single()
        assertEquals("Thumb Test.jpg", produced.name)
        assertEquals(jpgBytes.size.toLong(), produced.sizeBytes)
    }

    @Test
    fun instagramWebApiFallbackHandlesRateLimitAndParsesCarousel() = runTest {
        var requestedUrl: String? = null
        var sentHeaders: Map<String, String> = emptyMap()

        val fakeExecutor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                throw seraError(SeraErrorCode.RATE_LIMITED, detail = "HTTP Error 429: Too Many Requests")
            }

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val fakeFetcher = object : HttpFetcher {
            override suspend fun fetchText(
                url: HttpUrl,
                maxBytes: Long,
                headers: Map<String, String>,
                keepCookies: Boolean,
                allowPrivateAddresses: Boolean,
                timeoutMs: Long,
                userAgent: String,
                isCancelled: () -> Boolean,
            ): HttpTextResponse {
                requestedUrl = url.toString()
                sentHeaders = headers
                return HttpTextResponse(
                    body = """
                        {
                          "items": [
                            {
                              "id": "123",
                              "code": "DcOX3hWFiey",
                              "media_type": 8,
                              "user": { "username": "creator" },
                              "caption": { "text": "Carousel post" },
                              "carousel_media": [
                                {
                                  "id": "slide-1",
                                  "media_type": 1,
                                  "image_versions2": {
                                    "candidates": [
                                      { "url": "https://scontent.cdninstagram.com/slide1.jpg", "width": 1080, "height": 1350 }
                                    ]
                                  }
                                },
                                {
                                  "id": "slide-2",
                                  "media_type": 2,
                                  "image_versions2": {
                                    "candidates": [
                                      { "url": "https://video.fbcdn.net/poster.jpg", "width": 1080, "height": 1920 }
                                    ]
                                  },
                                  "video_versions": [
                                    { "url": "https://video.fbcdn.net/slide2.mp4", "width": 1080, "height": 1920 }
                                  ],
                                  "video_duration": 8.4
                                }
                              ]
                            }
                          ]
                        }
                    """.trimIndent(),
                    url = url.toString(),
                )
            }

            override suspend fun downloadDirect(
                url: String,
                destination: File,
                maxBytes: Long,
                timeoutMs: Long,
                allowPrivateAddresses: Boolean,
                allowUrl: (HttpUrl) -> Boolean,
                isCancelled: () -> Boolean,
                onProgress: (DirectDownloadProgress) -> Unit,
            ) = throw UnsupportedOperationException()
        }

        val extractor = InstagramExtractor(fakeExecutor, fakeFetcher)
        val context = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(
                apiBaseUrl = "https://api.example.com",
                nodeToken = "tok",
                instagramSessionId = "sess%3D123",
            ),
            hotConfig = ProviderHotConfig(),
        )

        val resolved = extractor.resolve("https://www.instagram.com/p/DcOX3hWFiey/".toHttpUrl(), context)
        assertEquals("collection", resolved.media.type)
        assertEquals(2, resolved.media.items.size)
        assertTrue(requestedUrl?.contains("/api/v1/media/") == true)
        assertEquals("sessionid=sess%3D123", sentHeaders["cookie"])
        assertEquals("936619743392459", sentHeaders["x-ig-app-id"])
        assertEquals("web-api", resolved.media.metadata?.get("source")?.content)
        assertEquals("web-api", resolved.media.metadata?.get("extractionStrategy")?.content)
        assertTrue(resolved.media.items[1].plans.any { it.kind == "audio" && it.container == "mp3" })
    }

    @Test
    fun taskRunnerSupportsTwitterTikTokRedditThreadsCloudDirectAndGenericTasks() = runTest {
        val sampleJson = """
            {
              "id": "tt1",
              "title": "TikTok Clip",
              "uploader": "creator",
              "webpage_url": "https://www.tiktok.com/@creator/video/12345",
              "duration": 15,
              "formats": [
                { "format_id": "v1", "ext": "mp4", "protocol": "https", "vcodec": "h264", "acodec": "aac", "width": 720, "height": 1280 }
              ]
            }
        """.trimIndent()

        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput =
                parseYtdlpInfo(sampleJson)

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val fakeFetcher = object : HttpFetcher {
            override suspend fun fetchText(
                url: HttpUrl,
                maxBytes: Long,
                headers: Map<String, String>,
                keepCookies: Boolean,
                allowPrivateAddresses: Boolean,
                timeoutMs: Long,
                userAgent: String,
                isCancelled: () -> Boolean,
            ): HttpTextResponse {
                val u = url.toString()
                return when {
                    u.contains("cdn.syndication.twimg.com") -> HttpTextResponse(
                        body = """
                            {
                              "id_str": "999",
                              "text": "Hello from X",
                              "user": { "name": "Alice", "screen_name": "alice" },
                              "mediaDetails": [
                                {
                                  "type": "photo",
                                  "media_url_https": "https://pbs.twimg.com/media/AbCdEf.jpg",
                                  "original_info": { "width": 1200, "height": 800 }
                                }
                              ]
                            }
                        """.trimIndent(),
                        url = u,
                    )
                    u.contains("threads.com") -> HttpTextResponse(
                        body = """
                            <div class="OuterContainerFull">
                              <div class="BodyTextContainer">Threads post caption</div>
                              <video poster="https://scontent.cdninstagram.com/v/poster.jpg">
                                <source src="https://scontent.cdninstagram.com/v/clip.mp4" />
                              </video>
                              <div class="PostDateContainer"></div>
                            </div>
                        """.trimIndent(),
                        url = u,
                    )
                    u.endsWith("/robots.txt") -> HttpTextResponse(
                        body = "User-agent: *\nAllow: /\n",
                        url = u,
                    )
                    else -> HttpTextResponse(
                        body = """
                            <html>
                              <head>
                                <meta property="og:title" content="Generic Video Page" />
                                <meta property="og:video:secure_url" content="https://cdn.example.com/stream.mp4" />
                              </head>
                            </html>
                        """.trimIndent(),
                        url = u,
                    )
                }
            }

            override suspend fun head(
                url: HttpUrl,
                headers: Map<String, String>,
                allowPrivateAddresses: Boolean,
                timeoutMs: Long,
                userAgent: String,
                isCancelled: () -> Boolean,
            ): HttpHeadResponse = HttpHeadResponse(
                status = 200,
                contentType = "video/mp4",
                contentLength = 1048576L,
                url = url.toString(),
            )

            override suspend fun downloadDirect(
                url: String,
                destination: File,
                maxBytes: Long,
                timeoutMs: Long,
                allowPrivateAddresses: Boolean,
                allowUrl: (HttpUrl) -> Boolean,
                isCancelled: () -> Boolean,
                onProgress: (DirectDownloadProgress) -> Unit,
            ) = throw UnsupportedOperationException()
        }

        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = executor,
            httpFetcher = fakeFetcher,
            defaultWorkRoot = tempDir,
        )
        val config = NodeRuntimeConfig(
            apiBaseUrl = "https://api.example.com",
            nodeToken = "tok",
            workDirPath = tempDir.absolutePath,
            allowPrivateAddresses = true,
        )

        val twitterOutcome = runner.executeTask(
            task = RemoteTask(
                id = "tw1",
                kind = "resolve",
                url = "https://twitter.com/alice/status/999/photo/1",
                providerId = "twitter",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(twitterOutcome is TaskExecutionOutcome.Resolved)
        val twitterMedia = (twitterOutcome as TaskExecutionOutcome.Resolved).media
        assertEquals("twitter", twitterMedia.provider)
        assertEquals("Hello from X", twitterMedia.title)
        assertEquals("image", twitterMedia.items.single().kind)

        val tiktokOutcome = runner.executeTask(
            task = RemoteTask(
                id = "tt1",
                kind = "resolve",
                url = "https://www.tiktok.com/@creator/photo/12345",
                providerId = "tiktok",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(tiktokOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("TikTok Clip", (tiktokOutcome as TaskExecutionOutcome.Resolved).media.title)

        val redditOutcome = runner.executeTask(
            task = RemoteTask(
                id = "rd1",
                kind = "resolve",
                url = "https://v.redd.it/abc123xyz",
                providerId = "reddit",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(redditOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("https://v.redd.it/abc123xyz/HLSPlaylist.m3u8", (redditOutcome as TaskExecutionOutcome.Resolved).media.url)

        val threadsOutcome = runner.executeTask(
            task = RemoteTask(
                id = "th1",
                kind = "resolve",
                url = "https://www.threads.net/@creator/post/C12345",
                providerId = "threads",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(threadsOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("Threads post caption", (threadsOutcome as TaskExecutionOutcome.Resolved).media.title)

        val directOutcome = runner.executeTask(
            task = RemoteTask(
                id = "dir1",
                kind = "resolve",
                url = "https://cdn.example.com/files/sample-clip.mp4",
                providerId = "direct",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(directOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("sample-clip", (directOutcome as TaskExecutionOutcome.Resolved).media.title)

        val genericOutcome = runner.executeTask(
            task = RemoteTask(
                id = "gen1",
                kind = "resolve",
                url = "https://blog.example.com/watch-this",
                providerId = "generic",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(genericOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("Generic Video Page", (genericOutcome as TaskExecutionOutcome.Resolved).media.title)
    }

    @Test
    fun genericFallbackPreservesTaskProviderIdAndSubtitlesAndSparsePlaylistsWork() = runTest {
        var capturedDownloadOptions: YtdlpDownloadOptions? = null
        var capturedSubtitleOptions: YtdlpSubtitleOptions? = null
        val fakeMp4 = byteArrayOf(0, 0, 0, 0x20) + "ftypisom".toByteArray() + ByteArray(64)

        val sparseYoutubeJson = """
            {
              "id": "pl1",
              "title": "Sparse Playlist",
              "webpage_url": "https://www.youtube.com/playlist?list=PL123",
              "entries": [
                {
                  "id": "entry4",
                  "title": "Fourth Video",
                  "playlist_index": 4,
                  "duration": 12,
                  "subtitles": {
                    "en": [ { "ext": "vtt", "name": "English" } ]
                  },
                  "formats": [
                    { "format_id": "18", "ext": "mp4", "protocol": "https", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "width": 640, "height": 360 }
                  ]
                }
              ]
            }
        """.trimIndent()

        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                return parseYtdlpInfo(sparseYoutubeJson)
            }

            override suspend fun download(options: YtdlpDownloadOptions) {
                capturedDownloadOptions = options
                File(options.workdir, "media.mp4").writeBytes(fakeMp4)
            }

            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions): File {
                capturedSubtitleOptions = options
                return File(options.workdir, "subtitle.en.srt").apply {
                    writeText("1\n00:00:00,000 --> 00:00:02,000\nHello\n")
                }
            }

            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = FfprobeResult(
                durationSeconds = 12.0,
                formatName = "mp4",
                sizeBytes = path.length(),
                video = FfprobeVideoStream("h264", 640, 360, 30.0),
                audio = FfprobeAudioStream("aac", 2, 44100, 128_000L),
            )

            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val fakeFetcher = object : HttpFetcher {
            override suspend fun fetchText(
                url: HttpUrl,
                maxBytes: Long,
                headers: Map<String, String>,
                keepCookies: Boolean,
                allowPrivateAddresses: Boolean,
                timeoutMs: Long,
                userAgent: String,
                isCancelled: () -> Boolean,
            ): HttpTextResponse {
                if (url.encodedPath == "/robots.txt") {
                    return HttpTextResponse(body = "User-agent: *\nAllow: /\n", url = url.toString())
                }
                return HttpTextResponse(
                    body = """
                        <html>
                          <head>
                            <meta property="og:title" content="Fallback Media" />
                            <meta property="og:video:secure_url" content="https://cdn.example.com/fallback.mp4" />
                          </head>
                        </html>
                    """.trimIndent(),
                    url = url.toString(),
                )
            }

            override suspend fun head(
                url: HttpUrl,
                headers: Map<String, String>,
                allowPrivateAddresses: Boolean,
                timeoutMs: Long,
                userAgent: String,
                isCancelled: () -> Boolean,
            ): HttpHeadResponse = HttpHeadResponse(
                status = 200,
                contentType = "text/html",
                contentLength = null,
                url = url.toString(),
            )

            override suspend fun downloadDirect(
                url: String,
                destination: File,
                maxBytes: Long,
                timeoutMs: Long,
                allowPrivateAddresses: Boolean,
                allowUrl: (HttpUrl) -> Boolean,
                isCancelled: () -> Boolean,
                onProgress: (DirectDownloadProgress) -> Unit,
            ) = throw UnsupportedOperationException()
        }

        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = executor,
            httpFetcher = fakeFetcher,
            defaultWorkRoot = tempDir,
        )
        val config = NodeRuntimeConfig(
            apiBaseUrl = "https://api.example.com",
            nodeToken = "tok",
            workDirPath = tempDir.absolutePath,
            youtubePlayerClients = "web_safari",
            youtubePotProviderUrl = "http://127.0.0.1:4416",
            allowPrivateAddresses = true,
        )

        val fallbackOutcome = runner.executeTask(
            task = RemoteTask(
                id = "fb1",
                kind = "resolve",
                url = "https://cdn.example.com/page.mp4",
                providerId = "direct",
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(fallbackOutcome is TaskExecutionOutcome.Resolved)
        assertEquals("direct", (fallbackOutcome as TaskExecutionOutcome.Resolved).media.provider)

        val jobOutcome = runner.executeTask(
            task = RemoteTask(
                id = "yt_sparse_1",
                kind = "job",
                url = "https://www.youtube.com/playlist?list=PL123",
                providerId = "youtube",
                planKeys = listOf("video/mp4/360p"),
                items = listOf(RemoteTaskItem(index = 3, sourceId = null)),
                subtitles = RemoteSubtitleSpec(lang = "en", auto = false, format = "srt", only = false),
            ),
            config = config,
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(jobOutcome is TaskExecutionOutcome.JobFiles)
        assertEquals(4, capturedDownloadOptions?.playlistItem)
        assertEquals(
            listOf("youtube:player_client=web_safari", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"),
            capturedDownloadOptions?.extractorArgs,
        )
        assertEquals(4, capturedSubtitleOptions?.playlistItem)
        assertEquals(
            listOf("youtube:player_client=web_safari", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"),
            capturedSubtitleOptions?.extractorArgs,
        )

        val targetedMedia = ResolvedMedia(
            provider = "generic",
            providerLabel = "Generic",
            url = "https://example.com/playlist",
            type = "playlist",
            title = "Targeted",
            items = listOf(
                ResolvedItem(
                    index = 2,
                    kind = "video",
                    plans = listOf(
                        ResolvedPlan(
                            kind = "video",
                            container = "mp4",
                            label = "MP4",
                            fetch = FetchPlan.Ytdlp(
                                selector = "best",
                                target = "https://example.com/video-3",
                                useExtractors = "default",
                            ),
                        ),
                    ),
                ),
            ),
        )
        val targetedItem = targetedMedia.items.single()
        val targetedFetch = targetedItem.plans.single().fetch as FetchPlan.Ytdlp
        assertNull(resolvePlaylistItem(targetedMedia, targetedItem, targetedFetch))
        assertEquals(3, resolvePlaylistItem(targetedMedia, targetedItem, targetedFetch.copy(target = null)))
        val matchedSparse = matchSelection(targetedMedia, TaskSelection(itemIndex = 2, sourceId = null, planKey = "video/mp4/MP4"))
        assertEquals(2, matchedSparse.item.index)
    }
}
