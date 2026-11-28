package dev.sera.toolkit.model

import dev.sera.toolkit.domain.SelectionLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContractsDecodingTest {
    @Test
    fun decodesDirectFileMediaInfoWithoutThrowing() {
        val raw = """
            {
              "id": "signed-info-token-123",
              "provider": "direct",
              "providerLabel": "Direct file",
              "url": "https://example.com/report.pdf",
              "type": "single",
              "title": "Quarterly Report",
              "thumbnail": "/api/thumb/tok123",
              "expiresIn": 1800,
              "items": [
                {
                  "id": "item-1",
                  "index": 1,
                  "kind": "file",
                  "title": "report.pdf",
                  "container": "pdf",
                  "filesizeBytes": 4200000,
                  "options": [
                    {
                      "id": "opt-pdf",
                      "itemId": "item-1",
                      "kind": "file",
                      "container": "pdf",
                      "label": "Original PDF",
                      "filesizeBytes": 4200000,
                      "requiresConversion": false,
                      "recommended": true
                    }
                  ]
                }
              ]
            }
        """.trimIndent()

        val info = SeraJson.decodeFromString<MediaInfo>(raw)
        assertEquals(MediaInfoType.SINGLE, info.type)
        assertEquals(1, info.items.size)
        assertEquals(MediaKind.FILE, info.items[0].kind)
        assertEquals(MediaKind.FILE, info.items[0].options[0].kind)
        assertEquals(listOf(MediaKind.FILE), SelectionLogic.availableKinds(info))
        assertEquals(MediaKind.FILE, SelectionLogic.initialKind(info))
    }

    @Test
    fun unknownEnumValuesFallBackToUnknownInsteadOfThrowing() {
        val mediaJson = """
            {
              "id": "info-2",
              "provider": "future",
              "providerLabel": "Future Provider",
              "url": "https://example.com/future",
              "type": "spatial_album",
              "title": "Future item",
              "expiresIn": 600,
              "items": [
                {
                  "id": "i1",
                  "index": 1,
                  "kind": "hologram",
                  "options": [
                    {
                      "id": "o1",
                      "itemId": "i1",
                      "kind": "hologram",
                      "container": "holo",
                      "label": "3D",
                      "requiresConversion": false,
                      "recommended": true
                    }
                  ]
                }
              ]
            }
        """.trimIndent()
        val info = SeraJson.decodeFromString<MediaInfo>(mediaJson)
        assertEquals(MediaInfoType.UNKNOWN, info.type)
        assertEquals(MediaKind.UNKNOWN, info.items[0].kind)
        assertEquals(MediaKind.UNKNOWN, info.items[0].options[0].kind)

        val jobJson = """
            {
              "id": "0123456789abcdef",
              "state": "uploading_to_mars",
              "step": "Working",
              "progress": { "percent": 50 },
              "provider": "youtube",
              "createdAt": "2026-11-28T00:00:00Z",
              "updatedAt": "2026-11-28T00:00:01Z"
            }
        """.trimIndent()
        val job = SeraJson.decodeFromString<Job>(jobJson)
        assertEquals(JobState.UNKNOWN, job.state)
        assertTrue(!job.state.isTerminal)

        val healthJson = """
            {
              "status": "maintenance",
              "version": "1.9.0",
              "uptimeSeconds": 120.5,
              "checks": [
                { "name": "yt-dlp", "status": "warming_up" }
              ]
            }
        """.trimIndent()
        val health = SeraJson.decodeFromString<HealthReport>(healthJson)
        assertEquals(HealthStatus.UNKNOWN, health.status)
        assertEquals(HealthCheckStatus.UNKNOWN, health.checks[0].status)
    }

    @Test
    fun decodesServiceInfoWithRuntimeLimitsAndNodeAvailability() {
        val raw = """
            {
              "name": "SERA.toolkit",
              "version": "1.8.0",
              "providers": [
                {
                  "id": "youtube",
                  "label": "YouTube",
                  "hosts": ["youtube.com", "youtu.be"],
                  "status": "degraded",
                  "capabilities": {
                    "video": true,
                    "audio": true,
                    "residentialFallback": true
                  }
                },
                {
                  "id": "future",
                  "label": "Future",
                  "hosts": [],
                  "status": "experimental",
                  "capabilities": {}
                }
              ],
              "limits": {
                "maxFilesizeBytes": 2147483648,
                "maxDurationSeconds": 10800,
                "maxItemsPerJob": 25,
                "retentionSeconds": 1800
              },
              "nodeAvailability": {
                "enabled": true,
                "totalNodes": 2,
                "healthyNodes": 0,
                "residentialNodes": 2,
                "primaryNodes": 1,
                "backupNodes": 1,
                "features": ["trim", "subtitles"],
                "providers": ["youtube", "instagram"]
              }
            }
        """.trimIndent()

        val serviceInfo = SeraJson.decodeFromString<ServiceInfo>(raw)
        assertEquals(2147483648L, serviceInfo.limits.maxFilesizeBytes)
        assertEquals(10800L, serviceInfo.limits.maxDurationSeconds)
        assertEquals(25, serviceInfo.limits.maxItemsPerJob)
        assertEquals(1800L, serviceInfo.limits.retentionSeconds)
        assertEquals(ProviderStatus.DEGRADED, serviceInfo.providers[0].status)
        assertEquals(ProviderStatus.UNKNOWN, serviceInfo.providers[1].status)
        val nodes = serviceInfo.nodeAvailability
        assertNotNull(nodes)
        assertEquals(true, nodes!!.enabled)
        assertEquals(0, nodes.healthyNodes)
        assertEquals(2, nodes.totalNodes)
        assertEquals(listOf("youtube", "instagram"), nodes.providers)
    }

    @Test
    fun preferredLabelForKindPicksRecommendedOption() {
        val info = MediaInfo(
            id = "id1",
            provider = "youtube",
            providerLabel = "YouTube",
            url = "https://youtu.be/abc",
            type = MediaInfoType.SINGLE,
            title = "Sample",
            items = listOf(
                MediaItem(
                    id = "item-1",
                    index = 1,
                    kind = MediaKind.VIDEO,
                    options = listOf(
                        DownloadOption(
                            id = "opt-4k",
                            itemId = "item-1",
                            kind = MediaKind.VIDEO,
                            container = "webm",
                            label = "2160p",
                            recommended = false,
                        ),
                        DownloadOption(
                            id = "opt-1080",
                            itemId = "item-1",
                            kind = MediaKind.VIDEO,
                            container = "mp4",
                            label = "1080p",
                            recommended = true,
                        ),
                    ),
                ),
            ),
        )
        assertEquals("1080p", SelectionLogic.preferredLabelForKind(info, MediaKind.VIDEO, setOf("item-1")))
    }
}
