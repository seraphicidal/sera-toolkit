package dev.sera.node.service

import dev.sera.node.data.ApiStatusException
import dev.sera.node.data.FatalAuthException
import dev.sera.node.data.NonRetryableUploadException
import dev.sera.node.data.TaskCancelledException
import dev.sera.node.model.NetworkState
import dev.sera.node.model.NetworkTransport
import dev.sera.node.net.classifyNetworkTransport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ConnectivityAndPolicyTest {
    @Test
    fun classifiesTransportsCorrectly() {
        assertEquals(
            NetworkTransport.NONE,
            classifyNetworkTransport(hasWifi = true, hasCellular = true, hasEthernet = false, isConnected = false),
        )
        assertEquals(
            NetworkTransport.WIFI,
            classifyNetworkTransport(hasWifi = true, hasCellular = true, hasEthernet = false, isConnected = true),
        )
        assertEquals(
            NetworkTransport.CELLULAR,
            classifyNetworkTransport(hasWifi = false, hasCellular = true, hasEthernet = false, isConnected = true),
        )
        assertEquals(
            NetworkTransport.OTHER,
            classifyNetworkTransport(hasWifi = false, hasCellular = false, hasEthernet = true, isConnected = true),
        )
    }

    @Test
    fun evaluatesNetworkAllowanceForWifiAndCellular() {
        val cellular = NetworkState(isConnected = true, transport = NetworkTransport.CELLULAR, isMetered = true)
        assertTrue(cellular.isAllowed(allowWifi = true, allowCellular = true))
        assertTrue(cellular.isAllowed(allowWifi = false, allowCellular = true))
        assertFalse(cellular.isAllowed(allowWifi = true, allowCellular = false))

        val wifi = NetworkState(isConnected = true, transport = NetworkTransport.WIFI, isMetered = false)
        assertTrue(wifi.isAllowed(allowWifi = true, allowCellular = false))
        assertFalse(wifi.isAllowed(allowWifi = false, allowCellular = true))

        val offline = NetworkState(isConnected = false, transport = NetworkTransport.NONE)
        assertFalse(offline.isAllowed(allowWifi = true, allowCellular = true))
    }

    @Test
    fun buildsFeaturesWithConditionalInstagramSession() {
        assertEquals(
            listOf("trim", "subtitles", "items"),
            NodeServicePolicy.buildNodeFeatures(null),
        )
        assertEquals(
            listOf("trim", "subtitles", "items"),
            NodeServicePolicy.buildNodeFeatures("   "),
        )
        assertEquals(
            listOf("trim", "subtitles", "items", "instagram-session"),
            NodeServicePolicy.buildNodeFeatures("12345%3Asession"),
        )
    }

    @Test
    fun computesIdleSleepAndRetryBackoff() {
        assertEquals(2_000L, NodeServicePolicy.shouldIdleSleepMs(500L))
        assertEquals(0L, NodeServicePolicy.shouldIdleSleepMs(5_000L))
        assertEquals(0L, NodeServicePolicy.shouldIdleSleepMs(25_000L))

        assertEquals(5_000L, NodeServicePolicy.computeRetryBackoffMs(1))
        assertEquals(10_000L, NodeServicePolicy.computeRetryBackoffMs(2))
        assertEquals(20_000L, NodeServicePolicy.computeRetryBackoffMs(3))
        assertEquals(40_000L, NodeServicePolicy.computeRetryBackoffMs(4))
        assertEquals(60_000L, NodeServicePolicy.computeRetryBackoffMs(5))
        assertEquals(60_000L, NodeServicePolicy.computeRetryBackoffMs(20))
    }

    @Test
    fun classifiesRetryableUploadFailures() {
        assertTrue(NodeServicePolicy.isRetryableUploadFailure(IOException("wifi handoff reset")))
        assertTrue(NodeServicePolicy.isRetryableUploadFailure(ApiStatusException(502, "bad gateway")))
        assertTrue(NodeServicePolicy.isRetryableUploadFailure(ApiStatusException(503, "unavailable")))
        assertTrue(NodeServicePolicy.isRetryableUploadFailure(ApiStatusException(429, "rate limit")))

        assertFalse(NodeServicePolicy.isRetryableUploadFailure(TaskCancelledException()))
        assertFalse(NodeServicePolicy.isRetryableUploadFailure(FatalAuthException(401)))
        assertFalse(NodeServicePolicy.isRetryableUploadFailure(NonRetryableUploadException(413, "too large")))
        assertFalse(NodeServicePolicy.isRetryableUploadFailure(ApiStatusException(400, "bad request")))
    }

    @Test
    fun evaluatesBlockingConditionsInPriorityOrder() {
        val cellularOnline = NetworkState(isConnected = true, transport = NetworkTransport.CELLULAR)
        assertEquals(
            NodeServiceState.UNCONFIGURED,
            NodeServicePolicy.evaluateBlockingCondition(
                isConfigured = false,
                isPaused = false,
                networkState = cellularOnline,
                allowWifi = true,
                allowCellular = true,
                onlyWhileCharging = false,
                isCharging = false,
            ),
        )
        assertEquals(
            NodeServiceState.PAUSED,
            NodeServicePolicy.evaluateBlockingCondition(
                isConfigured = true,
                isPaused = true,
                networkState = cellularOnline,
                allowWifi = true,
                allowCellular = true,
                onlyWhileCharging = false,
                isCharging = false,
            ),
        )
        assertEquals(
            NodeServiceState.WAITING_CHARGING,
            NodeServicePolicy.evaluateBlockingCondition(
                isConfigured = true,
                isPaused = false,
                networkState = cellularOnline,
                allowWifi = true,
                allowCellular = true,
                onlyWhileCharging = true,
                isCharging = false,
            ),
        )
        assertEquals(
            NodeServiceState.WAITING_NETWORK,
            NodeServicePolicy.evaluateBlockingCondition(
                isConfigured = true,
                isPaused = false,
                networkState = cellularOnline,
                allowWifi = true,
                allowCellular = false,
                onlyWhileCharging = false,
                isCharging = true,
            ),
        )
        assertNull(
            NodeServicePolicy.evaluateBlockingCondition(
                isConfigured = true,
                isPaused = false,
                networkState = cellularOnline,
                allowWifi = true,
                allowCellular = true,
                onlyWhileCharging = true,
                isCharging = true,
            ),
        )
    }
}
