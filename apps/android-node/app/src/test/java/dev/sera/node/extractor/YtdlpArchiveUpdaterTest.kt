package dev.sera.node.extractor

import dev.sera.node.model.YtdlpUpdateInfo
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class YtdlpArchiveUpdaterTest {
    private lateinit var server: MockWebServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = Files.createTempDirectory("sera-ytdlp-updater-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    private fun fakeZipapp(size: Int = 120_000): ByteArray {
        val bytes = ByteArray(size)
        val header = "#!/usr/bin/env python3\n".toByteArray()
        System.arraycopy(header, 0, bytes, 0, header.size)
        bytes[header.size] = 0x50
        bytes[header.size + 1] = 0x4b
        bytes[header.size + 2] = 0x03
        bytes[header.size + 3] = 0x04
        return bytes
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun downloadsVerifiesSha256AndAtomicallyReplacesYtdlp() = runTest {
        val payload = fakeZipapp()
        val expectedSha = sha256(payload)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(payload)))

        val target = File(tempDir, "yt-dlp").apply { writeText("old-binary") }
        val marker = File(tempDir, "yt-dlp.sera-version").apply { writeText("2025.11.12\n") }
        val updater = YtdlpArchiveUpdater(OkHttpClient())

        val result = updater.updateFromManifest(
            manifest = YtdlpUpdateInfo(
                version = "2026.10.26",
                assetName = "yt-dlp",
                sha256 = expectedSha,
                url = server.url("/direct/yt-dlp").toString(),
                proxyPath = "/internal/extraction/updates/ytdlp",
            ),
            targetBinaryFile = target,
            versionMarkerFile = marker,
            currentInstalledVersion = "2025.11.12",
            authToken = "node-secret-token",
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
        )

        assertTrue(result.updated)
        assertTrue(result.sha256Verified)
        assertEquals("2026.10.26", result.currentVersion)
        assertEquals("2026.10.26", marker.readText().trim())
        assertEquals(payload.size.toLong(), target.length())

        val req = server.takeRequest()
        assertEquals("/internal/extraction/updates/ytdlp", req.path)
        assertEquals("Bearer node-secret-token", req.getHeader("Authorization"))

        val secondRun = updater.updateFromManifest(
            manifest = YtdlpUpdateInfo(
                version = "2026.10.26",
                assetName = "yt-dlp",
                sha256 = expectedSha,
                url = server.url("/direct/yt-dlp").toString(),
                proxyPath = "/internal/extraction/updates/ytdlp",
            ),
            targetBinaryFile = target,
            versionMarkerFile = marker,
            currentInstalledVersion = "2026.10.26",
            authToken = "node-secret-token",
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
        )
        assertFalse(secondRun.updated)
        assertTrue(secondRun.sha256Verified)
    }

    @Test
    fun rejectsChecksumMismatchAndPreservesExistingBinary() = runTest {
        val payload = fakeZipapp()
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(payload)))
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(payload)))

        val target = File(tempDir, "yt-dlp").apply { writeText("existing-working-ytdlp") }
        val marker = File(tempDir, "yt-dlp.sera-version")
        val updater = YtdlpArchiveUpdater(OkHttpClient())

        val result = updater.updateFromManifest(
            manifest = YtdlpUpdateInfo(
                version = "2026.10.26",
                assetName = "yt-dlp",
                sha256 = "0".repeat(64),
                url = server.url("/direct/yt-dlp").toString(),
                proxyPath = "/internal/extraction/updates/ytdlp",
            ),
            targetBinaryFile = target,
            versionMarkerFile = marker,
            currentInstalledVersion = "2025.11.12",
            authToken = "tok",
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
        )

        assertFalse(result.updated)
        assertFalse(result.sha256Verified)
        assertTrue(result.message.contains("SHA-256 mismatch"))
        assertEquals("existing-working-ytdlp", target.readText())
    }

    @Test
    fun nullManifestSha256UsesTrustedProxyHeaderAndRejectsUnpinnedDirect() = runTest {
        val payload = fakeZipapp()
        val expectedSha = sha256(payload)
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("X-Sera-Sha256", expectedSha)
                .setBody(Buffer().write(payload)),
        )

        val target = File(tempDir, "yt-dlp").apply { writeText("old") }
        val marker = File(tempDir, "yt-dlp.sera-version")
        val updater = YtdlpArchiveUpdater(OkHttpClient())

        val verified = updater.updateFromManifest(
            manifest = YtdlpUpdateInfo(
                version = "2026.10.26",
                assetName = "yt-dlp",
                sha256 = null,
                url = server.url("/direct/yt-dlp").toString(),
                proxyPath = "/internal/extraction/updates/ytdlp",
            ),
            targetBinaryFile = target,
            versionMarkerFile = marker,
            currentInstalledVersion = "2025.11.12",
            authToken = "node-secret-token",
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
        )
        assertTrue(verified.updated)
        assertTrue(verified.sha256Verified)
        assertEquals(payload.size.toLong(), target.length())
        server.takeRequest()

        server.enqueue(MockResponse().setResponseCode(500))
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(payload)))

        val unpinnedTarget = File(tempDir, "yt-dlp-unpinned").apply { writeText("keep-me") }
        val unpinnedMarker = File(tempDir, "yt-dlp-unpinned.sera-version")
        val failed = updater.updateFromManifest(
            manifest = YtdlpUpdateInfo(
                version = "2026.10.26",
                assetName = "yt-dlp",
                sha256 = null,
                url = server.url("/direct/yt-dlp").toString(),
                proxyPath = "/internal/extraction/updates/ytdlp",
            ),
            targetBinaryFile = unpinnedTarget,
            versionMarkerFile = unpinnedMarker,
            currentInstalledVersion = "2025.11.12",
            authToken = "node-secret-token",
            apiBaseUrl = server.url("/").toString().trimEnd('/'),
        )
        assertFalse(failed.updated)
        assertFalse(failed.sha256Verified)
        assertEquals("keep-me", unpinnedTarget.readText())
        assertEquals("/internal/extraction/updates/ytdlp", server.takeRequest().path)
        assertEquals(1, server.requestCount - 1)
    }
}
