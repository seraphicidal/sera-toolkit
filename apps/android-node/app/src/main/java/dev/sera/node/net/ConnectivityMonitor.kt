package dev.sera.node.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import dev.sera.node.model.NetworkState
import dev.sera.node.model.NetworkTransport
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

fun classifyNetworkTransport(
    hasWifi: Boolean,
    hasCellular: Boolean,
    hasEthernet: Boolean,
    isConnected: Boolean,
    hasVpn: Boolean = false,
): NetworkTransport {
    if (!isConnected) return NetworkTransport.NONE
    return when {
        hasWifi -> NetworkTransport.WIFI
        hasCellular -> NetworkTransport.CELLULAR
        hasEthernet -> NetworkTransport.OTHER
        hasVpn -> NetworkTransport.OTHER
        else -> NetworkTransport.OTHER
    }
}

internal fun isNetworkUsable(
    hasInternet: Boolean,
    hasValidated: Boolean,
    hasCaptivePortal: Boolean,
): Boolean {
    if (!hasInternet) return false
    return hasValidated || !hasCaptivePortal
}

internal data class NetworkCandidate(
    val networkId: Long,
    val hasInternet: Boolean,
    val hasValidated: Boolean,
    val hasCaptivePortal: Boolean,
    val hasWifi: Boolean,
    val hasCellular: Boolean,
    val hasEthernet: Boolean,
    val hasVpn: Boolean,
    val isMetered: Boolean,
)

internal fun resolveNetworkState(
    active: NetworkCandidate?,
    tracked: Collection<NetworkCandidate>,
): NetworkState {
    val usableTracked = tracked.filter {
        isNetworkUsable(
            hasInternet = it.hasInternet,
            hasValidated = it.hasValidated,
            hasCaptivePortal = it.hasCaptivePortal,
        )
    }
    val activeUsable = active?.takeIf {
        isNetworkUsable(
            hasInternet = it.hasInternet,
            hasValidated = it.hasValidated,
            hasCaptivePortal = it.hasCaptivePortal,
        )
    }
    val selected = activeUsable
        ?: usableTracked.firstOrNull { it.hasValidated }
        ?: usableTracked.firstOrNull()
        ?: return NetworkState(
            isConnected = false,
            transport = NetworkTransport.NONE,
            isMetered = false,
            activeNetworkId = 0L,
        )

    var hasWifi = selected.hasWifi
    var hasCellular = selected.hasCellular
    var hasEthernet = selected.hasEthernet
    if (selected.hasVpn && !hasWifi && !hasCellular && !hasEthernet) {
        val nonVpnUsable = usableTracked.filterNot { it.hasVpn }
        hasWifi = nonVpnUsable.any { it.hasWifi }
        hasCellular = nonVpnUsable.any { it.hasCellular }
        hasEthernet = nonVpnUsable.any { it.hasEthernet }
    }

    val transport = classifyNetworkTransport(
        hasWifi = hasWifi,
        hasCellular = hasCellular,
        hasEthernet = hasEthernet,
        isConnected = true,
        hasVpn = selected.hasVpn,
    )
    return NetworkState(
        isConnected = true,
        transport = transport,
        isMetered = selected.isMetered,
        activeNetworkId = selected.networkId,
    )
}

class ConnectivityMonitor(context: Context) {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val usableNetworks = ConcurrentHashMap<Network, NetworkCapabilities>()
    private val started = AtomicBoolean(false)
    private val epochCounter = AtomicLong(0L)
    private val stateLock = Any()

    @Volatile
    private var defaultNetwork: Network? = null

    private val _networkState = MutableStateFlow(NetworkState())
    val networkState: StateFlow<NetworkState> = _networkState.asStateFlow()

    private val _handoffEvents = MutableSharedFlow<NetworkState>(extraBufferCapacity = 16)
    val handoffEvents: SharedFlow<NetworkState> = _handoffEvents.asSharedFlow()

    private fun isUsable(caps: NetworkCapabilities): Boolean = isNetworkUsable(
        hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
        hasValidated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
        hasCaptivePortal = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
    )

    private fun toCandidate(network: Network, caps: NetworkCapabilities): NetworkCandidate =
        NetworkCandidate(
            networkId = network.networkHandle,
            hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            hasValidated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            hasCaptivePortal = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
            hasWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            hasCellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            hasEthernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            hasVpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
            isMetered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
        )

    private val internetCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runCatching { connectivityManager.getNetworkCapabilities(network) }.getOrNull()?.let { caps ->
                if (isUsable(caps)) {
                    usableNetworks[network] = caps
                }
            }
            recomputeState()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            if (isUsable(networkCapabilities)) {
                usableNetworks[network] = networkCapabilities
            } else {
                usableNetworks.remove(network)
            }
            recomputeState()
        }

        override fun onLost(network: Network) {
            usableNetworks.remove(network)
            recomputeState()
        }

        override fun onUnavailable() {
            recomputeState()
        }
    }

    private val defaultCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            defaultNetwork = network
            runCatching { connectivityManager.getNetworkCapabilities(network) }.getOrNull()?.let { caps ->
                if (isUsable(caps)) {
                    usableNetworks[network] = caps
                }
            }
            recomputeState()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            defaultNetwork = network
            if (isUsable(networkCapabilities)) {
                usableNetworks[network] = networkCapabilities
            } else {
                usableNetworks.remove(network)
            }
            recomputeState()
        }

        override fun onLost(network: Network) {
            if (defaultNetwork == network) {
                defaultNetwork = null
            }
            usableNetworks.remove(network)
            recomputeState()
        }
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        runCatching { connectivityManager.registerNetworkCallback(request, internetCallback) }
        runCatching { connectivityManager.registerDefaultNetworkCallback(defaultCallback) }
        seedCurrentNetwork()
    }

    fun stop() {
        if (!started.compareAndSet(true, false)) return
        runCatching { connectivityManager.unregisterNetworkCallback(internetCallback) }
        runCatching { connectivityManager.unregisterNetworkCallback(defaultCallback) }
        usableNetworks.clear()
        defaultNetwork = null
    }

    fun refreshNow(): NetworkState {
        seedCurrentNetwork()
        return _networkState.value
    }

    suspend fun awaitAllowedNetwork(
        allowWifi: () -> Boolean,
        allowCellular: () -> Boolean,
    ): NetworkState {
        val current = _networkState.value
        if (current.isAllowed(allowWifi(), allowCellular())) return current
        return _networkState.first { state ->
            state.isAllowed(allowWifi(), allowCellular())
        }
    }

    private fun seedCurrentNetwork() {
        val active = runCatching { connectivityManager.activeNetwork }.getOrNull()
        defaultNetwork = active
        if (active != null) {
            val caps = runCatching { connectivityManager.getNetworkCapabilities(active) }.getOrNull()
            if (caps != null && isUsable(caps)) {
                usableNetworks[active] = caps
            } else {
                usableNetworks.remove(active)
            }
        }
        recomputeState()
    }

    private fun recomputeState() {
        synchronized(stateLock) {
            val active = runCatching { connectivityManager.activeNetwork }.getOrNull() ?: defaultNetwork
            val activeCandidate = active?.let { network ->
                val caps = runCatching {
                    connectivityManager.getNetworkCapabilities(network)
                }.getOrNull() ?: usableNetworks[network]
                caps?.let { toCandidate(network, it) }
            }
            val trackedCandidates = usableNetworks.entries.map { (net, caps) ->
                toCandidate(net, caps)
            }
            val newStateWithoutEpoch = resolveNetworkState(activeCandidate, trackedCandidates)

            val prev = _networkState.value
            val changed = prev.isConnected != newStateWithoutEpoch.isConnected ||
                prev.transport != newStateWithoutEpoch.transport ||
                prev.activeNetworkId != newStateWithoutEpoch.activeNetworkId ||
                prev.isMetered != newStateWithoutEpoch.isMetered

            if (changed) {
                val epoch = epochCounter.incrementAndGet()
                val updated = newStateWithoutEpoch.copy(epoch = epoch)
                _networkState.value = updated
                if (updated.isConnected) {
                    _handoffEvents.tryEmit(updated)
                }
            }
        }
    }
}
