package dev.sera.toolkit.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GitHubUpdateCheckerTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test(timeout = 15_000)
    fun ignoresNonAndroidPrefixTagsAndDraftsAndFindsNewerAndroidRelease() = runBlocking {
        val body = """
            [
              {
                "tag_name": "android-node-v2.0.0+99",
                "html_url": "https://github.com/seraphicidal/sera-toolkit/releases/tag/android-node-v2.0.0+99",
                "draft": false
              },
              {
                "tag_name": "android-v2.5.0+50",
                "html_url": "https://github.com/seraphicidal/sera-toolkit/releases/tag/android-v2.5.0+50",
                "draft": true
              },
              {
                "tag_name": "android-v1.9.0+2",
                "html_url": "https://github.com/seraphicidal/sera-toolkit/releases/tag/android-v1.9.0+2",
                "draft": false
              },
              {
                "tag_name": "1.9.5",
                "html_url": "https://github.com/seraphicidal/sera-toolkit/releases/tag/1.9.5",
                "draft": false
              }
            ]
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

        val checker = GitHubUpdateChecker(
            httpClient = OkHttpClient(),
            releasesUrl = server.url("/releases").toString(),
        )
        val result = checker.checkForUpdates(currentVersionName = "1.8.0", currentVersionCode = 1)
        assertTrue(result is UpdateCheckResult.UpdateAvailable)
        val available = result as UpdateCheckResult.UpdateAvailable
        assertEquals("android-v1.9.0+2", available.tagName)
        assertEquals("1.9.0", available.versionName)
        assertEquals(2, available.versionCode)
    }

    @Test(timeout = 15_000)
    fun returnsUpToDateWhenCurrentMatchesLatest() = runBlocking {
        val body = """
            [
              {
                "tag_name": "android-v1.8.0+1",
                "html_url": "https://github.com/seraphicidal/sera-toolkit/releases/tag/android-v1.8.0+1",
                "draft": false
              }
            ]
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

        val checker = GitHubUpdateChecker(
            httpClient = OkHttpClient(),
            releasesUrl = server.url("/releases").toString(),
        )
        val result = checker.checkForUpdates(currentVersionName = "1.8.0", currentVersionCode = 1)
        assertTrue(result is UpdateCheckResult.UpToDate)
    }
}
