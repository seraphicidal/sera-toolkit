package dev.sera.toolkit.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class ResumableDownloaderTest {
    private lateinit var server: MockWebServer
    private lateinit var downloader: ResumableDownloader
    private lateinit var tempFile: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        downloader = ResumableDownloader(
            httpClient = OkHttpClient.Builder().followRedirects(false).build(),
            sleeper = {},
            maxResumeAttempts = 3,
        )
        tempFile = File.createTempFile("sera-resume-test-", ".bin")
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempFile.delete()
    }

    @Test(timeout = 15_000)
    fun resumesDroppedTransferWithRangeAndIfRange() = runBlocking {
        val fullPayload = ByteArray(1024) { idx -> (idx % 251).toByte() }
        val firstPart = fullPayload.copyOfRange(0, 400)
        val secondPart = fullPayload.copyOfRange(400, 1024)
        val etag = "\"400-abcdef\""

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("ETag", etag)
                .addHeader("Accept-Ranges", "bytes")
                .setBody(Buffer().write(firstPart))
                .setHeader("Content-Length", fullPayload.size),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(206)
                .addHeader("ETag", etag)
                .addHeader("Content-Range", "bytes 400-1023/1024")
                .setBody(Buffer().write(secondPart)),
        )

        val written = RandomAccessFile(tempFile, "rw").use { raf ->
            downloader.downloadToSink(
                url = server.url("/api/jobs/0123456789abcdef/download").toString(),
                sink = FileChannelSink(raf.channel),
                expectedSizeBytes = fullPayload.size.toLong(),
            )
        }

        assertEquals(fullPayload.size.toLong(), written)
        assertArrayEquals(fullPayload, tempFile.readBytes())

        val req1 = server.takeRequest()
        assertEquals(null, req1.getHeader("Range"))
        val req2 = server.takeRequest()
        assertEquals("bytes=400-", req2.getHeader("Range"))
        assertEquals(etag, req2.getHeader("If-Range"))
    }

    @Test(timeout = 15_000)
    fun restartsFromZeroWhenIfRangeMismatchReturns200() = runBlocking {
        val oldFirstPart = ByteArray(300) { 0x11 }
        val newPayload = ByteArray(600) { idx -> (idx % 199).toByte() }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("ETag", "\"old-etag\"")
                .setBody(Buffer().write(oldFirstPart))
                .setHeader("Content-Length", 900),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("ETag", "\"new-etag\"")
                .setBody(Buffer().write(newPayload)),
        )

        val written = RandomAccessFile(tempFile, "rw").use { raf ->
            downloader.downloadToSink(
                url = server.url("/api/jobs/0123456789abcdef/download").toString(),
                sink = FileChannelSink(raf.channel),
            )
        }

        assertEquals(newPayload.size.toLong(), written)
        assertArrayEquals(newPayload, tempFile.readBytes())
        server.takeRequest()
        val req2 = server.takeRequest()
        assertEquals("bytes=300-", req2.getHeader("Range"))
        assertEquals("\"old-etag\"", req2.getHeader("If-Range"))
    }

    @Test(timeout = 15_000)
    fun throwsDownloadExpiredExceptionOn404() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))

        var caught: Throwable? = null
        try {
            RandomAccessFile(tempFile, "rw").use { raf ->
                downloader.downloadToSink(
                    url = server.url("/api/jobs/0123456789abcdef/download").toString(),
                    sink = FileChannelSink(raf.channel),
                )
            }
        } catch (t: Throwable) {
            caught = t
        }
        assertEquals(DownloadExpiredException::class.java, caught?.javaClass)
    }
}
