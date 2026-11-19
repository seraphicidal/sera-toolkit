package dev.sera.node.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EnvConfigParserTest {
    @Test
    fun parsesStandardEnvNodeLocalText() {
        val raw = """
            # Local node environment
            SERA_API_URL="https://sera.example.com/"
            export SERA_EXTRACTION_NODE_TOKEN='tok_secret_123'
            SERA_NODE_ID=pixel-9-pro # residential phone
            SERA_NODE_PROVIDERS=youtube,instagram
            SERA_NODE_NETWORK_CLASS=residential
            SERA_INSTAGRAM_SESSION_ID=123456%3Aabcdef
            SERA_NODE_CAPACITY=4
            SERA_ALLOW_CELLULAR=true
            SERA_ALLOW_WIFI=1
            SERA_ONLY_WHILE_CHARGING=false
            SERA_YOUTUBE_PLAYER_CLIENTS=web_safari,android
            SERA_YOUTUBE_POT_PROVIDER_URL=http://127.0.0.1:4416/
            SERA_GITHUB_REPO=seraphicidal/sera-toolkit
        """.trimIndent()

        val parsed = EnvConfigParser.parse(raw)

        assertEquals("https://sera.example.com", parsed.apiBaseUrl)
        assertEquals("tok_secret_123", parsed.nodeToken)
        assertEquals("pixel-9-pro", parsed.nodeId)
        assertEquals(true, parsed.enableYoutube)
        assertEquals(true, parsed.enableInstagram)
        assertEquals("123456%3Aabcdef", parsed.instagramSessionId)
        assertEquals(4, parsed.preferredCapacity)
        assertEquals(true, parsed.allowCellular)
        assertEquals(true, parsed.allowWifi)
        assertEquals(false, parsed.onlyWhileCharging)
        assertEquals("web_safari,android", parsed.youtubePlayerClients)
        assertEquals("http://127.0.0.1:4416", parsed.youtubePotProviderUrl)
        assertEquals("seraphicidal/sera-toolkit", parsed.githubReleasesRepo)
        assertTrue(parsed.importedFields.containsAll(listOf("Server URL", "Node Token", "Node ID", "Instagram Session ID")))
    }

    @Test
    fun parsesSingleProviderAndClampsCapacity() {
        val raw = """
            SERA_NODE_PROVIDERS=youtube
            SERA_NODE_CAPACITY=99
        """.trimIndent()

        val parsed = EnvConfigParser.parse(raw)

        assertEquals(true, parsed.enableYoutube)
        assertEquals(false, parsed.enableInstagram)
        assertEquals(8, parsed.preferredCapacity)
        assertNull(parsed.apiBaseUrl)
        assertNull(parsed.nodeToken)
    }

    @Test
    fun returnsEmptyWhenNoKnownKeysPresent() {
        val parsed = EnvConfigParser.parse("# nothing here\nFOO=bar")
        assertTrue(parsed.importedFields.isEmpty())
        assertNull(parsed.apiBaseUrl)
        assertNull(parsed.nodeToken)
        assertFalse(parsed.importedFields.contains("Server URL"))
    }
}
