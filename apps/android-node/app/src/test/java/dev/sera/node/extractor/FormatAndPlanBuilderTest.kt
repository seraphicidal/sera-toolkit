package dev.sera.node.extractor

import dev.sera.node.model.FetchPlan
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.SeraJson
import dev.sera.node.model.YoutubeHotConfig
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatAndPlanBuilderTest {
    private val sampleYoutubeJson = """
        {
          "id": "dQw4w9WgXcQ",
          "_type": "video",
          "title": "A Video Title",
          "description": "Some description",
          "uploader": "Some Channel",
          "uploader_url": "https://www.youtube.com/@some",
          "webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "duration": 212,
          "timestamp": 1700000000,
          "thumbnail": "https://i.ytimg.com/vi/x/hq.jpg",
          "thumbnails": [
            { "url": "https://i.ytimg.com/vi/x/small.jpg", "width": 120, "preference": 0 },
            { "url": "https://i.ytimg.com/vi/x/medium.jpg", "width": 640, "preference": 0 },
            { "url": "https://i.ytimg.com/vi/x/max.jpg", "width": 1920, "preference": 0 }
          ],
          "view_count": 1234,
          "subtitles": {
            "en": [{ "ext": "vtt", "name": "English" }],
            "live_chat": [{ "ext": "json" }]
          },
          "automatic_captions": {
            "de-orig": [{ "ext": "vtt" }]
          },
          "formats": [
            { "format_id": "sb0", "ext": "mhtml", "protocol": "mhtml", "vcodec": "none", "acodec": "none" },
            { "format_id": "140", "ext": "m4a", "protocol": "https", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 129, "filesize": 3400000 },
            { "format_id": "140-drc", "ext": "m4a", "protocol": "https", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 129 },
            { "format_id": "251", "ext": "webm", "protocol": "https", "acodec": "opus", "vcodec": "none", "abr": 141, "filesize": 3700000 },
            { "format_id": "137", "ext": "mp4", "protocol": "https", "vcodec": "avc1.640028", "acodec": "none", "width": 1920, "height": 1080, "fps": 30, "tbr": 4000, "filesize": 106000000 },
            { "format_id": "136", "ext": "mp4", "protocol": "https", "vcodec": "avc1.4d401f", "acodec": "none", "width": 1280, "height": 720, "fps": 30, "tbr": 2000, "filesize": 53000000 },
            { "format_id": "616", "ext": "mp4", "protocol": "https", "vcodec": "vp09.00.40.08", "acodec": "none", "width": 1920, "height": 1080, "format_note": "Premium", "tbr": 4200 }
          ]
        }
    """.trimIndent()

    @Test
    fun normalizesYoutubePlansAndSerializesResolvedMediaSchemaCleanly() {
        val parsed = parseYtdlpInfo(sampleYoutubeJson)
        val executor = object : MediaCommandExecutor {
            override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions) = parsed
            override suspend fun download(options: YtdlpDownloadOptions) = Unit
            override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
            override suspend fun probeMedia(path: java.io.File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            override suspend fun keyframeAtOrBefore(path: java.io.File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
            override suspend fun runFfmpeg(args: List<String>, workDir: java.io.File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
        }
        val extractor = YoutubeExtractor(executor)
        val context = ExtractionExecutionContext(
            runtimeConfig = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
            hotConfig = ProviderHotConfig(youtube = YoutubeHotConfig(playerClients = listOf("tv", "default"))),
        )
        val media = withThumbnailOption(
            extractor.toResolvedMedia(parsed.info, "https://www.youtube.com/watch?v=dQw4w9WgXcQ".toHttpUrl(), context),
        )

        assertEquals("youtube", media.provider)
        assertEquals("single", media.type)
        assertEquals("A Video Title", media.title)
        assertEquals("Some Channel", media.author)
        assertEquals("https://i.ytimg.com/vi/x/medium.jpg", media.thumbnailUrl)
        assertEquals(212.0, media.duration!!, 0.001)
        assertEquals("2023-11-14T22:13:20.000Z", media.createdAt)

        val item = media.items.single()
        val videoPlans = item.plans.filter { it.kind == "video" }
        assertEquals(listOf("1080p", "720p", "1080p (MOV)"), videoPlans.map { it.label })
        val best = videoPlans.first()
        assertEquals(FetchPlan.Ytdlp(selector = "137+140", merge = "mp4", extractorArgs = listOf("youtube:player_client=tv,default")), best.fetch)
        assertEquals(106_000_000L + 3_400_000L, best.filesizeBytes)

        val audioPlans = item.plans.filter { it.kind == "audio" }
        assertEquals(listOf("MP3", "M4A", "Opus", "WAV"), audioPlans.map { it.label })
        val m4a = audioPlans.first { it.container == "m4a" }
        assertFalse(m4a.requiresConversion)

        val thumbPlan = item.plans.firstOrNull { it.kind == "image" }
        assertNotNull(thumbPlan)
        assertEquals("Thumbnail", thumbPlan?.label)
        assertEquals(FetchPlan.Direct("https://i.ytimg.com/vi/x/medium.jpg"), thumbPlan?.fetch)
        assertTrue(thumbPlan?.recommended == true)

        assertEquals(listOf("en", "de-orig"), item.subtitles?.map { it.lang })
        assertEquals(false, item.subtitles?.get(0)?.auto)
        assertEquals(true, item.subtitles?.get(1)?.auto)

        val serialized = SeraJson.encodeToString(ResolvedMedia.serializer(), media)
        val jsonObj = SeraJson.parseToJsonElement(serialized).jsonObject
        assertEquals("youtube", jsonObj["provider"]?.jsonPrimitive?.content)
        val plansJson = jsonObj["items"]!!.jsonArray[0].jsonObject["plans"]!!.jsonArray
        assertEquals("ytdlp", plansJson[0].jsonObject["fetch"]!!.jsonObject["via"]?.jsonPrimitive?.content)
        assertEquals("direct", plansJson.last().jsonObject["fetch"]!!.jsonObject["via"]?.jsonPrimitive?.content)
    }

    @Test
    fun detectsDrmAndHandlesNumericStringPlaceholders() {
        assertNull(YtdlpFormat().filesize.asLong())
        assertEquals(42.5, kotlinx.serialization.json.JsonPrimitive("42.5").asNum()!!, 0.001)
        assertNull(kotlinx.serialization.json.JsonPrimitive("NA").asStr())
        assertNull(kotlinx.serialization.json.JsonPrimitive("none").asStr())
        assertNull(kotlinx.serialization.json.JsonPrimitive("null").asStr())

        val drmJson = """{ "id": "1", "drm": "Widevine", "formats": [] }"""
        val ex = org.junit.Assert.assertThrows(SeraException::class.java) {
            parseYtdlpInfo(drmJson)
        }
        assertEquals(SeraErrorCode.DRM_PROTECTED, ex.code)
    }

    @Test
    fun buildsSameHeightFallbackAndLowerQualityAlternatives() {
        val media = parseYtdlpInfo(sampleYoutubeJson).info
        val formats = toUsableFormats(entryFormats(media))
        val plans = buildVideoPlans(formats, 212.0)
        val mp4Plan = plans.first()
        val selector = sameHeightFallbackSelector(mp4Plan)
        assertNotNull(selector)
        assertTrue(selector!!.contains("bestvideo[height=1080][protocol^=http][vcodec^=avc]+140"))
        assertTrue(selector.contains("best[height=1080]"))

        val item = YoutubeExtractor(
            object : MediaCommandExecutor {
                override suspend fun dumpInfo(url: String, options: YtdlpProbeOptions) = throw UnsupportedOperationException()
                override suspend fun download(options: YtdlpDownloadOptions) = Unit
                override suspend fun downloadSubtitles(options: YtdlpSubtitleOptions) = throw UnsupportedOperationException()
                override suspend fun probeMedia(path: java.io.File, timeoutMs: Long, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
                override suspend fun keyframeAtOrBefore(path: java.io.File, seconds: Double, timeoutMs: Long, isCancelled: () -> Boolean) = null
                override suspend fun runFfmpeg(args: List<String>, workDir: java.io.File, timeoutMs: Long, onStdoutLine: ((String) -> Unit)?, isCancelled: () -> Boolean) = throw UnsupportedOperationException()
            },
        ).toResolvedMedia(
            media,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ".toHttpUrl(),
            ExtractionExecutionContext(
                runtimeConfig = NodeRuntimeConfig(apiBaseUrl = "https://api.example.com", nodeToken = "tok"),
                hotConfig = null,
            ),
        ).items.first()

        val alts = lowerQualityAlternatives(item, mp4Plan)
        assertEquals(listOf(720), alts.map { it.height })
    }
}
