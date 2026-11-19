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
): NetworkTransport {
    if (!isConnected) return NetworkTransport.NONE
    return when {
        hasWifi -> NetworkTransport.WIFI
        hasCellular -> NetworkTransport.CELLULAR
        hasEthernet -> NetworkTransport.OTHER
        else -> NetworkTransport.OTHER
    }
}

class ConnectivityMonitor(context: Context) {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val validatedNetworks = ConcurrentHashMap<Network, NetworkCapabilities>()
    private val started = AtomicBoolean(false)
    private val epochCounter = AtomicLong(0L)
    private val stateLock = Any()

    @Volatile
    private var defaultNetwork: Network? = null

    private val _networkState = MutableStateFlow(NetworkState())
    val networkState: StateFlow<NetworkState> = _networkState.asStateFlow()

    private val _handoffEvents = MutableSharedFlow<NetworkState>(extraBufferCapacity = 16)
    val handoffEvents: SharedFlow<NetworkState> = _handoffEvents.asSharedFlow()

    private val validatedCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            connectivityManager.getNetworkCapabilities(network)?.let { caps ->
                validatedNetworks[network] = caps
            }
            recomputeState()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            validatedNetworks[network] = networkCapabilities
            recomputeState()
        }

        override fun onLost(network: Network) {
            validatedNetworks.remove(network)
            recomputeState()
        }

        override fun onUnavailable() {
            recomputeState()
        }
    }

    private val defaultCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            defaultNetwork = network
            connectivityManager.getNetworkCapabilities(network)?.let { caps ->
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                ) {
                    validatedNetworks[network] = caps
                }
            }
            recomputeState()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            defaultNetwork = network
            if (networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            ) {
                validatedNetworks[network] = networkCapabilities
            } else {
                validatedNetworks.remove(network)
            }
            recomputeState()
        }

        override fun onLost(network: Network) {
            if (defaultNetwork == network) {
                defaultNetwork = null
            }
            validatedNetworks.remove(network)
            recomputeState()
        }
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        runCatching { connectivityManager.registerNetworkCallback(request, validatedCallback) }
        runCatching { connectivityManager.registerDefaultNetworkCallback(defaultCallback) }
        seedCurrentNetwork()
    }

    fun stop() {
        if (!started.compareAndSet(true, false)) return
        runCatching { connectivityManager.unregisterNetworkCallback(validatedCallback) }
        runCatching { connectivityManager.unregisterNetworkCallback(defaultCallback) }
        validatedNetworks.clear()
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
        val active = connectivityManager.activeNetwork
        defaultNetwork = active
        if (active != null) {
            val caps = connectivityManager.getNetworkCapabilities(active)
            if (caps != null &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            ) {
                validatedNetworks[active] = caps
            }
        }
        recomputeState()
    }

    private fun recomputeState() {
        synchronized(stateLock) {
            val active = connectivityManager.activeNetwork ?: defaultNetwork
            val activeCaps = active?.let { network ->
                validatedNetworks[network] ?: connectivityManager.getNetworkCapabilities(network)?.takeIf { caps ->
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                }
            }

            val selectedPair: Pair<Network, NetworkCapabilities>? = when {
                active != null && activeCaps != null -> active to activeCaps
                else -> validatedNetworks.entries.firstOrNull()?.let { it.key to it.value }
            }

            val newStateWithoutEpoch = if (selectedPair == null) {
                NetworkState(
                    isConnected = false,
                    transport = NetworkTransport.NONE,
                    isMetered = false,
                    activeNetworkId = 0L,
                )
            } else {
                val (net, caps) = selectedPair
                val hasWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                val hasCellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                val hasEthernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                val transport = classifyNetworkTransport(
                    hasWifi = hasWifi,
                    hasCellular = hasCellular,
                    hasEthernet = hasEthernet,
                    isConnected = true,
                )
                val isMetered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                NetworkState(
                    isConnected = true,
                    transport = transport,
                    isMetered = isMetered,
                    activeNetworkId = net.networkHandle,
                )
            }

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
