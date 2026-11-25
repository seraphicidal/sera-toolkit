package dev.sera.node.ui

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.runtime.Immutable
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.sera.node.ServiceLocator
import dev.sera.node.data.ConnectionTestResult
import dev.sera.node.data.EnvConfigParser
import dev.sera.node.data.LogEntry
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.ParsedEnvConfig
import dev.sera.node.data.ThemePreference
import dev.sera.node.model.NetworkState
import dev.sera.node.model.NodeRole
import dev.sera.node.service.NodeForegroundService
import dev.sera.node.service.NodeRuntimeSnapshot
import dev.sera.node.updater.UpdateState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

@Immutable
data class SystemPermissionState(
    val ignoringBatteryOptimizations: Boolean = true,
    val canInstallUnknownApps: Boolean = true,
    val hasNotificationPermission: Boolean = true,
)

@Immutable
data class UiSnackbarMessage(
    val text: String,
    val actionLabel: String? = null,
    val isUndoClearLogs: Boolean = false,
)

@Immutable
sealed interface ConnectionTestUiState {
    data object Idle : ConnectionTestUiState
    data object Testing : ConnectionTestUiState
    data class Success(val latencyMs: Long, val message: String) : ConnectionTestUiState
    data class Error(val message: String, val isAuthError: Boolean = false) : ConnectionTestUiState
}

class NodeViewModel(application: Application) : AndroidViewModel(application) {
    private val appContext = application.applicationContext
    private val preferences = ServiceLocator.preferences(appContext)
    private val logStore = ServiceLocator.logStore(appContext)
    private val apiClient = ServiceLocator.apiClient(appContext)
    private val connectivityMonitor = ServiceLocator.connectivityMonitor(appContext)
    private val updateCoordinator = ServiceLocator.updateCoordinator(appContext)
    private val appSelfUpdater = ServiceLocator.appSelfUpdater(appContext)

    val settings: StateFlow<NodeSettings> = preferences.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = NodeSettings(),
    )

    val themePreference: StateFlow<ThemePreference> = preferences.settings
        .map { it.themePreference }
        .distinctUntilChanged()
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = ThemePreference.SYSTEM,
        )

    val snapshot: StateFlow<NodeRuntimeSnapshot> = ServiceLocator.runtimeTracker().snapshot

    val networkState: StateFlow<NetworkState> = connectivityMonitor.networkState

    val updateState: StateFlow<UpdateState> = updateCoordinator.state

    val logs: StateFlow<List<LogEntry>> = logStore.entries

    private val _permissions = MutableStateFlow(readPermissions())
    val permissions: StateFlow<SystemPermissionState> = _permissions.asStateFlow()

    private val _messages = MutableSharedFlow<UiSnackbarMessage>(extraBufferCapacity = 16)
    val messages: SharedFlow<UiSnackbarMessage> = _messages.asSharedFlow()

    private val _connectionTestState = MutableStateFlow<ConnectionTestUiState>(ConnectionTestUiState.Idle)
    val connectionTestState: StateFlow<ConnectionTestUiState> = _connectionTestState.asStateFlow()

    private var connectionTestJob: Job? = null
    private var lastClearedLogs: List<LogEntry> = emptyList()

    init {
        viewModelScope.launch {
            updateCoordinator.refreshToolsStatus()
        }
    }

    fun refreshPermissions() {
        _permissions.value = readPermissions()
    }

    private fun readPermissions(): SystemPermissionState {
        val pm = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        val ignoringBattery = pm.isIgnoringBatteryOptimizations(appContext.packageName)
        val canInstall = appSelfUpdater.canInstallPackages(appContext)
        val hasNotif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        return SystemPermissionState(
            ignoringBatteryOptimizations = ignoringBattery,
            canInstallUnknownApps = canInstall,
            hasNotificationPermission = hasNotif,
        )
    }

    fun startNode() {
        viewModelScope.launch {
            val current = preferences.current()
            if (!current.isConfigured) {
                emitMessage("Configure Server URL and Node Token in Settings first")
                return@launch
            }
            preferences.setServiceEnabled(enabled = true, explicitStop = false)
            NodeForegroundService.start(appContext)
        }
    }

    fun stopNode() {
        viewModelScope.launch {
            preferences.setServiceEnabled(enabled = false, explicitStop = true)
            NodeForegroundService.stop(appContext)
        }
    }

    fun pauseNode() {
        NodeForegroundService.pause(appContext)
    }

    fun resumeNode() {
        NodeForegroundService.resume(appContext)
    }

    fun checkAndInstallAllUpdates() {
        viewModelScope.launch {
            val summary = updateCoordinator.checkAndApplyUpdates(force = true, allowAppInstall = true)
            emitMessage(summary)
        }
    }

    fun forceRefreshTools() {
        viewModelScope.launch {
            val summary = updateCoordinator.forceRefreshTools()
            emitMessage(summary)
        }
    }

    fun setThemePreference(preference: ThemePreference) {
        viewModelScope.launch {
            preferences.setThemePreference(preference)
        }
    }

    fun resetConnectionTest() {
        connectionTestJob?.cancel()
        _connectionTestState.value = ConnectionTestUiState.Idle
    }

    fun testConnection(rawBaseUrl: String, rawToken: String, rawNodeId: String = "") {
        val normalizedUrl = NodeSettings.normalizeBaseUrl(rawBaseUrl)
        val trimmedToken = rawToken.trim()
        val trimmedNodeId = rawNodeId.trim().ifEmpty { null }
        if (normalizedUrl.isBlank() || normalizedUrl.toHttpUrlOrNull() == null) {
            _connectionTestState.value = ConnectionTestUiState.Error("Enter a valid Server URL before testing")
            return
        }
        if (trimmedToken.isBlank()) {
            _connectionTestState.value = ConnectionTestUiState.Error("Enter a Node Token before testing")
            return
        }
        connectionTestJob?.cancel()
        _connectionTestState.value = ConnectionTestUiState.Testing
        connectionTestJob = viewModelScope.launch {
            val result = apiClient.testConnection(normalizedUrl, trimmedToken, trimmedNodeId)
            when (result) {
                is ConnectionTestResult.Success -> {
                    _connectionTestState.value = ConnectionTestUiState.Success(
                        latencyMs = result.latencyMs,
                        message = result.message,
                    )
                    logStore.info("NET", "Connection test succeeded (${result.latencyMs} ms)")
                }

                is ConnectionTestResult.AuthRejected -> {
                    _connectionTestState.value = ConnectionTestUiState.Error(
                        message = result.message,
                        isAuthError = true,
                    )
                    logStore.warn("NET", "Connection test rejected (${result.statusCode})")
                }

                is ConnectionTestResult.Failure -> {
                    _connectionTestState.value = ConnectionTestUiState.Error(
                        message = result.message,
                        isAuthError = false,
                    )
                    logStore.warn("NET", "Connection test failed: ${result.message}")
                }
            }
        }
    }

    fun saveConfiguration(
        apiBaseUrl: String,
        nodeToken: String,
        nodeId: String,
        nodeRole: NodeRole,
        enableYoutube: Boolean,
        enableInstagram: Boolean,
        enableAllProviders: Boolean,
        instagramSessionId: String,
        youtubePlayerClients: String,
        youtubePotProviderUrl: String,
        redditClientId: String,
        redditClientSecret: String,
        allowCellular: Boolean,
        allowWifi: Boolean,
        onlyWhileCharging: Boolean,
        autoStartOnBoot: Boolean,
        autoUpdateApp: Boolean,
        autoUpdateTools: Boolean,
        preferredCapacity: Int,
        githubReleasesRepo: String,
        themePreference: ThemePreference,
    ) {
        viewModelScope.launch {
            preferences.saveConfiguration(
                apiBaseUrl = apiBaseUrl,
                nodeToken = nodeToken,
                nodeId = nodeId,
                nodeRole = nodeRole,
                enableYoutube = enableYoutube,
                enableInstagram = enableInstagram,
                enableAllProviders = enableAllProviders,
                instagramSessionId = instagramSessionId,
                youtubePlayerClients = youtubePlayerClients,
                youtubePotProviderUrl = youtubePotProviderUrl,
                redditClientId = redditClientId,
                redditClientSecret = redditClientSecret,
                allowCellular = allowCellular,
                allowWifi = allowWifi,
                onlyWhileCharging = onlyWhileCharging,
                autoStartOnBoot = autoStartOnBoot,
                autoUpdateApp = autoUpdateApp,
                autoUpdateTools = autoUpdateTools,
                preferredCapacity = preferredCapacity,
                githubReleasesRepo = githubReleasesRepo,
                themePreference = themePreference,
            )
            logStore.info("NODE", "Configuration saved")
            emitMessage("Settings saved")
        }
    }

    suspend fun parseEnvConfigAsync(rawText: String): ParsedEnvConfig =
        withContext(Dispatchers.Default) {
            EnvConfigParser.parse(rawText)
        }

    fun applyImportedEnvConfig(parsed: ParsedEnvConfig) {
        if (parsed.importedFields.isNotEmpty()) {
            viewModelScope.launch {
                preferences.applyImportedEnv(parsed)
                val summary = parsed.importedFields.joinToString(", ")
                logStore.info("NODE", "Imported from .env: $summary")
                emitMessage("Imported: $summary")
            }
        } else {
            emitMessage("No recognized SERA_* keys found")
        }
    }

    fun clearLogsWithUndo() {
        val cleared = logStore.clearAndSnapshot()
        if (cleared.isNotEmpty()) {
            lastClearedLogs = cleared
            _messages.tryEmit(
                UiSnackbarMessage(
                    text = "Cleared ${cleared.size} log entries",
                    actionLabel = "Undo",
                    isUndoClearLogs = true,
                ),
            )
        }
    }

    fun undoClearLogs() {
        val previous = lastClearedLogs
        if (previous.isNotEmpty()) {
            logStore.restore(previous)
            lastClearedLogs = emptyList()
        }
    }

    fun notifyMessage(text: String) {
        emitMessage(text)
    }

    private fun emitMessage(text: String) {
        _messages.tryEmit(UiSnackbarMessage(text = text))
    }

    fun batteryOptimizationIntent(): Intent {
        return Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${appContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun fallbackBatteryOptimizationIntent(): Intent {
        return Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun installUnknownAppsIntent(): Intent = appSelfUpdater.createInstallUnknownAppsIntent(appContext)
}
