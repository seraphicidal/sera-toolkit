package dev.sera.node.service

import dev.sera.node.data.ApiStatusException
import dev.sera.node.data.FatalAuthException
import dev.sera.node.data.NonRetryableUploadException
import dev.sera.node.data.TaskCancelledException
import dev.sera.node.model.NetworkState
import dev.sera.node.model.NetworkTransport
import dev.sera.node.net.NetworkCandidate
import dev.sera.node.net.classifyNetworkTransport
import dev.sera.node.net.isNetworkUsable
import dev.sera.node.net.resolveNetworkState
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
        assertEquals(
            NetworkTransport.OTHER,
            classifyNetworkTransport(
                hasWifi = false,
                hasCellular = false,
                hasEthernet = false,
                isConnected = true,
                hasVpn = true,
            ),
        )
    }

    @Test
    fun acceptsUnvalidatedNonCaptiveAndVpnNetworksWhileRejectingCaptivePortals() {
        assertTrue(isNetworkUsable(hasInternet = true, hasValidated = true, hasCaptivePortal = false))
        assertTrue(isNetworkUsable(hasInternet = true, hasValidated = false, hasCaptivePortal = false))
        assertFalse(isNetworkUsable(hasInternet = true, hasValidated = false, hasCaptivePortal = true))
        assertFalse(isNetworkUsable(hasInternet = false, hasValidated = true, hasCaptivePortal = false))

        val unvalidatedWifi = NetworkCandidate(
            networkId = 101L,
            hasInternet = true,
            hasValidated = false,
            hasCaptivePortal = false,
            hasWifi = true,
            hasCellular = false,
            hasEthernet = false,
            hasVpn = false,
            isMetered = false,
        )
        val eduroamState = resolveNetworkState(unvalidatedWifi, listOf(unvalidatedWifi))
        assertTrue(eduroamState.isConnected)
        assertEquals(NetworkTransport.WIFI, eduroamState.transport)
        assertTrue(eduroamState.isAllowed(allowWifi = true, allowCellular = false))

        val vpnOnly = NetworkCandidate(
            networkId = 202L,
            hasInternet = true,
            hasValidated = false,
            hasCaptivePortal = false,
            hasWifi = false,
            hasCellular = false,
            hasEthernet = false,
            hasVpn = true,
            isMetered = false,
        )
        val vpnOverWifiState = resolveNetworkState(vpnOnly, listOf(vpnOnly, unvalidatedWifi))
        assertTrue(vpnOverWifiState.isConnected)
        assertEquals(NetworkTransport.WIFI, vpnOverWifiState.transport)

        val standaloneVpnState = resolveNetworkState(vpnOnly, listOf(vpnOnly))
        assertTrue(standaloneVpnState.isConnected)
        assertEquals(NetworkTransport.OTHER, standaloneVpnState.transport)
        assertTrue(standaloneVpnState.isAllowed(allowWifi = true, allowCellular = false))

        val captiveWifi = unvalidatedWifi.copy(networkId = 303L, hasCaptivePortal = true)
        val validatedCellular = NetworkCandidate(
            networkId = 404L,
            hasInternet = true,
            hasValidated = true,
            hasCaptivePortal = false,
            hasWifi = false,
            hasCellular = true,
            hasEthernet = false,
            hasVpn = false,
            isMetered = true,
        )
        val captiveFallbackState = resolveNetworkState(captiveWifi, listOf(captiveWifi, validatedCellular))
        assertTrue(captiveFallbackState.isConnected)
        assertEquals(NetworkTransport.CELLULAR, captiveFallbackState.transport)
        assertEquals(404L, captiveFallbackState.activeNetworkId)

        val captiveOnlyState = resolveNetworkState(captiveWifi, listOf(captiveWifi))
        assertFalse(captiveOnlyState.isConnected)
        assertEquals(NetworkTransport.NONE, captiveOnlyState.transport)

        val preferValidatedState = resolveNetworkState(null, listOf(unvalidatedWifi, validatedCellular))
        assertTrue(preferValidatedState.isConnected)
        assertEquals(404L, preferValidatedState.activeNetworkId)
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

    @Test
    fun scalesProgressThrottleWithConcurrencyHandles429BackoffAndStickyStopPolicy() {
        assertTrue(NodeServicePolicy.PROGRESS_THROTTLE_MS >= 1_000L)
        assertEquals(1_000L, NodeServicePolicy.effectiveProgressThrottleMs(1))
        assertEquals(1_000L, NodeServicePolicy.effectiveProgressThrottleMs(4))
        assertEquals(1_500L, NodeServicePolicy.effectiveProgressThrottleMs(6))
        assertEquals(2_000L, NodeServicePolicy.effectiveProgressThrottleMs(8))

        val maxReqsPerMinuteAtCap8 = (8 * 60_000L) / NodeServicePolicy.effectiveProgressThrottleMs(8)
        assertTrue(maxReqsPerMinuteAtCap8 <= 300L)

        assertEquals(2_000L, NodeServicePolicy.computeProgressRateLimitBackoffMs(0L, null))
        assertEquals(4_000L, NodeServicePolicy.computeProgressRateLimitBackoffMs(2_000L, null))
        assertEquals(15_000L, NodeServicePolicy.computeProgressRateLimitBackoffMs(12_000L, null))
        assertEquals(7_000L, NodeServicePolicy.computeProgressRateLimitBackoffMs(0L, 7L))
        assertEquals(15_000L, NodeServicePolicy.computeProgressRateLimitBackoffMs(0L, 120L))

        assertTrue(NodeServicePolicy.shouldStopOnStickyRestart(serviceEnabled = false))
        assertFalse(NodeServicePolicy.shouldStopOnStickyRestart(serviceEnabled = true))
    }
}
