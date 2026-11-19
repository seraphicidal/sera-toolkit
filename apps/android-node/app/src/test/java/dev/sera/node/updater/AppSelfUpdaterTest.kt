package dev.sera.node.updater

import dev.sera.node.data.NodeLogStore
import dev.sera.node.model.AndroidAppUpdateInfo
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class AppSelfUpdaterTest {
    private lateinit var server: MockWebServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = Files.createTempDirectory("sera-updater-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    @Test
    fun verifiesSha256Correctly() {
        val payload = "sera-android-apk-bytes".toByteArray()
        val file = File(tempDir, "test.apk").apply { writeBytes(payload) }
        val expected = Sha256Verifier.computeHex(payload)

        assertTrue(Sha256Verifier.matches(file, expected))
        assertTrue(Sha256Verifier.matches(file, "sha256:${expected.uppercase()}"))
        assertFalse(Sha256Verifier.matches(file, "0".repeat(64)))
        assertFalse(Sha256Verifier.matches(file, "invalid-short-hash"))
        assertFalse(Sha256Verifier.matches(File(tempDir, "missing.apk"), expected))
    }

    @Test
    fun comparesVersionCodesAndSemver() {
        assertTrue(UpdateVersionComparator.isUpdateAvailable(10, "1.8.0", 11, "1.8.0"))
        assertFalse(UpdateVersionComparator.isUpdateAvailable(10, "1.8.0", 9, "1.9.0"))
        assertTrue(UpdateVersionComparator.isUpdateAvailable(10, "1.8.0", 10, "1.8.1"))
        assertTrue(UpdateVersionComparator.isUpdateAvailable(10, "v1.8.0", 10, "1.10.0"))
        assertFalse(UpdateVersionComparator.isUpdateAvailable(10, "1.8.1", 10, "1.8.1"))
    }

    @Test
    fun resolvesProxyTargetWithAuthAndDirectWithoutAuth() {
        val targets = AppSelfUpdater.resolveDownloadTargets(
            apiBaseUrl = "https://api.example.com/",
            proxyPath = "/internal/extraction/updates/apk",
            directUrl = "https://github.com/seraphicidal/sera-toolkit/releases/download/v2/app.apk",
        )
        assertEquals(2, targets.size)
        assertEquals("https://api.example.com/internal/extraction/updates/apk", targets[0].url)
        assertTrue(targets[0].sendAuthHeader)
        assertEquals("https://github.com/seraphicidal/sera-toolkit/releases/download/v2/app.apk", targets[1].url)
        assertFalse(targets[1].sendAuthHeader)
    }

    @Test
    fun downloadsFromProxyWithBearerAndVerifiesSha256() = runTest {
        val apkBytes = "fake-signed-apk-content-v2".toByteArray()
        val expectedSha = Sha256Verifier.computeHex(apkBytes)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(apkBytes)))

        val updater = AppSelfUpdater(OkHttpClient(), NodeLogStore())
        val baseUrl = server.url("/").toString().trimEnd('/')
        val info = AndroidAppUpdateInfo(
            versionCode = 2,
            versionName = "1.8.1",
            sha256 = expectedSha,
            apkUrl = server.url("/direct.apk").toString(),
            proxyPath = "/internal/extraction/updates/apk",
        )

        val outcome = updater.downloadAndVerifyApk(
            info = info,
            apiBaseUrl = baseUrl,
            authToken = "node-secret",
            updatesDir = tempDir,
        )

        assertTrue(outcome is ApkDownloadOutcome.Verified)
        val verified = outcome as ApkDownloadOutcome.Verified
        assertEquals(expectedSha, verified.sha256)
        assertEquals(apkBytes.size.toLong(), verified.sizeBytes)

        val recorded = server.takeRequest()
        assertEquals("/internal/extraction/updates/apk", recorded.path)
        assertEquals("Bearer node-secret", recorded.getHeader("Authorization"))
    }

    @Test
    fun fallsBackToDirectUrlWithoutLeakingAuthAndRejectsBadChecksum() = runTest {
        val apkBytes = "direct-apk-bytes".toByteArray()
        val expectedSha = Sha256Verifier.computeHex(apkBytes)
        server.enqueue(MockResponse().setResponseCode(502))
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(apkBytes)))

        val updater = AppSelfUpdater(OkHttpClient(), NodeLogStore())
        val baseUrl = server.url("/").toString().trimEnd('/')
        val info = AndroidAppUpdateInfo(
            versionCode = 3,
            versionName = "1.9.0",
            sha256 = expectedSha,
            apkUrl = server.url("/github/app.apk").toString(),
            proxyPath = "/internal/extraction/updates/apk",
        )

        val outcome = updater.downloadAndVerifyApk(
            info = info,
            apiBaseUrl = baseUrl,
            authToken = "node-secret",
            updatesDir = tempDir,
        )
        assertTrue(outcome is ApkDownloadOutcome.Verified)

        val proxyReq = server.takeRequest()
        assertEquals("Bearer node-secret", proxyReq.getHeader("Authorization"))
        val directReq = server.takeRequest()
        assertNull(directReq.getHeader("Authorization"))

        server.enqueue(MockResponse().setResponseCode(200).setBody("tampered-apk"))
        val badInfo = info.copy(versionCode = 4, proxyPath = "")
        val badOutcome = updater.downloadAndVerifyApk(
            info = badInfo,
            apiBaseUrl = baseUrl,
            authToken = "node-secret",
            updatesDir = tempDir,
        )
        assertTrue(badOutcome is ApkDownloadOutcome.Failed)
        assertFalse(File(tempDir, "sera-node-v4.apk").exists())
        assertFalse(File(tempDir, "sera-node-v4.apk.part").exists())
    }
}
