package dev.sera.toolkit.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShareUrlParserTest {
    @Test
    fun extractsYoutubeShortLinkWithSiAndStripsTrackingParam() {
        val raw = "Watch this https://youtu.be/dQw4w9WgXcQ?si=abc123XYZ!"
        val extracted = ShareUrlParser.extractFromIntentTexts(listOf(raw))
        assertEquals(listOf("https://youtu.be/dQw4w9WgXcQ?si=abc123XYZ"), extracted)
        assertEquals(
            "https://youtu.be/dQw4w9WgXcQ",
            ShareUrlParser.stripTrackingParams(extracted.first()),
        )
    }

    @Test
    fun extractsInstagramReelWithIgshAndStripsTrackingParam() {
        val raw = "https://www.instagram.com/reel/C8xYz123AbC/?igsh=MWx2YzR0cG1zYQ==."
        val extracted = ShareUrlParser.extractFromIntentTexts(listOf(raw))
        assertEquals(listOf("https://www.instagram.com/reel/C8xYz123AbC/?igsh=MWx2YzR0cG1zYQ=="), extracted)
        assertEquals(
            "https://www.instagram.com/reel/C8xYz123AbC/",
            ShareUrlParser.stripTrackingParams(extracted.first()),
        )
    }

    @Test
    fun extractsTiktokShortLinkAndPreservesPath() {
        val raw = "Check out this clip: https://vm.tiktok.com/ZGe999AbC/,"
        val extracted = ShareUrlParser.extractFromIntentTexts(listOf(raw))
        assertEquals(listOf("https://vm.tiktok.com/ZGe999AbC/"), extracted)
        assertEquals(
            "https://vm.tiktok.com/ZGe999AbC/",
            ShareUrlParser.stripTrackingParams(extracted.first()),
        )
    }

    @Test
    fun extractsSeveralUrlsInOneTextAndAcrossIntentFields() {
        val text = "First (https://youtu.be/aaa111?si=111) and second https://vm.tiktok.com/ZGe222/; " +
            "third:\nhttps://www.instagram.com/reel/XYZ/?igsh=999."
        val subject = "Shared: https://youtu.be/aaa111?si=111"
        val extracted = ShareUrlParser.extractFromIntentTexts(listOf(text, subject))
        assertEquals(
            listOf(
                "https://youtu.be/aaa111?si=111",
                "https://vm.tiktok.com/ZGe222/",
                "https://www.instagram.com/reel/XYZ/?igsh=999",
            ),
            extracted,
        )
        assertEquals(
            listOf(
                "https://youtu.be/aaa111",
                "https://vm.tiktok.com/ZGe222/",
                "https://www.instagram.com/reel/XYZ/",
            ),
            ShareUrlParser.extractCleanUrls(listOf(text, subject)),
        )
    }

    @Test
    fun trimsTrailingPunctuationWhilePreservingBalancedParentheses() {
        val withParen = "See https://en.wikipedia.org/wiki/Media_(arts)!"
        assertEquals(
            "https://en.wikipedia.org/wiki/Media_(arts)",
            ShareUrlParser.firstHttpUrl(withParen),
        )
        val wrapped = "(https://example.com/video.mp4)."
        assertEquals(
            "https://example.com/video.mp4",
            ShareUrlParser.firstHttpUrl(wrapped),
        )
    }

    @Test
    fun stripTrackingParamsPreservesVideoIdPlaylistTimestampIndexAndPath() {
        val input = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345&index=4&t=95s&si=drop1&feature=youtu.be&utm_source=share&utm_medium=android&fbclid=fb123&igshid=ig1#chapter-2"
        val cleaned = ShareUrlParser.stripTrackingParams(input)
        assertEquals(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345&index=4&t=95s#chapter-2",
            cleaned,
        )
    }

    @Test
    fun stripTrackingParamsUsesFixedDenylistOnly() {
        val input = "https://example.com/p/123?signature=keep&utm=keep&utm_campaign=drop&SI=drop&token=ok"
        val cleaned = ShareUrlParser.stripTrackingParams(input)
        assertEquals(
            "https://example.com/p/123?signature=keep&utm=keep&token=ok",
            cleaned,
        )
    }

    @Test
    fun rejectsCredentialsAndNonHttpSchemes() {
        assertNull(ShareUrlParser.firstHttpUrl("https://user:pass@example.com/video"))
        assertNull(ShareUrlParser.firstHttpUrl("javascript:alert(1)"))
        assertNull(ShareUrlParser.firstHttpUrl("just plain text without a link"))
    }
}
