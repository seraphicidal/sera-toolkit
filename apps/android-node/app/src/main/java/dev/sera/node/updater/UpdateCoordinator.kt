package dev.sera.node.updater

import android.content.Context
import android.content.Intent
import dev.sera.node.BuildConfig
import dev.sera.node.data.NodeLogStore
import dev.sera.node.data.NodePreferences
import dev.sera.node.data.SeraNodeApiClient
import dev.sera.node.model.AndroidAppUpdateInfo
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.NodeUpdateManifest
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.ToolsVersionInfo
import dev.sera.node.model.YtdlpUpdateInfo
import dev.sera.node.net.ConnectivityMonitor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

data class UpdateState(
    val isChecking: Boolean = false,
    val lastCheckAt: Long = 0L,
    val manifestHash: String? = null,
    val lastResultMessage: String? = null,
    val lastError: String? = null,
    val toolsVersionInfo: ToolsVersionInfo = ToolsVersionInfo(ready = false),
    val availableAppUpdate: AndroidAppUpdateInfo? = null,
    val pendingConfirmIntent: Intent? = null,
    val needsInstallPermission: Boolean = false,
    val apkDownloadProgressPercent: Int? = null,
)

class UpdateCoordinator(
    private val context: Context,
    private val preferences: NodePreferences,
    private val apiClient: SeraNodeApiClient,
    private val toolsManager: ExtractionToolsManager,
    private val appSelfUpdater: AppSelfUpdater,
    private val connectivityMonitor: ConnectivityMonitor,
    private val logStore: NodeLogStore,
) {
    private val checkMutex = Mutex()
    private val _state = MutableStateFlow(UpdateState())
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private val updatesDir = File(context.applicationContext.filesDir, "updates")

    suspend fun refreshToolsStatus() {
        runCatching { toolsManager.ensureReady() }
        val info = runCatching { toolsManager.getToolsVersions() }
            .getOrElse { ToolsVersionInfo(ready = false, error = it.message) }
        val settings = preferences.current()
        _state.update {
            it.copy(
                toolsVersionInfo = info,
                lastCheckAt = maxOf(it.lastCheckAt, settings.lastUpdateCheckAt),
                manifestHash = settings.cachedManifestHash ?: it.manifestHash,
                needsInstallPermission = !appSelfUpdater.canInstallPackages(context),
            )
        }
    }

    suspend fun onManifestHashObserved(observedHash: String) {
        val currentSettings = preferences.current()
        if (observedHash.isNotBlank() && observedHash != currentSettings.cachedManifestHash) {
            logStore.info("UPDATER", "Server manifest hash changed ($observedHash); syncing updates")
            checkAndApplyUpdates(force = false, allowAppInstall = true)
        }
    }

    suspend fun checkAndApplyUpdates(
        force: Boolean,
        allowAppInstall: Boolean = true,
    ): String {
        return checkMutex.withLock {
            val settings = preferences.current()
            val net = connectivityMonitor.refreshNow()
            if (!net.isAllowed(settings.allowWifi, settings.allowCellular)) {
                val msg = "Update skipped: current network disallowed or offline"
                _state.update { it.copy(lastError = msg, isChecking = false) }
                return@withLock msg
            }

            _state.update {
                it.copy(
                    isChecking = true,
                    lastError = null,
                    apkDownloadProgressPercent = null,
                    needsInstallPermission = !appSelfUpdater.canInstallPackages(context),
                )
            }

            try {
                runCatching { toolsManager.ensureReady() }

                val manifest = resolveManifest(settings.apiBaseUrl, settings.nodeToken, settings.githubReleasesRepo)
                if (manifest == null) {
                    val msg = "No update manifest available"
                    logStore.warn("UPDATER", msg)
                    _state.update { it.copy(isChecking = false, lastError = msg) }
                    return@withLock msg
                }

                preferences.saveManifestCache(manifest.manifestHash, manifest.providerConfig)
                val now = System.currentTimeMillis()
                preferences.setLastUpdateCheckAt(now)
                logStore.info("UPDATER", "Applied hot-config manifest ${manifest.manifestHash.take(12)}")

                val summaryParts = mutableListOf<String>()

                if (settings.autoUpdateTools || force) {
                    val toolResult = runCatching {
                        toolsManager.updateYtdlpFromManifest(
                            manifest = manifest.ytdlp,
                            authToken = settings.nodeToken.ifBlank { null },
                            apiBaseUrl = settings.apiBaseUrl.ifBlank { null },
                        )
                    }.getOrElse { error ->
                        logStore.error("UPDATER", "yt-dlp update failed: ${error.message}")
                        null
                    }
                    if (toolResult != null) {
                        summaryParts += toolResult.message
                        logStore.info("UPDATER", toolResult.message)
                    }
                }

                val toolsInfo = runCatching { toolsManager.getToolsVersions() }
                    .getOrElse { ToolsVersionInfo(ready = false, error = it.message) }

                val remoteApp = manifest.androidNodeApp
                var appUpdateInfoForState: AndroidAppUpdateInfo? = null
                if (remoteApp != null && UpdateVersionComparator.isUpdateAvailable(
                        currentVersionCode = BuildConfig.VERSION_CODE,
                        currentVersionName = BuildConfig.VERSION_NAME,
                        candidateVersionCode = remoteApp.versionCode,
                        candidateVersionName = remoteApp.versionName,
                    )
                ) {
                    appUpdateInfoForState = remoteApp
                    if ((settings.autoUpdateApp || force) && allowAppInstall) {
                        val canInstall = appSelfUpdater.canInstallPackages(context)
                        _state.update { it.copy(needsInstallPermission = !canInstall) }
                        if (!canInstall) {
                            val permMsg = "App v${remoteApp.versionName} ready; grant Install Unknown Apps permission"
                            logStore.warn("UPDATER", permMsg)
                            summaryParts += permMsg
                        } else {
                            val outcome = appSelfUpdater.downloadAndVerifyApk(
                                info = remoteApp,
                                apiBaseUrl = settings.apiBaseUrl,
                                authToken = settings.nodeToken,
                                updatesDir = updatesDir,
                            ) { downloaded, total ->
                                val pct = if (total != null && total > 0L) {
                                    ((downloaded * 100L) / total).toInt().coerceIn(0, 100)
                                } else {
                                    null
                                }
                                _state.update { it.copy(apkDownloadProgressPercent = pct) }
                            }
                            when (outcome) {
                                is ApkDownloadOutcome.Verified -> {
                                    val shouldPrompt = force ||
                                        settings.lastAppUpdatePromptVersion < remoteApp.versionCode
                                    if (shouldPrompt) {
                                        val committed = appSelfUpdater.installApkWithPackageInstaller(
                                            context = context,
                                            apkFile = outcome.file,
                                            expectedVersionCode = remoteApp.versionCode,
                                        )
                                        if (committed) {
                                            preferences.setLastAppUpdatePromptVersion(remoteApp.versionCode)
                                            summaryParts += "App update v${remoteApp.versionName} staged"
                                        } else {
                                            summaryParts += "Failed to stage APK v${remoteApp.versionName}"
                                        }
                                    } else {
                                        summaryParts += "App v${remoteApp.versionName} downloaded"
                                    }
                                }

                                is ApkDownloadOutcome.Failed -> {
                                    summaryParts += outcome.reason
                                }
                            }
                        }
                    } else {
                        summaryParts += "App v${remoteApp.versionName} available"
                    }
                } else {
                    summaryParts += "App v${BuildConfig.VERSION_NAME} up to date"
                }

                val summary = summaryParts.joinToString(" • ")
                _state.update {
                    it.copy(
                        isChecking = false,
                        lastCheckAt = now,
                        manifestHash = manifest.manifestHash,
                        lastResultMessage = summary,
                        lastError = null,
                        toolsVersionInfo = toolsInfo,
                        availableAppUpdate = appUpdateInfoForState,
                        apkDownloadProgressPercent = null,
                        needsInstallPermission = !appSelfUpdater.canInstallPackages(context),
                    )
                }
                return@withLock summary
            } catch (error: Exception) {
                val msg = error.message ?: "Update check failed"
                logStore.error("UPDATER", msg)
                _state.update {
                    it.copy(
                        isChecking = false,
                        lastError = msg,
                        apkDownloadProgressPercent = null,
                    )
                }
                return@withLock msg
            }
        }
    }

    suspend fun forceRefreshTools(): String {
        return checkMutex.withLock {
            val settings = preferences.current()
            val net = connectivityMonitor.refreshNow()
            if (!net.isAllowed(settings.allowWifi, settings.allowCellular)) {
                val msg = "Tool refresh skipped: network disallowed or offline"
                _state.update { it.copy(lastError = msg) }
                return@withLock msg
            }
            _state.update { it.copy(isChecking = true, lastError = null) }
            try {
                toolsManager.ensureReady()
                val manifest = resolveManifest(settings.apiBaseUrl, settings.nodeToken, settings.githubReleasesRepo)
                val result = toolsManager.forceRefreshTools(
                    manifest = manifest?.ytdlp,
                    authToken = settings.nodeToken.ifBlank { null },
                    apiBaseUrl = settings.apiBaseUrl.ifBlank { null },
                )
                val info = toolsManager.getToolsVersions()
                logStore.info("UPDATER", "Force refresh tools: ${result.message}")
                _state.update {
                    it.copy(
                        isChecking = false,
                        lastResultMessage = result.message,
                        toolsVersionInfo = info,
                    )
                }
                result.message
            } catch (error: Exception) {
                val msg = error.message ?: "Force refresh failed"
                logStore.error("UPDATER", msg)
                _state.update { it.copy(isChecking = false, lastError = msg) }
                msg
            }
        }
    }

    fun onPendingUserConfirmation(versionCode: Int, confirmIntent: Intent) {
        _state.update {
            it.copy(
                pendingConfirmIntent = confirmIntent,
                lastResultMessage = "Update build $versionCode ready for 1-tap install",
            )
        }
    }

    fun onInstallFinished(success: Boolean, message: String) {
        _state.update {
            it.copy(
                pendingConfirmIntent = null,
                lastResultMessage = if (success) message else it.lastResultMessage,
                lastError = if (success) null else message,
                availableAppUpdate = if (success) null else it.availableAppUpdate,
            )
        }
    }

    private suspend fun resolveManifest(
        apiBaseUrl: String,
        nodeToken: String,
        githubRepo: String,
    ): NodeUpdateManifest? {
        if (apiBaseUrl.isNotBlank() && nodeToken.isNotBlank()) {
            val primary = runCatching {
                apiClient.fetchUpdateManifest(apiBaseUrl, nodeToken)
            }.onFailure { err ->
                logStore.warn("UPDATER", "Primary manifest fetch failed, trying GitHub fallback: ${err.message}")
            }.getOrNull()

            if (primary != null) {
                if (primary.androidNodeApp != null || githubRepo.isBlank()) {
                    return primary
                }
                val ghApp = runCatching {
                    apiClient.fetchGithubLatestAndroidUpdate(githubRepo)
                }.getOrNull()
                return if (ghApp != null) primary.copy(androidNodeApp = ghApp) else primary
            }
        }

        if (githubRepo.isBlank()) return null
        val ghYtdlp: YtdlpUpdateInfo? = runCatching {
            apiClient.fetchGithubYtdlpManifest(githubRepo)
        }.getOrNull()
        val ghApp: AndroidAppUpdateInfo? = runCatching {
            apiClient.fetchGithubLatestAndroidUpdate(githubRepo)
        }.getOrNull()

        if (ghYtdlp == null && ghApp == null) return null

        val fallbackYtdlp = ghYtdlp ?: YtdlpUpdateInfo(
            version = "",
            assetName = "yt-dlp",
            sha256 = null,
            url = "",
            proxyPath = "",
        )
        val cached = preferences.current().cachedProviderHotConfig ?: ProviderHotConfig()
        val hash = Sha256Verifier.computeHex(
            "${fallbackYtdlp.version}:${fallbackYtdlp.sha256.orEmpty()}:${ghApp?.versionCode ?: 0}:${ghApp?.sha256.orEmpty()}".toByteArray(),
        ).take(16)
        return NodeUpdateManifest(
            manifestHash = "gh-$hash",
            generatedAt = "",
            ytdlp = fallbackYtdlp,
            androidNodeApp = ghApp,
            providerConfig = cached,
        )
    }

    companion object {
        const val UPDATE_CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L
    }
}
