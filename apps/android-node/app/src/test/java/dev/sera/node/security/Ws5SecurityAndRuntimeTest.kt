package dev.sera.node.security

import dev.sera.node.data.ConnectionTestResult
import dev.sera.node.data.EnvConfigParser
import dev.sera.node.data.NodeLogStore
import dev.sera.node.data.NodePreferences
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.SecretCipher
import dev.sera.node.data.SeraNodeApiClient
import dev.sera.node.extractor.DirectDownloadProgress
import dev.sera.node.extractor.DirectDownloadResult
import dev.sera.node.extractor.ExtractionExecutionContext
import dev.sera.node.extractor.FfprobeResult
import dev.sera.node.extractor.GenericExtractor
import dev.sera.node.extractor.HttpFetcher
import dev.sera.node.extractor.HttpTextResponse
import dev.sera.node.extractor.MediaCommandExecutor
import dev.sera.node.extractor.OkHttpFetcher
import dev.sera.node.extractor.ParsedYtdlpOutput
import dev.sera.node.extractor.SeraErrorCode
import dev.sera.node.extractor.SeraException
import dev.sera.node.extractor.SeraNodeTaskRunner
import dev.sera.node.extractor.YoutubeExtractor
import dev.sera.node.extractor.YtdlpArchiveUpdater
import dev.sera.node.extractor.YtdlpCommandBuilder
import dev.sera.node.extractor.YtdlpDownloadOptions
import dev.sera.node.extractor.YtdlpProbeOptions
import dev.sera.node.extractor.YtdlpSubtitleOptions
import dev.sera.node.extractor.assertPublicUrlForExternalTool
import dev.sera.node.extractor.isPublicAddress
import dev.sera.node.extractor.parseUserUrl
import dev.sera.node.extractor.parseYtdlpInfo
import dev.sera.node.extractor.sanitizeResolvedMedia
import dev.sera.node.extractor.seraError
import dev.sera.node.extractor.stableSourceId
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.FailedRequest
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.NetworkTransport
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.ProgressRequest
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.RemoteTask
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.SubtitleTrack
import dev.sera.node.model.TaskExecutionOutcome
import dev.sera.node.model.ToolUpdateResult
import dev.sera.node.model.ToolsVersionInfo
import dev.sera.node.model.YoutubeHotConfig
import dev.sera.node.model.YtdlpUpdateInfo
import dev.sera.node.model.isValidTaskId
import dev.sera.node.service.ActiveTaskInfo
import dev.sera.node.service.NodeRuntimeTracker
import dev.sera.node.service.NodeServiceState
import dev.sera.node.updater.AppSelfUpdater
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.file.Files
import javax.net.ssl.SSLHandshakeException

class Ws5SecurityAndRuntimeTest {
    private lateinit var server: MockWebServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = Files.createTempDirectory("sera-ws5-test").toFile()
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
    fun blocksLocalHostnamesAndDnsRebindingAddresses() = runTest {
        val localUrls = listOf(
            "http://localhost/admin",
            "https://sub.localhost/file.mp4",
            "https://printer.local/media.mp4",
            "https://metadata.google.internal/computeMetadata/v1/",
            "https://service.internal/secret",
            "https://router.home.arpa/config",
        )
        for (candidate in localUrls) {
            val ex = assertThrows(candidate, SeraException::class.java) {
                parseUserUrl(candidate, allowPrivateAddresses = false)
            }
            assertEquals(SeraErrorCode.BLOCKED_ADDRESS, ex.code)
        }

        val privateDns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        }
        val fetcher = OkHttpFetcher(OkHttpClient(), dnsResolver = privateDns)
        val rebindEx = assertThrows(SeraException::class.java) {
            runBlocking {
                fetcher.fetchText(
                    url = "https://rebind.example.com/page".toHttpUrl(),
                    allowPrivateAddresses = false,
                )
            }
        }
        assertEquals(SeraErrorCode.BLOCKED_ADDRESS, rebindEx.code)

        val externalBlockEx = assertThrows(SeraException::class.java) {
            assertPublicUrlForExternalTool(
                rawUrl = "https://rebind.example.com/watch?v=1",
                allowPrivateAddresses = false,
                resolver = { arrayOf(InetAddress.getByAddress(byteArrayOf(10, 0, 0, 5))) },
            )
        }
        assertEquals(SeraErrorCode.BLOCKED_ADDRESS, externalBlockEx.code)

        assertPublicUrlForExternalTool(
            rawUrl = "https://example.com/watch?v=1",
            allowPrivateAddresses = false,
            resolver = { arrayOf(InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34))) },
        )
    }

    @Test
    fun genericExtractorDoesNotFallThroughToYtdlpOnBlockedOrNetworkErrors() = runTest {
        var dumpInfoCalled = false
        val fakeExecutor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                dumpInfoCalled = true
                throw AssertionError("yt-dlp must not be invoked on network or blocked address errors")
            }

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }

        val failingFetcher = object : HttpFetcher {
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
                    return HttpTextResponse(body = "", url = url.toString(), status = 404)
                }
                throw seraError(SeraErrorCode.NETWORK_ERROR, detail = "connection reset")
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
            ): DirectDownloadResult = throw UnsupportedOperationException()
        }

        val extractor = GenericExtractor(fakeExecutor, failingFetcher)
        val context = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
            hotConfig = null,
        )
        val ex = assertThrows(SeraException::class.java) {
            runBlocking {
                extractor.resolve("https://example.com/article".toHttpUrl(), context)
            }
        }
        assertEquals(SeraErrorCode.NETWORK_ERROR, ex.code)
        assertFalse(dumpInfoCalled)
    }

    @Test
    fun ytdlpExtraArgsAllowlistStripsDangerousFlagsAndYoutubeSanitizesConfig() = runTest {
        val filtered = YtdlpCommandBuilder.filterSafeExtraArgs(
            listOf(
                "--no-remote-components",
                "--force-ipv4",
                "--sleep-requests",
                "2",
                "--concurrent-fragments=4",
                "--geo-bypass-country",
                "US",
                "--downloader",
                "curl",
                "--exec",
                "sh -c id",
                "--exe",
                "evil",
                "--ffmpeg-location",
                "/tmp/evil",
                "--js-runtimes",
                "node:/tmp/evil",
                "--print-to-file",
                "title",
                "--no-check-certificates",
                "-o/tmp/pwn",
                "-P/tmp/pwn",
                "-a/etc/passwd",
                "--sleep-requests",
                "99999",
            ),
        )

        assertEquals(
            listOf(
                "--no-remote-components",
                "--force-ipv4",
                "--sleep-requests",
                "2",
                "--concurrent-fragments",
                "4",
                "--geo-bypass-country",
                "US",
            ),
            filtered,
        )

        var capturedExtractorArgs: List<String>? = null
        val minimalYoutubeJson = """
            {
              "id": "abc",
              "title": "Sanitized Config Test",
              "webpage_url": "https://www.youtube.com/watch?v=abc",
              "formats": [
                { "format_id": "18", "ext": "mp4", "protocol": "https", "vcodec": "avc1", "acodec": "mp4a", "width": 640, "height": 360 }
              ]
            }
        """.trimIndent()
        val dummyExecutor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                capturedExtractorArgs = options.extractorArgs
                return parseYtdlpInfo(minimalYoutubeJson)
            }

            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }
        val yt = YoutubeExtractor(dummyExecutor)
        val badContext = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(
                apiBaseUrl = "https://api.example.com",
                nodeToken = "tok",
                youtubePlayerClients = "web;evil=1,android",
                youtubePotProviderUrl = "http://user:pass@127.0.0.1:4416;injected=1",
            ),
            hotConfig = ProviderHotConfig(
                youtube = YoutubeHotConfig(
                    playerClients = listOf("bad client", "web;inject"),
                    potProviderUrl = "javascript:alert(1)",
                ),
            ),
        )
        yt.resolve("https://www.youtube.com/watch?v=abc".toHttpUrl(), badContext)
        assertEquals(listOf("youtube:player_client=android"), capturedExtractorArgs)
    }

    @Test
    fun rejectsTraversalTaskIdsInValidationRunnerAndApiClient() = runTest {
        assertTrue(isValidTaskId("0123456789abcdef"))
        assertTrue(isValidTaskId("task_abc-123"))
        assertFalse(isValidTaskId(""))
        assertFalse(isValidTaskId(".."))
        assertFalse(isValidTaskId("../escape"))
        assertFalse(isValidTaskId("a/b"))
        assertFalse(isValidTaskId("a\\b"))
        assertFalse(isValidTaskId("a".repeat(65)))

        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = object : MediaCommandExecutor {
                override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions) = throw UnsupportedOperationException()
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
                id = "../escape",
                kind = "resolve",
                url = "https://www.youtube.com/watch?v=abc",
                providerId = "youtube",
            ),
            config = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
            hotConfig = null,
            onProgress = { true },
        )
        assertTrue(outcome is TaskExecutionOutcome.Failed)
        assertEquals("INVALID_URL", (outcome as TaskExecutionOutcome.Failed).code)

        val baseUrl = server.url("/").toString().trimEnd('/')
        val api = SeraNodeApiClient(OkHttpClient())
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                api.reportProgress(baseUrl, "tok", "../escape", ProgressRequest(10.0, "step"))
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                api.completeTask(baseUrl, "tok", "bad/id")
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                api.failTask(baseUrl, "tok", "..", FailedRequest(code = "CANCELLED"))
            }
        }
    }

    @Test
    fun okHttpFetcherAndTaskRunnerPropagateExternalCancellationPromptly() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val fetcher = OkHttpFetcher(OkHttpClient())
        val started = System.nanoTime()
        val deferred = async(Dispatchers.IO) {
            fetcher.fetchText(
                url = server.url("/hang"),
                allowPrivateAddresses = true,
                timeoutMs = 30_000L,
            )
        }
        delay(120L)
        deferred.cancel()
        val cancelled = try {
            deferred.await()
            false
        } catch (_: CancellationException) {
            true
        }
        val elapsedMs = (System.nanoTime() - started) / 1_000_000L
        assertTrue(cancelled)
        assertTrue(elapsedMs < 5_000L)

        val runner = SeraNodeTaskRunner(
            toolsManager = noopToolsManager(),
            executor = object : MediaCommandExecutor {
                override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions): ParsedYtdlpOutput {
                    delay(10_000L)
                    return parseYtdlpInfo("""{"id":"x","title":"t","formats":[]}""")
                }

                override suspend fun download(options: YtdlpDownloadOptions) = Unit
                override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
                override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
                override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
                override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            },
            httpFetcher = OkHttpFetcher(OkHttpClient()),
            defaultWorkRoot = tempDir,
        )

        val taskJob = async(Dispatchers.Default) {
            runner.executeTask(
                task = RemoteTask(
                    id = "valid_task_1",
                    kind = "resolve",
                    url = "https://www.youtube.com/watch?v=abc",
                    providerId = "youtube",
                ),
                config = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
                hotConfig = null,
                onProgress = { true },
            )
        }
        delay(100L)
        taskJob.cancel()
        var propagated = false
        try {
            taskJob.await()
        } catch (_: CancellationException) {
            propagated = true
        }
        assertTrue(propagated)
    }

    @Test
    fun sanitizesResolvedMediaContractBoundsAndTransportWireValues() {
        val longSourceId = "https://cdn.example.com/" + "a".repeat(300)
        val hashed = stableSourceId(longSourceId)
        assertTrue(hashed.length <= 200)
        assertEquals(hashed, stableSourceId(longSourceId))

        val dirty = ResolvedMedia(
            provider = "generic",
            providerLabel = "P".repeat(100),
            url = "https://example.com/v",
            type = "single",
            title = "T".repeat(600),
            description = "D".repeat(6000),
            author = "A".repeat(250),
            duration = -5.0,
            items = listOf(
                ResolvedItem(
                    sourceId = longSourceId,
                    index = 0,
                    kind = "video",
                    title = "I".repeat(600),
                    width = 0,
                    height = -10,
                    duration = Double.NaN,
                    filesizeBytes = -1L,
                    subtitles = listOf(
                        SubtitleTrack(lang = "en", label = "L".repeat(150)),
                        SubtitleTrack(lang = "bad lang!", label = "Invalid"),
                    ),
                    plans = listOf(
                        ResolvedPlan(
                            kind = "video",
                            container = "mp4",
                            label = "Q".repeat(90),
                            detail = "X".repeat(600),
                            width = 0,
                            height = 720,
                            fps = -1.0,
                            audioBitrateKbps = Double.POSITIVE_INFINITY,
                            videoCodec = "v".repeat(50),
                            audioCodec = "a".repeat(50),
                            filesizeBytes = -42L,
                            fetch = FetchPlan.Ytdlp(
                                selector = "best",
                                extractorArgs = listOf("k=" + "z".repeat(250)),
                            ),
                        ),
                    ),
                ),
            ),
        )

        val clean = sanitizeResolvedMedia(dirty)
        assertEquals(64, clean.providerLabel.length)
        assertEquals(500, clean.title.length)
        assertEquals(5_000, clean.description?.length)
        assertEquals(200, clean.author?.length)
        assertNull(clean.duration)

        val item = clean.items.single()
        assertEquals(hashed, item.sourceId)
        assertEquals(500, item.title?.length)
        assertNull(item.width)
        assertNull(item.height)
        assertNull(item.duration)
        assertNull(item.filesizeBytes)
        assertEquals(1, item.subtitles?.size)
        assertEquals("en", item.subtitles?.single()?.lang)
        assertEquals(100, item.subtitles?.single()?.label?.length)

        val plan = item.plans.single()
        assertEquals(64, plan.label.length)
        assertEquals(500, plan.detail?.length)
        assertNull(plan.width)
        assertEquals(720, plan.height)
        assertNull(plan.fps)
        assertNull(plan.audioBitrateKbps)
        assertEquals(32, plan.videoCodec?.length)
        assertEquals(32, plan.audioCodec?.length)
        assertNull(plan.filesizeBytes)
        val fetch = plan.fetch as FetchPlan.Ytdlp
        assertEquals(200, fetch.extractorArgs?.single()?.length)

        assertNull(NetworkTransport.NONE.wireValueOrNull())
        assertEquals("wifi", NetworkTransport.WIFI.wireValueOrNull())
        assertEquals("cellular", NetworkTransport.CELLULAR.wireValueOrNull())
        assertEquals("other", NetworkTransport.OTHER.wireValueOrNull())
    }

    @Test
    fun secretCipherEncryptsDecryptsAndMigratesPlaintextSafely() {
        val secret = "tok_super_secret_value_123"
        val enc1 = SecretCipher.encrypt(secret)
        val enc2 = SecretCipher.encrypt(secret)

        assertTrue(SecretCipher.isEncrypted(enc1))
        assertNotEquals(secret, enc1)
        assertNotEquals(enc1, enc2)
        assertEquals(secret, SecretCipher.decrypt(enc1))
        assertEquals(secret, SecretCipher.decrypt(enc2))

        assertFalse(SecretCipher.isEncrypted("legacy-plaintext-token"))
        assertEquals("legacy-plaintext-token", SecretCipher.decrypt("legacy-plaintext-token"))
        assertEquals("", SecretCipher.decrypt("enc:v1:not-valid-base64!!!"))
        assertEquals("", SecretCipher.encrypt(""))
        assertEquals("", SecretCipher.decrypt(""))
    }

    @Test
    fun logStoreCapsMessagesSupportsUndoAndEnvParserPreservesEmptySecrets() {
        val store = NodeLogStore(maxEntries = 10)
        store.info("TEST", "x".repeat(3_000))
        store.warn("TEST", "second")
        assertEquals(2, store.entries.value.size)
        assertEquals(2_000, store.entries.value[0].message.length)

        val snapshot = store.clearAndSnapshot()
        assertEquals(2, snapshot.size)
        assertTrue(store.entries.value.isEmpty())

        store.restore(snapshot)
        assertEquals(2, store.entries.value.size)
        assertEquals("second", store.entries.value[1].message)
        assertTrue(store.exportText().contains("second"))

        val parsed = EnvConfigParser.parse(
            """
            SERA_INSTAGRAM_SESSION_ID=
            SERA_YOUTUBE_PLAYER_CLIENTS=
            SERA_YOUTUBE_POT_PROVIDER_URL=
            SERA_REDDIT_CLIENT_ID=
            SERA_REDDIT_CLIENT_SECRET=
            """.trimIndent(),
        )
        assertNull(parsed.instagramSessionId)
        assertNull(parsed.youtubePlayerClients)
        assertNull(parsed.youtubePotProviderUrl)
        assertNull(parsed.redditClientId)
        assertNull(parsed.redditClientSecret)
        assertTrue(parsed.importedFields.isEmpty())

        assertEquals("http://10.0.2.2:4000", NodeSettings.normalizeBaseUrl("10.0.2.2:4000/api/"))
        assertEquals("http://127.0.0.1:4416/api", NodeSettings.normalizePotProviderUrl("http://127.0.0.1:4416/api/"))
        assertEquals("http://10.0.2.2:4416/v1", NodeSettings.normalizePotProviderUrl("10.0.2.2:4416/v1/"))
    }

    @Test
    fun updatersBlockCrossOriginProxyAuthLeakAndCleartextDirectUrls() {
        val apkTargets = AppSelfUpdater.resolveDownloadTargets(
            apiBaseUrl = "https://api.example.com",
            proxyPath = "https://evil.attacker.com/steal",
            directUrl = "http://evil.attacker.com/app.apk",
        )
        assertTrue(apkTargets.isEmpty())

        val traversalApkTargets = AppSelfUpdater.resolveDownloadTargets(
            apiBaseUrl = "https://api.example.com",
            proxyPath = "//evil.attacker.com/steal",
            directUrl = "https://github.com/org/repo/releases/download/v1/app.apk",
        )
        assertEquals(1, traversalApkTargets.size)
        assertFalse(traversalApkTargets.single().sendAuthHeader)

        val dotDotTargets = AppSelfUpdater.resolveDownloadTargets(
            apiBaseUrl = "https://api.example.com",
            proxyPath = "/internal/../admin/secret",
            directUrl = null,
        )
        assertTrue(dotDotTargets.isEmpty())

        val ytdlpTargets = YtdlpArchiveUpdater.resolveTargets(
            apiBaseUrl = "https://api.example.com",
            proxyPath = "https://evil.attacker.com/steal",
            directUrl = "http://evil.attacker.com/yt-dlp",
        )
        assertTrue(ytdlpTargets.isEmpty())

        val ytdlpRelativeTargets = YtdlpArchiveUpdater.resolveTargets(
            apiBaseUrl = "https://api.example.com",
            proxyPath = "/internal/extraction/updates/ytdlp",
            directUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp",
        )
        assertEquals(2, ytdlpRelativeTargets.size)
        assertTrue(ytdlpRelativeTargets[0].sendAuthHeader)
        assertFalse(ytdlpRelativeTargets[1].sendAuthHeader)
    }

    @Test
    fun apiClientTestConnectionAndTagVersionCodeParsingAndAuthErrorPreservation() = runTest {
        val baseUrl = server.url("/").toString().trimEnd('/')
        val api = SeraNodeApiClient(OkHttpClient())

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """
                    {
                      "manifestHash": "hash-ok-1",
                      "generatedAt": "2026-11-24T00:00:00Z",
                      "ytdlp": {
                        "version": "2026.10.26",
                        "assetName": "yt-dlp",
                        "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp",
                        "proxyPath": "/internal/extraction/updates/ytdlp"
                      }
                    }
                    """.trimIndent(),
                ),
        )
        val ok = api.testConnection(baseUrl, "tok_valid")
        assertTrue(ok is ConnectionTestResult.Success)
        assertEquals("hash-ok-1", (ok as ConnectionTestResult.Success).manifestHash)

        server.enqueue(MockResponse().setResponseCode(401))
        val rejected = api.testConnection(baseUrl, "tok_bad")
        assertTrue(rejected is ConnectionTestResult.AuthRejected)
        assertEquals(401, (rejected as ConnectionTestResult.AuthRejected).statusCode)

        val badToken = api.testConnection(baseUrl, "bad\r\ntoken")
        assertTrue(badToken is ConnectionTestResult.Failure)

        assertEquals(42, SeraNodeApiClient.parseVersionCodeFromTag("android-node-v1.8.0+42"))
        assertEquals(15, SeraNodeApiClient.parseVersionCodeFromTag("build-15"))
        assertEquals(13, SeraNodeApiClient.parseVersionCodeFromTag("13"))
        assertNull(SeraNodeApiClient.parseVersionCodeFromTag("v1.8.3"))
        assertNull(SeraNodeApiClient.parseVersionCodeFromTag("android-node-v1.8.3"))

        val tracker = NodeRuntimeTracker()
        tracker.update {
            it.copy(
                serviceState = NodeServiceState.AUTH_ERROR,
                isServiceRunning = true,
                authFailureCount = 3,
                lastError = "Authentication rejected (401)",
                startedAtMs = 1234L,
                lastPollSuccessAtMs = 5678L,
                activeTasks = listOf(ActiveTaskInfo("t1", "job", "youtube", "Working", 10.0)),
            )
        }
        tracker.resetStopped(preserveAuthError = true)
        val preserved = tracker.snapshot.value
        assertEquals(NodeServiceState.AUTH_ERROR, preserved.serviceState)
        assertFalse(preserved.isServiceRunning)
        assertEquals(3, preserved.authFailureCount)
        assertEquals("Authentication rejected (401)", preserved.lastError)
        assertNull(preserved.startedAtMs)
        assertTrue(preserved.activeTasks.isEmpty())
        assertEquals(5678L, preserved.lastPollSuccessAtMs)

        tracker.resetStopped(preserveAuthError = false)
        val stopped = tracker.snapshot.value
        assertEquals(NodeServiceState.STOPPED, stopped.serviceState)
        assertFalse(stopped.isServiceRunning)
        assertNull(stopped.lastError)
        assertEquals(0, stopped.authFailureCount)
    }

    @Test
    fun doesNotCacheTransientEmptyKeystoreDecryptionFailures() {
        val cache = mutableMapOf<String, String>()
        var attempts = 0
        val ciphertext = "enc:v1:simulated_ciphertext"

        val first = NodePreferences.resolveDecryptedSecret(ciphertext, cache) {
            attempts += 1
            ""
        }
        assertEquals("", first)
        assertTrue(cache.isEmpty())

        val second = NodePreferences.resolveDecryptedSecret(ciphertext, cache) {
            attempts += 1
            "  tok_recovered_123  "
        }
        assertEquals("tok_recovered_123", second)
        assertEquals("tok_recovered_123", cache[ciphertext])

        val third = NodePreferences.resolveDecryptedSecret(ciphertext, cache) {
            attempts += 1
            "should_not_be_called"
        }
        assertEquals("tok_recovered_123", third)
        assertEquals(2, attempts)
    }

    @Test
    fun validatesNat64EmbeddedIpv4AddressesAndFormatsConnectionDiagnostics() = runTest {
        assertTrue(isPublicAddress("64:ff9b::93.184.216.34"))
        assertTrue(isPublicAddress("64:ff9b::5db8:d822"))
        assertFalse(isPublicAddress("64:ff9b::127.0.0.1"))
        assertFalse(isPublicAddress("64:ff9b::7f00:1"))
        assertFalse(isPublicAddress("64:ff9b::10.0.0.1"))
        assertFalse(isPublicAddress("64:ff9b::169.254.169.254"))
        assertFalse(isPublicAddress("64:ff9b::192.168.1.1"))
        assertFalse(isPublicAddress("64:ff9b:1::93.184.216.34"))

        val baseUrl = server.url("/").toString().trimEnd('/')
        val api = SeraNodeApiClient(OkHttpClient())

        server.enqueue(MockResponse().setResponseCode(403))
        val forbidden = api.testConnection(baseUrl, "tok_mismatch", "phone-backup")
        assertTrue(forbidden is ConnectionTestResult.AuthRejected)
        assertEquals(403, (forbidden as ConnectionTestResult.AuthRejected).statusCode)
        assertTrue(forbidden.message.contains("Node ID"))

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("X-Sera-Node-Id", "laptop")
                .setBody("{}"),
        )
        val nodeIdMismatch = api.testConnection(baseUrl, "tok_laptop", "phone-backup")
        assertTrue(nodeIdMismatch is ConnectionTestResult.AuthRejected)
        assertEquals(403, (nodeIdMismatch as ConnectionTestResult.AuthRejected).statusCode)
        assertTrue(nodeIdMismatch.message.contains("phone-backup"))
        assertTrue(nodeIdMismatch.message.contains("laptop"))

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("X-Sera-Node-Id", "phone-backup")
                .addHeader("X-Sera-Manifest-Hash", "hash-match")
                .setBody("{}"),
        )
        val nodeIdMatch = api.testConnection(baseUrl, "tok_phone", "phone-backup")
        assertTrue(nodeIdMatch is ConnectionTestResult.Success)
        assertEquals("hash-match", (nodeIdMatch as ConnectionTestResult.Success).manifestHash)

        server.enqueue(MockResponse().setResponseCode(502))
        val badGateway = api.testConnection(baseUrl, "tok_valid")
        assertTrue(badGateway is ConnectionTestResult.Failure)
        assertTrue((badGateway as ConnectionTestResult.Failure).message.contains("502"))

        val target = "https://130-61-188-184.sslip.io/internal/extraction/updates/manifest".toHttpUrl()
        assertTrue(
            SeraNodeApiClient.formatConnectionError(UnknownHostException("no host"), target)
                .contains("DNS lookup failed"),
        )
        assertTrue(
            SeraNodeApiClient.formatConnectionError(SSLHandshakeException("handshake failed"), target)
                .contains("TLS/SSL error"),
        )
        assertTrue(
            SeraNodeApiClient.formatConnectionError(SocketTimeoutException("timeout"), target)
                .contains("timed out"),
        )
        assertTrue(
            SeraNodeApiClient.formatConnectionError(ConnectException("refused"), target)
                .contains("Could not connect"),
        )
        assertTrue(
            SeraNodeApiClient.formatConnectionError(
                IOException("CLEARTEXT communication to example.com not permitted"),
                target,
            ).contains("Cleartext HTTP blocked"),
        )
    }
}
