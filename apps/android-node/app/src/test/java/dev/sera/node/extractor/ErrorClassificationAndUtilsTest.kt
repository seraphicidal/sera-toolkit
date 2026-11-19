package dev.sera.node.extractor

import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.RemoteTrimRange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ErrorClassificationAndUtilsTest {
    @Test
    fun classifiesYtdlpStderrAcrossAllFailureBuckets() {
        val cases = listOf(
            "ERROR: [youtube] abc: Private video. Sign in if you have been granted access." to SeraErrorCode.PRIVATE_CONTENT,
            "ERROR: [youtube] abc: Sign in to confirm your age." to SeraErrorCode.AGE_RESTRICTED,
            "ERROR: Protected by FairPlay DRM" to SeraErrorCode.DRM_PROTECTED,
            "ERROR: This content is behind a paywall; subscription required" to SeraErrorCode.PROVIDER_AUTH_REQUIRED,
            "ERROR: [youtube] Xz3UMZvhgeY: Sign in to confirm you\u2019re not a bot." to SeraErrorCode.SOURCE_BLOCKED,
            "ERROR: [vimeo] 123: The web client only works when logged-in. Use --cookies" to SeraErrorCode.LOGIN_REQUIRED,
            "ERROR: [youtube] abc: The uploader has not made this video available in your country" to SeraErrorCode.GEO_RESTRICTED,
            "ERROR: [youtube] abc: This live event will begin in 3 hours." to SeraErrorCode.LIVE_IN_PROGRESS,
            "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests" to SeraErrorCode.RATE_LIMITED,
            "ERROR: Unsupported URL: https://example.com/page" to SeraErrorCode.UNSUPPORTED_SOURCE,
            "ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader" to SeraErrorCode.MEDIA_UNAVAILABLE,
            "ERROR: unable to download video data: HTTP Error 404: Not Found" to SeraErrorCode.MEDIA_UNAVAILABLE,
            "ERROR: [generic] abc: No video formats found" to SeraErrorCode.MEDIA_UNAVAILABLE,
            "ERROR: File is larger than max-filesize (900MB)" to SeraErrorCode.TOO_LARGE,
            "ERROR: Unable to download webpage: timed out" to SeraErrorCode.NETWORK_ERROR,
            "ERROR: [tiktok] Unable to extract webpage video data" to SeraErrorCode.PROVIDER_UNAVAILABLE,
        )
        for ((stderr, expected) in cases) {
            assertEquals(stderr, expected, classifyYtdlpFailure(stderr, 1).code)
        }
    }

    @Test
    fun classifiesFailuresAndEgressPredicates() {
        assertEquals(FailureClass.DATACENTER_BLOCKED, classifyFailure(seraError(SeraErrorCode.SOURCE_BLOCKED)))
        assertEquals(
            FailureClass.BOT_DETECTION,
            classifyFailure(seraError(SeraErrorCode.LOGIN_REQUIRED, detail = "Sign in to confirm you're not a bot")),
        )
        assertEquals(
            FailureClass.PO_TOKEN_REQUIRED,
            classifyFailure(seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = "Missing a GVS PO Token")),
        )
        assertEquals(
            FailureClass.FORMAT_UNAVAILABLE,
            classifyFailure(seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "Requested format is not available")),
        )
        assertEquals(
            FailureClass.STREAM_403,
            classifyFailure(seraError(SeraErrorCode.NETWORK_ERROR, detail = "unable to download video data: HTTP Error 403")),
        )
        assertEquals(
            FailureClass.PRIVATE_CONTENT,
            classifyFailure(seraError(SeraErrorCode.DRM_PROTECTED, detail = "Sign in to confirm you're not a bot")),
        )

        assertTrue(isEgressProblem(FailureClass.DATACENTER_BLOCKED))
        assertTrue(isEgressProblem(FailureClass.BOT_DETECTION))
        assertTrue(isEgressProblem(FailureClass.PO_TOKEN_REQUIRED))
        assertFalse(isEgressProblem(FailureClass.STREAM_403))
        assertTrue(isDefinitive(FailureClass.PRIVATE_CONTENT))
        assertFalse(isDefinitive(FailureClass.DATACENTER_BLOCKED))
    }

    @Test
    fun sniffsContainersTextImpostersAndExecutables() {
        assertEquals("jpg", sniffContainer(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte())))
        assertEquals("mp4", sniffContainer(byteArrayOf(0, 0, 0, 0x20) + "ftypisom".toByteArray()))
        assertEquals("mov", sniffContainer(byteArrayOf(0, 0, 0, 0x14) + "ftypqt  ".toByteArray()))
        assertEquals("webm", sniffContainer(byteArrayOf(0x1a, 0x45, 0xdf.toByte(), 0xa3.toByte())))
        assertEquals("html", sniffTextImposter("  <!DOCTYPE html><html>".toByteArray()))
        assertEquals("json", sniffTextImposter(byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) + "{\"err\":1}".toByteArray()))
        assertTrue(isExecutableHeader(byteArrayOf(0x7f, 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte())))
        assertTrue(isExecutableHeader(byteArrayOf('M'.code.toByte(), 'Z'.code.toByte(), 0x90.toByte(), 0)))
        assertFalse(contradicts("m4a", "mp4"))
        assertTrue(contradicts("jpg", "webp"))
    }

    @Test
    fun sanitizesFilenamesAndTrimsAndSubtitles() {
        assertEquals("media", sanitizeStem("CON"))
        assertEquals("media", sanitizeStem("nul.tar.gz"))
        assertEquals("etc passwd", sanitizeStem("../../etc/passwd"))
        assertEquals("Creator - Post title (2).jpg", mediaFilename("Creator", "Post title", "jpg", 2))
        assertEquals("-trim-0m15s-1m30s", trimSuffix(RemoteTrimRange(15.0, 90.0)))
        assertEquals("video.en.srt", subtitleName("video.srt", "en-orig"))

        val taken = mutableSetOf<String>()
        assertEquals("a.mp4", dedupeFilename("a.mp4", taken))
        assertEquals("A (2).mp4", dedupeFilename("A.mp4", taken))
        assertThrows(IllegalArgumentException::class.java) {
            assertSafeFilename("../escape.mp4")
        }
    }

    @Test
    fun parsesYtdlpProgressAndConfinesHttpSelectors() {
        val updates = mutableListOf<YtdlpProgress>()
        val parser = YtdlpProgressParser(expectedTotalBytes = null, hasMergeContainer = true) {
            updates.add(it)
        }
        parser.feedLine("SERA-PROGRESS\u0001downloading\u0001500\u00011000\u0001NA\u0001100.0\u00015\u0001137")
        parser.feedLine("SERA-PROGRESS\u0001downloading\u0001250\u0001500\u0001NA\u000150.0\u00015\u0001140")
        parser.feedLine("SERA-POSTPROCESS\u0001started\u0001Merger")

        assertEquals(3, updates.size)
        assertEquals(50.0, updates[1].percent, 0.01)
        assertEquals(750L, updates[1].bytesDownloaded)
        assertEquals(1500L, updates[1].bytesTotal)
        assertEquals("Merger", updates[2].postprocessor)

        val confined = confineToHttp("137+140/best")
        assertTrue(confined.contains("137[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']+140[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']"))
        assertTrue(confined.contains("/best[protocol~="))
    }

    @Test
    fun buildsFfmpegConvertArgsForCopyAndTranscode() {
        val processor = FfmpegMediaProcessor(
            object : MediaCommandExecutor {
                override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions) = throw UnsupportedOperationException()
                override suspend fun download(options: YtdlpDownloadOptions) = Unit
                override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
                override suspend fun probeMedia(path: File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
                override suspend fun keyframeAtOrBefore(path: File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
                override suspend fun runFfmpeg(args: List<String>, workDir: File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            },
        )
        val mp4Source = FfprobeResult(
            video = FfprobeVideoStream("h264", 1920, 1080),
            audio = FfprobeAudioStream("aac", 2, 44100, 128000L),
        )
        val copyArgs = processor.buildConvertArgs(
            File("in.bin"),
            File("out.mp4"),
            ConversionSpec.Video("mp4"),
            mp4Source,
        )
        assertTrue(copyArgs.contains("copy"))
        assertTrue(copyArgs.contains("+faststart"))
        assertFalse(copyArgs.contains("libx264"))

        val gifSource = FfprobeResult(video = FfprobeVideoStream("gif", 480, 480))
        val transcodeArgs = processor.buildConvertArgs(
            File("in.gif"),
            File("out.mp4"),
            ConversionSpec.Video("mp4"),
            gifSource,
        )
        assertTrue(transcodeArgs.contains("libx264"))
        assertTrue(transcodeArgs.contains("-an"))
    }

    @Test
    fun buildsYtdlpArgsWithRemoteComponentsDefaultAndOverride() {
        val defaultArgs = YtdlpCommandBuilder.buildDumpInfoArgs(
            url = "https://www.youtube.com/watch?v=abc",
            options = YtdlpProbeOptions(),
            runtimePaths = YtdlpRuntimePaths(ejsCacheDir = File("/tmp/ejs")),
        )
        val defaultIdx = defaultArgs.indexOf("--remote-components")
        assertTrue(defaultIdx >= 0)
        assertEquals("ejs:github", defaultArgs[defaultIdx + 1])

        val multiArgs = YtdlpCommandBuilder.buildDumpInfoArgs(
            url = "https://www.youtube.com/watch?v=abc",
            options = YtdlpProbeOptions(remoteComponents = listOf("ejs:github", "ejs:npm")),
            runtimePaths = YtdlpRuntimePaths(ejsCacheDir = File("/tmp/ejs")),
        )
        val multiIdx = multiArgs.indexOf("--remote-components")
        assertTrue(multiIdx >= 0)
        assertEquals("ejs:github,ejs:npm", multiArgs[multiIdx + 1])

        val suppressedArgs = YtdlpCommandBuilder.buildDumpInfoArgs(
            url = "https://www.youtube.com/watch?v=abc",
            options = YtdlpProbeOptions(
                remoteComponents = listOf("ejs:github"),
                extraArgs = listOf("--no-remote-components"),
            ),
            runtimePaths = YtdlpRuntimePaths(ejsCacheDir = File("/tmp/ejs")),
        )
        assertFalse(suppressedArgs.contains("--remote-components"))
        assertTrue(suppressedArgs.contains("--no-remote-components"))
    }
}
