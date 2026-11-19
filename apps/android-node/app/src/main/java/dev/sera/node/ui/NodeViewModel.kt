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
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.sera.node.ServiceLocator
import dev.sera.node.data.EnvConfigParser
import dev.sera.node.data.LogEntry
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.ParsedEnvConfig
import dev.sera.node.data.ThemePreference
import dev.sera.node.service.NodeForegroundService
import dev.sera.node.service.NodeRuntimeSnapshot
import dev.sera.node.updater.UpdateState
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class SystemPermissionState(
    val ignoringBatteryOptimizations: Boolean = true,
    val canInstallUnknownApps: Boolean = true,
    val hasNotificationPermission: Boolean = true,
)

class NodeViewModel(application: Application) : AndroidViewModel(application) {
    private val appContext = application.applicationContext
    private val preferences = ServiceLocator.preferences(appContext)
    private val logStore = ServiceLocator.logStore(appContext)
    private val updateCoordinator = ServiceLocator.updateCoordinator(appContext)
    private val appSelfUpdater = ServiceLocator.appSelfUpdater(appContext)

    val settings: StateFlow<NodeSettings> = preferences.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = NodeSettings(),
    )

    val snapshot: StateFlow<NodeRuntimeSnapshot> = ServiceLocator.runtimeTracker().snapshot

    val updateState: StateFlow<UpdateState> = updateCoordinator.state

    val logs: StateFlow<List<LogEntry>> = logStore.entries

    private val _permissions = MutableStateFlow(readPermissions())
    val permissions: StateFlow<SystemPermissionState> = _permissions.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

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
                _messages.tryEmit("Configure Server URL and Node Token in Settings first")
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
            _messages.tryEmit(summary)
        }
    }

    fun forceRefreshTools() {
        viewModelScope.launch {
            val summary = updateCoordinator.forceRefreshTools()
            _messages.tryEmit(summary)
        }
    }

    fun saveConfiguration(
        apiBaseUrl: String,
        nodeToken: String,
        nodeId: String,
        enableYoutube: Boolean,
        enableInstagram: Boolean,
        instagramSessionId: String,
        youtubePlayerClients: String,
        youtubePotProviderUrl: String,
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
                enableYoutube = enableYoutube,
                enableInstagram = enableInstagram,
                instagramSessionId = instagramSessionId,
                youtubePlayerClients = youtubePlayerClients,
                youtubePotProviderUrl = youtubePotProviderUrl,
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
            _messages.tryEmit("Settings saved")
        }
    }

    fun importEnvConfig(rawText: String): ParsedEnvConfig {
        val parsed = EnvConfigParser.parse(rawText)
        if (parsed.importedFields.isNotEmpty()) {
            viewModelScope.launch {
                preferences.applyImportedEnv(parsed)
                logStore.info("NODE", "Imported from .env: ${parsed.importedFields.joinToString(", ")}")
                _messages.tryEmit("Imported: ${parsed.importedFields.joinToString(", ")}")
            }
        } else {
            _messages.tryEmit("No recognized SERA_* keys found")
        }
        return parsed
    }

    fun clearLogs() {
        logStore.clear()
    }

    fun exportLogsText(): String = logStore.exportText()

    fun batteryOptimizationIntent(): Intent {
        return Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${appContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun installUnknownAppsIntent(): Intent = appSelfUpdater.createInstallUnknownAppsIntent(appContext)
}
