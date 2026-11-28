package dev.sera.toolkit.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.sera.toolkit.SeraApplication
import dev.sera.toolkit.data.SeraApiException
import dev.sera.toolkit.data.UserSettings
import dev.sera.toolkit.domain.ResolvedSelection
import dev.sera.toolkit.domain.SelectionLogic
import dev.sera.toolkit.domain.ShareUrlParser
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.MAX_SELECTED_ITEMS
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.ServiceInfo
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface ShareUiState {
    data object Initializing : ShareUiState
    data class QuickPending(val urls: List<String>) : ShareUiState
    data class NoUrlFound(val receivedPreview: String) : ShareUiState
    data class MultipleUrls(
        val urls: List<String>,
        val preferredKind: MediaKind?,
        val nodesOffline: Boolean = false,
    ) : ShareUiState
    data class SingleResolving(
        val url: String,
        val nodesOffline: Boolean = false,
    ) : ShareUiState
    data class SingleError(
        val url: String,
        val error: JobError,
        val nodesOffline: Boolean = false,
    ) : ShareUiState
    data class SingleReady(
        val sourceUrl: String,
        val serverUrl: String,
        val info: MediaInfo,
        val selectedIds: Set<String>,
        val selectedKind: MediaKind,
        val selectedLabel: String?,
        val packaging: PackagingMode = PackagingMode.AUTO,
        val maxItems: Int = MAX_SELECTED_ITEMS,
        val nodesOffline: Boolean = false,
    ) : ShareUiState {
        val activeKinds: List<MediaKind>
            get() = SelectionLogic.availableKinds(info, selectedIds)

        val effectiveKind: MediaKind
            get() = if (selectedKind in activeKinds) selectedKind else activeKinds.firstOrNull() ?: selectedKind

        val activeLabels: List<String>
            get() = SelectionLogic.qualityLabels(info, effectiveKind, selectedIds)

        val effectiveLabel: String?
            get() = selectedLabel?.takeIf { it in activeLabels }
                ?: SelectionLogic.preferredLabelForKind(info, effectiveKind, selectedIds)
                ?: activeLabels.firstOrNull()

        val selection: ResolvedSelection
            get() = SelectionLogic.resolveSelection(info, selectedIds, effectiveKind, effectiveLabel)
    }
}

class ShareViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as SeraApplication
    private val preferences = app.preferences
    private val apiClient = app.apiClient
    private val downloadCoordinator = app.downloadCoordinator

    val settings: StateFlow<UserSettings> = preferences.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = UserSettings(),
    )

    private val _uiState = MutableStateFlow<ShareUiState>(ShareUiState.Initializing)
    val uiState: StateFlow<ShareUiState> = _uiState.asStateFlow()

    private var serviceInfo: ServiceInfo? = null
    private var resolveJob: Job? = null

    fun handleIncomingTexts(texts: List<String?>) {
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val currentSettings = preferences.currentSettings()
            val extracted = ShareUrlParser.extractFromIntentTexts(texts)
            val cleaned = extracted.map(ShareUrlParser::stripTrackingParams).distinct()

            if (cleaned.isEmpty()) {
                val preview = texts
                    .filterNotNull()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .joinToString("\n")
                    .take(240)
                _uiState.value = ShareUiState.NoUrlFound(preview)
                return@launch
            }

            if (currentSettings.quickDownload) {
                _uiState.value = ShareUiState.QuickPending(cleaned)
                return@launch
            }

            if (cleaned.size > 1) {
                _uiState.value = ShareUiState.MultipleUrls(
                    urls = cleaned,
                    preferredKind = currentSettings.preferredKind,
                )
                fetchServiceInfoQuietly(currentSettings.serverUrl)
                return@launch
            }

            resolveSingleUrl(cleaned.first(), currentSettings)
        }
    }

    fun retrySingle() {
        val current = _uiState.value as? ShareUiState.SingleError ?: return
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val currentSettings = preferences.currentSettings()
            resolveSingleUrl(current.url, currentSettings)
        }
    }

    private suspend fun fetchServiceInfoQuietly(serverUrl: String) {
        val loaded = runCatching { apiClient.fetchServiceInfo(serverUrl) }.getOrNull() ?: return
        serviceInfo = loaded
        val offline = loaded.nodeAvailability?.enabled == true && loaded.nodeAvailability.healthyNodes == 0
        _uiState.update { state ->
            when (state) {
                is ShareUiState.MultipleUrls -> state.copy(nodesOffline = offline)
                is ShareUiState.SingleResolving -> state.copy(nodesOffline = offline)
                is ShareUiState.SingleError -> state.copy(nodesOffline = offline)
                is ShareUiState.SingleReady -> state.copy(
                    nodesOffline = offline,
                    maxItems = loaded.limits.maxItemsPerJob.coerceIn(1, 200),
                )
                else -> state
            }
        }
    }

    private suspend fun resolveSingleUrl(url: String, currentSettings: UserSettings) {
        val serverUrl = currentSettings.serverUrl
        val initiallyOffline = serviceInfo?.nodeAvailability?.let { it.enabled && it.healthyNodes == 0 } ?: false
        _uiState.value = ShareUiState.SingleResolving(url = url, nodesOffline = initiallyOffline)

        val infoDeferred = viewModelScope.async {
            runCatching { apiClient.fetchServiceInfo(serverUrl) }.getOrNull()
        }

        try {
            val resolved = apiClient.resolveMedia(serverUrl, url)
            val fetchedServiceInfo = infoDeferred.await() ?: serviceInfo
            serviceInfo = fetchedServiceInfo
            val maxItems = fetchedServiceInfo?.limits?.maxItemsPerJob?.coerceIn(1, 200) ?: MAX_SELECTED_ITEMS
            val nodesOffline = fetchedServiceInfo?.nodeAvailability?.let { it.enabled && it.healthyNodes == 0 } ?: false
            val selectedIds = SelectionLogic.selectItemsUpToMax(resolved.items, maxItems)
            val available = SelectionLogic.availableKinds(resolved, selectedIds)
            val preferred = currentSettings.preferredKind
            val kind = if (preferred != null && preferred in available) {
                preferred
            } else {
                SelectionLogic.initialKind(resolved)
            }
            val label = SelectionLogic.preferredLabelForKind(resolved, kind, selectedIds)
            _uiState.value = ShareUiState.SingleReady(
                sourceUrl = url,
                serverUrl = serverUrl,
                info = resolved,
                selectedIds = selectedIds,
                selectedKind = kind,
                selectedLabel = label,
                maxItems = maxItems,
                nodesOffline = nodesOffline,
            )
        } catch (e: SeraApiException) {
            val fetchedServiceInfo = infoDeferred.await() ?: serviceInfo
            serviceInfo = fetchedServiceInfo
            val nodesOffline = fetchedServiceInfo?.nodeAvailability?.let { it.enabled && it.healthyNodes == 0 } ?: false
            _uiState.value = ShareUiState.SingleError(
                url = url,
                error = e.apiError,
                nodesOffline = nodesOffline,
            )
        } catch (_: Exception) {
            _uiState.value = ShareUiState.SingleError(
                url = url,
                error = JobError(
                    code = ErrorCodes.INTERNAL,
                    message = "Could not analyze this link.",
                    retryable = true,
                ),
            )
        }
    }

    fun selectSingleKind(kind: MediaKind) {
        _uiState.update { state ->
            if (state !is ShareUiState.SingleReady) return@update state
            val label = SelectionLogic.preferredLabelForKind(state.info, kind, state.selectedIds)
            state.copy(selectedKind = kind, selectedLabel = label)
        }
    }

    fun selectSingleLabel(label: String) {
        _uiState.update { state ->
            if (state !is ShareUiState.SingleReady) return@update state
            state.copy(selectedLabel = label)
        }
    }

    fun toggleSingleItem(itemId: String) {
        _uiState.update { state ->
            if (state !is ShareUiState.SingleReady) return@update state
            val next = LinkedHashSet(state.selectedIds)
            if (itemId in next) {
                next.remove(itemId)
            } else if (next.size < state.maxItems) {
                next.add(itemId)
            }
            state.copy(selectedIds = next)
        }
    }

    fun selectSingleItems(ids: Set<String>) {
        _uiState.update { state ->
            if (state !is ShareUiState.SingleReady) return@update state
            state.copy(selectedIds = ids)
        }
    }

    fun selectSinglePackaging(packaging: PackagingMode) {
        _uiState.update { state ->
            if (state !is ShareUiState.SingleReady) return@update state
            state.copy(packaging = packaging)
        }
    }

    fun selectMultiKind(kind: MediaKind?) {
        _uiState.update { state ->
            if (state !is ShareUiState.MultipleUrls) return@update state
            state.copy(preferredKind = kind)
        }
    }

    fun markNotificationsPrompted() {
        viewModelScope.launch {
            preferences.setNotificationsPrompted(true)
        }
    }

    suspend fun enqueueQuick(urls: List<String>) {
        val currentSettings = preferences.currentSettings()
        downloadCoordinator.enqueueQuickUrls(
            urls = urls,
            preferredKind = currentSettings.preferredKind,
            maxItemsPerJob = serviceInfo?.limits?.maxItemsPerJob,
        )
    }

    suspend fun enqueueMultiple(urls: List<String>, kind: MediaKind?) {
        downloadCoordinator.enqueueQuickUrls(
            urls = urls,
            preferredKind = kind,
            maxItemsPerJob = serviceInfo?.limits?.maxItemsPerJob,
        )
    }

    suspend fun enqueueSingleReady(state: ShareUiState.SingleReady): Boolean {
        val selection = state.selection
        if (selection.optionIds.isEmpty()) return false
        val selectedIndices = state.info.items
            .filter { it.id in state.selectedIds }
            .map { it.index }
        downloadCoordinator.enqueueResolved(
            sourceUrl = state.sourceUrl,
            info = state.info,
            optionIds = selection.optionIds,
            selectedItemIndices = selectedIndices,
            selectedKind = state.effectiveKind,
            selectedQualityLabel = state.effectiveLabel,
            packaging = state.packaging,
            filename = null,
            trim = null,
            subtitles = null,
            maxItemsPerJob = serviceInfo?.limits?.maxItemsPerJob,
        )
        return true
    }
}
