package dev.sera.node.extractor

import dev.sera.node.model.FetchPlan
import dev.sera.node.model.SeraJson
import dev.sera.node.model.planKey
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlAndInstagramParserTest {
    @Test
    fun normalizesYoutubeUrlsAcrossAllForms() {
        assertEquals(
            "https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ",
            normalizeUrl(normalizeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc&list=PL1".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/watch?v=shortId123",
            normalizeUrl(normalizeYoutubeUrl("https://www.youtube.com/shorts/shortId123/?feature=share".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/watch?v=liveId123",
            normalizeUrl(normalizeYoutubeUrl("https://m.youtube.com/live/liveId123".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/watch?v=embedId1",
            normalizeUrl(normalizeYoutubeUrl("https://www.youtube-nocookie.com/embed/embedId1?utm_source=x".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/watch?v=oldId123",
            normalizeUrl(normalizeYoutubeUrl("https://youtube.com/v/oldId123".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/watch?v=musicId1",
            normalizeUrl(normalizeYoutubeUrl("https://music.youtube.com/watch?v=musicId1&si=track".toHttpUrl())).toString(),
        )
        assertEquals(
            "https://www.youtube.com/playlist?list=PL999",
            normalizeUrl(normalizeYoutubeUrl("https://youtube.com/playlist?list=PL999&si=123".toHttpUrl())).toString(),
        )
    }

    @Test
    fun parsesAndValidatesUserUrls() {
        assertEquals(
            "https://youtube.com/watch?v=abc",
            parseUserUrl("youtube.com/watch?v=abc").url.toString(),
        )
        assertThrows(SeraException::class.java) {
            parseUserUrl("ftp://example.com/file.mp4")
        }
        assertThrows(SeraException::class.java) {
            parseUserUrl("https://user:pass@example.com/v.mp4")
        }
        assertThrows(SeraException::class.java) {
            parseUserUrl("http://127.0.0.1/secret")
        }
        assertThrows(SeraException::class.java) {
            parseUserUrl("http://169.254.169.254/latest/meta-data")
        }
        assertThrows(SeraException::class.java) {
            parseUserUrl("http://[::1]/x.mp4")
        }
        assertThrows(SeraException::class.java) {
            parseUserUrl("https://example.com:8443/x.mp4")
        }
    }

    @Test
    fun decodesInstagramShortcodeToMediaId() {
        assertEquals("3967213292204992434", mediaIdFromShortcode("DcOX3hWFiey"))
        assertEquals("3967213292204992434", mediaIdFromShortcode("DcOX3hWFieyAbCdEf"))
        assertThrows(SeraException::class.java) {
            mediaIdFromShortcode("DcOX3hW.iey")
        }
    }

    @Test
    fun extractsInstagramShortcodesFromAllPaths() {
        for (path in listOf(
            "/p/DcOX3hWFiey/",
            "/reel/DcOX3hWFiey",
            "/reels/DcOX3hWFiey/",
            "/tv/DcOX3hWFiey/",
            "/nasa/p/DcOX3hWFiey/",
        )) {
            assertEquals("DcOX3hWFiey", shortcodeFrom("https://www.instagram.com$path".toHttpUrl()))
        }
        assertNull(shortcodeFrom("https://www.instagram.com/nasa/".toHttpUrl()))
    }

    @Test
    fun parsesInstagramWebApiSingleAndMixedCarouselPosts() {
        val rawJson = """
            {
              "items": [
                {
                  "id": "carousel_1",
                  "media_type": 8,
                  "user": { "username": "creator", "full_name": "Creator Name" },
                  "caption": { "text": "Carousel caption here" },
                  "carousel_media": [
                    {
                      "id": "slide_img",
                      "media_type": 1,
                      "accessibility_caption": "Photo slide",
                      "image_versions2": {
                        "candidates": [
                          { "url": "https://scontent.cdninstagram.com/v/small.jpg", "width": 320, "height": 320 },
                          { "url": "https://scontent.cdninstagram.com/v/full.jpg", "width": 1080, "height": 1350 }
                        ]
                      }
                    },
                    {
                      "id": "slide_vid",
                      "media_type": 2,
                      "video_duration": 12.5,
                      "video_versions": [
                        { "url": "https://instagram.fvie1-1.fna.fbcdn.net/v/v480.mp4", "width": 480, "height": 854 },
                        { "url": "https://instagram.fvie1-1.fna.fbcdn.net/v/v720.mp4", "width": 720, "height": 1280 }
                      ],
                      "image_versions2": {
                        "candidates": [
                          { "url": "https://scontent.cdninstagram.com/v/cover.jpg", "width": 720, "height": 1280 }
                        ]
                      }
                    }
                  ]
                }
              ]
            }
        """.trimIndent()

        val response = SeraJson.decodeFromString(InstagramMediaInfoResponse.serializer(), rawJson)
        val media = resolvedMediaFromInstagramNode(
            node = response.items!!.first(),
            url = "https://www.instagram.com/p/DcOX3hWFiey",
            maxItems = 50,
        )

        assertEquals("instagram", media.provider)
        assertEquals("collection", media.type)
        assertEquals("Carousel caption here", media.title)
        assertEquals("Creator Name", media.author)
        assertEquals("https://www.instagram.com/creator/", media.authorUrl)
        assertEquals(2, media.items.size)

        val imgItem = media.items[0]
        assertEquals("image", imgItem.kind)
        assertEquals(1080, imgItem.width)
        assertEquals(listOf("image/jpg/Original"), imgItem.plans.map { planKey(it) })
        assertEquals(
            FetchPlan.Direct("https://scontent.cdninstagram.com/v/full.jpg"),
            imgItem.plans[0].fetch,
        )

        val vidItem = media.items[1]
        assertEquals("video", vidItem.kind)
        assertEquals(12.5, vidItem.duration!!, 0.001)
        assertEquals(listOf("video/mp4/Original", "audio/mp3/MP3"), vidItem.plans.map { planKey(it) })
        assertEquals(
            FetchPlan.Direct("https://instagram.fvie1-1.fna.fbcdn.net/v/v720.mp4"),
            vidItem.plans[0].fetch,
        )
        assertTrue(vidItem.plans[1].requiresConversion)
    }

    @Test
    fun enforcesInstagramCdnHostPolicy() {
        assertTrue(isAllowedMediaUrl("https://scontent-vie1-1.cdninstagram.com/v/a.jpg"))
        assertTrue(isAllowedMediaUrl("https://instagram.fvie1-1.fna.fbcdn.net/o1/a.mp4"))
        assertFalse(isAllowedMediaUrl("http://scontent.cdninstagram.com/a.jpg"))
        assertFalse(isAllowedMediaUrl("https://scontent.cdninstagram.com:444/a.jpg"))
        assertFalse(isAllowedMediaUrl("https://u:p@scontent.cdninstagram.com/a.jpg"))
        assertFalse(isAllowedMediaUrl("https://cdninstagram.com.evil.org/a.jpg"))
        assertFalse(isAllowedMediaUrl("https://www.instagram.com/p/DcOX3hWFiey/"))

        assertThrows(SeraException::class.java) {
            assertCdnHosts(listOf("https://evil.example/a.jpg"))
        }
    }

    @Test
    fun detectsAllTwentyTwoNamedProvidersAndFallsBackToNullForGeneric() {
        assertEquals("youtube", detectProvider("https://www.youtube.com/watch?v=abc".toHttpUrl()))
        assertEquals("twitter", detectProvider("https://x.com/user/status/123".toHttpUrl()))
        assertEquals("twitter", detectProvider("https://t.co/short".toHttpUrl()))
        assertEquals("tiktok", detectProvider("https://www.tiktok.com/@user/video/123".toHttpUrl()))
        assertEquals("instagram", detectProvider("https://www.instagram.com/reel/abc/".toHttpUrl()))
        assertEquals("reddit", detectProvider("https://www.reddit.com/r/pics/comments/abc/title/".toHttpUrl()))
        assertEquals("reddit", detectProvider("https://v.redd.it/vid123".toHttpUrl()))
        assertEquals("twitch", detectProvider("https://clips.twitch.tv/ClipSlug".toHttpUrl()))
        assertEquals("vimeo", detectProvider("https://vimeo.com/12345678".toHttpUrl()))
        assertEquals("soundcloud", detectProvider("https://soundcloud.com/artist/track".toHttpUrl()))
        assertEquals("facebook", detectProvider("https://www.facebook.com/watch/?v=123".toHttpUrl()))
        assertEquals("pinterest", detectProvider("https://www.pinterest.com/pin/123/".toHttpUrl()))
        assertEquals("bandcamp", detectProvider("https://artist.bandcamp.com/track/song".toHttpUrl()))
        assertEquals("dailymotion", detectProvider("https://dai.ly/x8abc".toHttpUrl()))
        assertEquals("tumblr", detectProvider("https://blog.tumblr.com/post/123".toHttpUrl()))
        assertEquals("threads", detectProvider("https://www.threads.com/@user/post/Cxyz".toHttpUrl()))
        assertEquals("bluesky", detectProvider("https://bsky.app/profile/user.bsky.social/post/3kxyz".toHttpUrl()))
        assertEquals("mastodon", detectProvider("https://mastodon.social/@user/112233".toHttpUrl()))
        assertEquals("mastodon", detectProvider("https://custom.instance/@user/998877".toHttpUrl()))
        assertEquals("snapchat", detectProvider("https://www.snapchat.com/spotlight/W7_abc".toHttpUrl()))
        assertEquals("gdrive", detectProvider("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view".toHttpUrl()))
        assertEquals("dropbox", detectProvider("https://www.dropbox.com/s/abc/video.mp4?dl=0".toHttpUrl()))
        assertEquals("mediafire", detectProvider("https://www.mediafire.com/file/abc/song.mp3/file".toHttpUrl()))
        assertEquals("mega", detectProvider("https://mega.nz/file/abc#key".toHttpUrl()))
        assertEquals("direct", detectProvider("https://cdn.example.com/clip.mp4".toHttpUrl()))
        assertNull(detectProvider("https://example.com/article/hello-world".toHttpUrl()))
    }
}
