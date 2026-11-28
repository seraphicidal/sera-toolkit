package dev.sera.toolkit.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.sera.toolkit.BuildConfig
import dev.sera.toolkit.R
import dev.sera.toolkit.SeraApplication
import dev.sera.toolkit.data.DownloadTaskRecord
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.SeraApiException
import dev.sera.toolkit.data.ThemePreference
import dev.sera.toolkit.data.UpdateCheckResult
import dev.sera.toolkit.data.UserSettings
import dev.sera.toolkit.domain.HealthModel
import dev.sera.toolkit.domain.HealthObservation
import dev.sera.toolkit.domain.HealthState
import dev.sera.toolkit.domain.HistoryEntry
import dev.sera.toolkit.domain.ResolvedSelection
import dev.sera.toolkit.domain.SelectionLogic
import dev.sera.toolkit.domain.ShareUrlParser
import dev.sera.toolkit.domain.SubtitleChoices
import dev.sera.toolkit.domain.TrimSummary
import dev.sera.toolkit.domain.TrimValidator
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.HealthReport
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.MAX_SELECTED_ITEMS
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.MediaItem
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.ServiceInfo
import dev.sera.toolkit.model.SubtitleFormat
import dev.sera.toolkit.model.SubtitleRequest
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
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
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeUiState(
    val urlInput: String = "",
    val analyzing: Boolean = false,
    val analyzedUrl: String? = null,
    val mediaInfo: MediaInfo? = null,
    val selectedIds: Set<String> = emptySet(),
    val selectedKind: MediaKind = MediaKind.VIDEO,
    val selectedLabel: String? = null,
    val packaging: PackagingMode = PackagingMode.AUTO,
    val filename: String = "",
    val trimStart: String = "",
    val trimEnd: String = "",
    val subtitleTrack: String = "",
    val subtitleFormat: SubtitleFormat = SubtitleFormat.EMBED,
    val subtitlesOnly: Boolean = false,
    val showAdvanced: Boolean = false,
    val error: JobError? = null,
    val batchUrls: List<String> = emptyList(),
) {
    val activeKinds: List<MediaKind>
        get() = mediaInfo?.let { SelectionLogic.availableKinds(it, selectedIds) }.orEmpty()

    val effectiveKind: MediaKind
        get() = if (selectedKind in activeKinds) selectedKind else activeKinds.firstOrNull() ?: selectedKind

    val activeLabels: List<String>
        get() = mediaInfo?.let { SelectionLogic.qualityLabels(it, effectiveKind, selectedIds) }.orEmpty()

    val effectiveLabel: String?
        get() = selectedLabel?.takeIf { it in activeLabels }
            ?: mediaInfo?.let { SelectionLogic.preferredLabelForKind(it, effectiveKind, selectedIds) }
            ?: activeLabels.firstOrNull()

    val selection: ResolvedSelection?
        get() = mediaInfo?.let { SelectionLogic.resolveSelection(it, selectedIds, effectiveKind, effectiveLabel) }

    val singleItem: MediaItem?
        get() {
            val info = mediaInfo ?: return null
            val resolved = selection ?: return null
            if (resolved.fileCount != 1) return null
            val firstOpt = resolved.optionIds.firstOrNull()
            return info.items.firstOrNull { item -> item.options.any { it.id == firstOpt } }
                ?: info.items.firstOrNull { it.id in selectedIds }
        }

    val singleOption
        get() = singleItem?.options?.firstOrNull { it.id == selection?.optionIds?.firstOrNull() }

    val subtitleChoices: SubtitleChoices?
        get() = SelectionLogic.subtitleChoices(singleItem, singleOption)

    val canTrim: Boolean
        get() {
            val item = singleItem ?: return false
            val kind = singleOption?.kind ?: effectiveKind
            return item.id.isNotEmpty() && (kind == MediaKind.VIDEO || kind == MediaKind.AUDIO)
        }

    val rawTrimSummary: TrimSummary
        get() = if (canTrim && singleItem != null) {
            TrimValidator.summarizeTrim(
                start = trimStart,
                end = trimEnd,
                durationSeconds = singleItem?.duration,
                totalBytes = selection?.totalBytes,
            )
        } else {
            TrimSummary.None
        }

    val rawSubtitlesRequest: SubtitleRequest?
        get() = SelectionLogic.subtitleRequest(
            choices = subtitleChoices,
            value = subtitleTrack,
            format = subtitleFormat,
            only = subtitlesOnly,
        )

    val effectiveSubtitlesRequest: SubtitleRequest?
        get() = if (rawTrimSummary != TrimSummary.None) null else rawSubtitlesRequest

    val effectiveTrimSummary: TrimSummary
        get() = if (effectiveSubtitlesRequest != null) TrimSummary.None else rawTrimSummary
}

sealed interface ConnectionTestState {
    data object Idle : ConnectionTestState
    data object Testing : ConnectionTestState
    data class Success(
        val health: HealthReport,
        val serviceInfo: ServiceInfo,
    ) : ConnectionTestState
    data class Failure(val error: JobError) : ConnectionTestState
}

sealed interface UpdateCheckState {
    data object Idle : UpdateCheckState
    data object Checking : UpdateCheckState
    data class Completed(val result: UpdateCheckResult) : UpdateCheckState
}

data class SnackbarEvent(
    val message: String,
    val openDownloadsAction: Boolean = false,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as SeraApplication
    private val preferences = app.preferences
    private val apiClient = app.apiClient
    private val downloadCoordinator = app.downloadCoordinator
    private val updateChecker = app.updateChecker

    val settings: StateFlow<UserSettings> = preferences.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = UserSettings(),
    )

    val tasks: StateFlow<List<DownloadTaskRecord>> = downloadCoordinator.tasks.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = emptyList(),
    )

    val history: StateFlow<List<HistoryEntry>> = preferences.history.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = emptyList(),
    )

    private val _healthState = MutableStateFlow(HealthState())
    val healthState: StateFlow<HealthState> = _healthState.asStateFlow()

    private val _serviceInfo = MutableStateFlow<ServiceInfo?>(null)
    val serviceInfo: StateFlow<ServiceInfo?> = _serviceInfo.asStateFlow()

    private val _homeState = MutableStateFlow(HomeUiState())
    val homeState: StateFlow<HomeUiState> = _homeState.asStateFlow()

    private val _connectionTestState = MutableStateFlow<ConnectionTestState>(ConnectionTestState.Idle)
    val connectionTestState: StateFlow<ConnectionTestState> = _connectionTestState.asStateFlow()

    private val _updateCheckState = MutableStateFlow<UpdateCheckState>(UpdateCheckState.Idle)
    val updateCheckState: StateFlow<UpdateCheckState> = _updateCheckState.asStateFlow()

    private val _snackbarEvents = MutableSharedFlow<SnackbarEvent>(extraBufferCapacity = 8)
    val snackbarEvents: SharedFlow<SnackbarEvent> = _snackbarEvents.asSharedFlow()

    private var analyzeJob: Job? = null
    private var statusJob: Job? = null

    val maxItemsPerJob: Int
        get() = _serviceInfo.value?.limits?.maxItemsPerJob?.coerceIn(1, 200) ?: MAX_SELECTED_ITEMS

    init {
        viewModelScope.launch {
            preferences.settings
                .map { it.serverUrl }
                .distinctUntilChanged()
                .collect { serverUrl ->
                    refreshServerStatus(serverUrl)
                }
        }
    }

    fun refreshServerStatus(serverUrl: String = settings.value.serverUrl) {
        statusJob?.cancel()
        statusJob = viewModelScope.launch {
            val healthDeferred = async {
                runCatching { apiClient.fetchHealth(serverUrl) }
            }
            val infoDeferred = async {
                runCatching { apiClient.fetchServiceInfo(serverUrl) }
            }
            val healthResult = healthDeferred.await()
            val infoResult = infoDeferred.await()

            _healthState.update { current ->
                healthResult.fold(
                    onSuccess = { HealthModel.nextHealth(current, HealthObservation.Ok(it)) },
                    onFailure = { HealthModel.nextHealth(current, HealthObservation.Failed) },
                )
            }
            infoResult.onSuccess { loaded ->
                _serviceInfo.value = loaded
                clampSelectionToLimit(loaded.limits.maxItemsPerJob)
            }
        }
    }

    private fun clampSelectionToLimit(limit: Int) {
        val clampedLimit = limit.coerceIn(1, 200)
        _homeState.update { state ->
            val info = state.mediaInfo ?: return@update state
            if (state.selectedIds.size <= clampedLimit) return@update state
            val clamped = LinkedHashSet<String>()
            for (item in info.items) {
                if (item.id in state.selectedIds) {
                    clamped.add(item.id)
                    if (clamped.size >= clampedLimit) break
                }
            }
            state.copy(selectedIds = clamped)
        }
    }

    fun updateUrlInput(value: String) {
        _homeState.update { state ->
            if (state.mediaInfo != null || state.error != null || state.analyzing) {
                analyzeJob?.cancel()
                HomeUiState(urlInput = value)
            } else {
                state.copy(urlInput = value, batchUrls = if (value.isBlank()) emptyList() else state.batchUrls)
            }
        }
    }

    fun pasteUrl(rawClipboard: String?) {
        val trimmed = rawClipboard?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            emitSnackbar(app.getString(R.string.home_clipboard_empty))
            return
        }
        val urls = ShareUrlParser.extractCleanUrls(listOf(trimmed))
        if (urls.size > 1) {
            _homeState.update {
                HomeUiState(
                    urlInput = urls.first(),
                    batchUrls = urls,
                )
            }
            analyzeUrl(urls.first(), keepBatch = urls)
        } else {
            val chosen = urls.firstOrNull() ?: trimmed
            _homeState.update { HomeUiState(urlInput = chosen) }
            if (urls.size == 1) {
                analyzeUrl(chosen)
            }
        }
    }

    fun clearHome() {
        analyzeJob?.cancel()
        _homeState.value = HomeUiState()
    }

    fun dismissError() {
        _homeState.update { it.copy(error = null) }
    }

    fun analyzeCurrentUrl() {
        val raw = _homeState.value.urlInput
        val urls = ShareUrlParser.extractCleanUrls(listOf(raw))
        if (urls.isEmpty()) {
            _homeState.update {
                it.copy(
                    error = JobError(
                        code = ErrorCodes.INVALID_URL,
                        message = app.getString(R.string.home_no_url_entered),
                        retryable = false,
                    ),
                )
            }
            return
        }
        if (urls.size > 1) {
            analyzeUrl(urls.first(), keepBatch = urls)
        } else {
            analyzeUrl(urls.first())
        }
    }

    private fun analyzeUrl(cleanUrl: String, keepBatch: List<String> = emptyList()) {
        analyzeJob?.cancel()
        analyzeJob = viewModelScope.launch {
            val serverUrl = settings.value.serverUrl
            _homeState.update {
                HomeUiState(
                    urlInput = cleanUrl,
                    analyzing = true,
                    analyzedUrl = cleanUrl,
                    batchUrls = keepBatch,
                )
            }
            try {
                val resolved = apiClient.resolveMedia(serverUrl, cleanUrl)
                val limit = maxItemsPerJob
                val selectedIds = SelectionLogic.selectItemsUpToMax(resolved.items, limit)
                val available = SelectionLogic.availableKinds(resolved, selectedIds)
                val preferred = settings.value.preferredKind
                val startingKind = if (preferred != null && preferred in available) {
                    preferred
                } else {
                    SelectionLogic.initialKind(resolved)
                }
                val startingLabel = SelectionLogic.preferredLabelForKind(resolved, startingKind, selectedIds)
                _homeState.update {
                    it.copy(
                        analyzing = false,
                        analyzedUrl = cleanUrl,
                        mediaInfo = resolved,
                        selectedIds = selectedIds,
                        selectedKind = startingKind,
                        selectedLabel = startingLabel,
                        error = null,
                    )
                }
            } catch (e: SeraApiException) {
                _homeState.update {
                    it.copy(
                        analyzing = false,
                        error = e.apiError,
                    )
                }
            } catch (_: Exception) {
                _homeState.update {
                    it.copy(
                        analyzing = false,
                        error = JobError(
                            code = ErrorCodes.INTERNAL,
                            message = "Could not analyze this link.",
                            retryable = true,
                        ),
                    )
                }
            }
        }
    }

    fun selectKind(kind: MediaKind) {
        _homeState.update { state ->
            val info = state.mediaInfo ?: return@update state
            val label = SelectionLogic.preferredLabelForKind(info, kind, state.selectedIds)
            state.copy(
                selectedKind = kind,
                selectedLabel = label,
            )
        }
        viewModelScope.launch {
            preferences.setPreferredKind(kind)
        }
    }

    fun selectLabel(label: String) {
        _homeState.update { it.copy(selectedLabel = label) }
    }

    fun toggleItem(itemId: String) {
        val limit = maxItemsPerJob
        _homeState.update { state ->
            val next = LinkedHashSet(state.selectedIds)
            if (itemId in next) {
                next.remove(itemId)
            } else if (next.size < limit) {
                next.add(itemId)
            }
            updateSelectedIds(state, next)
        }
    }

    fun selectItems(ids: Set<String>) {
        _homeState.update { state -> updateSelectedIds(state, ids) }
    }

    private fun updateSelectedIds(state: HomeUiState, nextIds: Set<String>): HomeUiState {
        val prevSingleId = state.singleItem?.id
        val updated = state.copy(selectedIds = nextIds)
        val nextSingleId = updated.singleItem?.id
        return if (prevSingleId != nextSingleId) {
            updated.copy(
                trimStart = "",
                trimEnd = "",
                subtitleTrack = "",
                subtitlesOnly = false,
            )
        } else {
            updated
        }
    }

    fun updatePackaging(packaging: PackagingMode) {
        _homeState.update { it.copy(packaging = packaging) }
    }

    fun updateFilename(filename: String) {
        _homeState.update { it.copy(filename = filename) }
    }

    fun toggleAdvanced() {
        _homeState.update { it.copy(showAdvanced = !it.showAdvanced) }
    }

    fun updateTrimStart(value: String) {
        _homeState.update { state ->
            if (value.isNotBlank()) {
                state.copy(trimStart = value, subtitleTrack = "", subtitlesOnly = false)
            } else {
                state.copy(trimStart = value)
            }
        }
    }

    fun updateTrimEnd(value: String) {
        _homeState.update { state ->
            if (value.isNotBlank()) {
                state.copy(trimEnd = value, subtitleTrack = "", subtitlesOnly = false)
            } else {
                state.copy(trimEnd = value)
            }
        }
    }

    fun updateSubtitleTrack(value: String) {
        _homeState.update { state ->
            state.copy(
                subtitleTrack = value,
                subtitlesOnly = if (value.isEmpty()) false else state.subtitlesOnly,
                trimStart = if (value.isNotEmpty()) "" else state.trimStart,
                trimEnd = if (value.isNotEmpty()) "" else state.trimEnd,
            )
        }
    }

    fun updateSubtitleFormat(format: SubtitleFormat) {
        _homeState.update { state ->
            state.copy(
                subtitleFormat = format,
                subtitlesOnly = if (format == SubtitleFormat.EMBED) false else state.subtitlesOnly,
            )
        }
    }

    fun updateSubtitlesOnly(only: Boolean) {
        _homeState.update { it.copy(subtitlesOnly = only) }
    }

    fun enqueueCurrentSelection() {
        val state = _homeState.value
        val info = state.mediaInfo ?: return
        val selection = state.selection
        if (selection == null || selection.optionIds.isEmpty()) {
            _homeState.update {
                it.copy(
                    error = JobError(
                        code = ErrorCodes.VALIDATION_ERROR,
                        message = app.getString(R.string.picker_select_at_least_one),
                        retryable = false,
                    ),
                )
            }
            return
        }
        val trim = state.effectiveTrimSummary
        if (trim is TrimSummary.Invalid) {
            _homeState.update {
                it.copy(
                    showAdvanced = true,
                    error = JobError(
                        code = ErrorCodes.VALIDATION_ERROR,
                        message = trim.message,
                        retryable = false,
                    ),
                )
            }
            return
        }

        val selectedIndices = info.items
            .filter { it.id in state.selectedIds }
            .map { it.index }
        val cleanSourceUrl = state.analyzedUrl ?: ShareUrlParser.stripTrackingParams(info.url)

        viewModelScope.launch {
            downloadCoordinator.enqueueResolved(
                sourceUrl = cleanSourceUrl,
                info = info,
                optionIds = selection.optionIds,
                selectedItemIndices = selectedIndices,
                selectedKind = state.effectiveKind,
                selectedQualityLabel = state.effectiveLabel,
                packaging = state.packaging,
                filename = state.filename,
                trim = (trim as? TrimSummary.Valid)?.request,
                subtitles = state.effectiveSubtitlesRequest,
                maxItemsPerJob = _serviceInfo.value?.limits?.maxItemsPerJob,
            )
            emitSnackbar(app.getString(R.string.home_download_started), openDownloadsAction = true)
        }
    }

    fun enqueueBatchUrls() {
        val urls = _homeState.value.batchUrls
        if (urls.isEmpty()) return
        viewModelScope.launch {
            downloadCoordinator.enqueueQuickUrls(
                urls = urls,
                preferredKind = settings.value.preferredKind,
                maxItemsPerJob = _serviceInfo.value?.limits?.maxItemsPerJob,
            )
            _homeState.update { it.copy(batchUrls = emptyList()) }
            emitSnackbar(
                app.getString(R.string.home_batch_queued, urls.size),
                openDownloadsAction = true,
            )
        }
    }

    fun cancelDownload(taskId: String) {
        viewModelScope.launch {
            downloadCoordinator.cancelTask(taskId)
        }
    }

    fun retryDownload(taskId: String) {
        viewModelScope.launch {
            downloadCoordinator.retryTask(taskId)
        }
    }

    fun removeFailedTask(taskId: String) {
        viewModelScope.launch {
            downloadCoordinator.removeTask(taskId)
        }
    }

    fun removeHistoryEntry(jobId: String) {
        viewModelScope.launch {
            preferences.removeHistoryEntry(jobId)
        }
    }

    fun clearHistory() {
        viewModelScope.launch {
            preferences.clearHistory()
            downloadCoordinator.clearFailedTasks()
        }
    }

    fun saveServerUrl(rawUrl: String) {
        viewModelScope.launch {
            preferences.setServerUrl(rawUrl)
            _connectionTestState.value = ConnectionTestState.Idle
            emitSnackbar(app.getString(R.string.settings_saved_url))
        }
    }

    fun resetServerUrl() {
        viewModelScope.launch {
            preferences.resetServerUrl()
            _connectionTestState.value = ConnectionTestState.Idle
            emitSnackbar(app.getString(R.string.settings_reset_url))
        }
    }

    fun testConnection(rawUrl: String) {
        val target = SeraApiClient.normalizeBaseUrl(rawUrl)
        viewModelScope.launch {
            _connectionTestState.value = ConnectionTestState.Testing
            try {
                val healthDeferred = async { apiClient.fetchHealth(target) }
                val infoDeferred = async { apiClient.fetchServiceInfo(target) }
                val health = healthDeferred.await()
                val info = infoDeferred.await()
                _connectionTestState.value = ConnectionTestState.Success(health, info)
            } catch (e: SeraApiException) {
                _connectionTestState.value = ConnectionTestState.Failure(e.apiError)
            } catch (_: Exception) {
                _connectionTestState.value = ConnectionTestState.Failure(
                    JobError(
                        code = ErrorCodes.NETWORK_ERROR,
                        message = "Could not connect to server.",
                        hint = "Check the URL and try again.",
                        retryable = true,
                    ),
                )
            }
        }
    }

    fun setThemePreference(preference: ThemePreference) {
        viewModelScope.launch {
            preferences.setThemePreference(preference)
        }
    }

    fun setPreferredKind(kind: MediaKind?) {
        viewModelScope.launch {
            preferences.setPreferredKind(kind)
        }
    }

    fun setQuickDownload(enabled: Boolean) {
        viewModelScope.launch {
            preferences.setQuickDownload(enabled)
        }
    }

    fun setWifiOnly(enabled: Boolean) {
        viewModelScope.launch {
            preferences.setWifiOnly(enabled)
            downloadCoordinator.onWifiOnlyChanged(enabled)
        }
    }

    fun markNotificationsPrompted() {
        viewModelScope.launch {
            preferences.setNotificationsPrompted(true)
        }
    }

    fun checkForUpdates() {
        viewModelScope.launch {
            _updateCheckState.value = UpdateCheckState.Checking
            val result = updateChecker.checkForUpdates(
                currentVersionName = BuildConfig.VERSION_NAME,
                currentVersionCode = BuildConfig.VERSION_CODE,
            )
            _updateCheckState.value = UpdateCheckState.Completed(result)
        }
    }

    fun emitSnackbar(message: String, openDownloadsAction: Boolean = false) {
        _snackbarEvents.tryEmit(SnackbarEvent(message, openDownloadsAction))
    }
}
