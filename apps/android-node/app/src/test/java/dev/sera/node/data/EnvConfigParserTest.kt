package dev.sera.node.data

import dev.sera.node.model.NodeRole
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

    @Test
    fun parsesServerEnvWithDomainAndNodeTokensList() {
        val raw = """
            SERA_API_URL=http://api:4000
            SERA_DOMAIN=1-2-3-4.sslip.io
            SERA_EXTRACTION_NODE_TOKENS=phone-1:secret_alpha,phone-2:secret_beta
            SERA_NODE_ID=phone-2
        """.trimIndent()

        val parsed = EnvConfigParser.parse(raw)

        assertEquals("https://1-2-3-4.sslip.io", parsed.apiBaseUrl)
        assertEquals("secret_beta", parsed.nodeToken)
        assertEquals("phone-2", parsed.nodeId)
        assertEquals("https://sera.example.com", NodeSettings.normalizeBaseUrl("https://sera.example.com/api/"))
    }

    @Test
    fun parsesAllProvidersAndRedditCredentials() {
        val raw = """
            SERA_NODE_PROVIDERS=all
            SERA_REDDIT_CLIENT_ID=reddit_id_123
            SERA_REDDIT_CLIENT_SECRET=reddit_sec_456
        """.trimIndent()

        val parsed = EnvConfigParser.parse(raw)

        assertEquals(true, parsed.enableYoutube)
        assertEquals(true, parsed.enableInstagram)
        assertEquals(true, parsed.enableAllProviders)
        assertEquals("reddit_id_123", parsed.redditClientId)
        assertEquals("reddit_sec_456", parsed.redditClientSecret)
        assertEquals(23, NodeSettings().activeProviders().size)
        assertEquals(NodeRole.BACKUP, NodeSettings().nodeRole)
        assertEquals(NodeRole.BACKUP, NodeSettings().toRuntimeConfig("/tmp/work").role)
    }

    @Test
    fun parsesExtractionNodeRoleAndIgnoresInvalidValues() {
        val primaryParsed = EnvConfigParser.parse(
            """
            SERA_EXTRACTION_NODE_ROLE=primary
            """.trimIndent(),
        )
        assertEquals(NodeRole.PRIMARY, primaryParsed.nodeRole)
        assertTrue(primaryParsed.importedFields.contains("Node Role"))

        val backupParsed = EnvConfigParser.parse(
            """
            SERA_EXTRACTION_NODE_ROLE=BACKUP
            """.trimIndent(),
        )
        assertEquals(NodeRole.BACKUP, backupParsed.nodeRole)
        assertTrue(backupParsed.importedFields.contains("Node Role"))

        val fallbackKeyParsed = EnvConfigParser.parse(
            """
            SERA_NODE_ROLE=primary
            """.trimIndent(),
        )
        assertEquals(NodeRole.PRIMARY, fallbackKeyParsed.nodeRole)
        assertTrue(fallbackKeyParsed.importedFields.contains("Node Role"))

        val invalidParsed = EnvConfigParser.parse(
            """
            SERA_EXTRACTION_NODE_ROLE=standby
            """.trimIndent(),
        )
        assertNull(invalidParsed.nodeRole)
        assertFalse(invalidParsed.importedFields.contains("Node Role"))

        assertEquals(NodeRole.BACKUP, NodeRole.fromStorage(null))
        assertEquals(NodeRole.BACKUP, NodeRole.fromStorage("invalid"))
        assertEquals(NodeRole.PRIMARY, NodeRole.fromStorage("primary"))
    }
}
