package dev.sera.toolkit.worker

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import dev.sera.toolkit.data.DownloadTaskRecord
import dev.sera.toolkit.data.DownloadTaskStatus
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.SeraPreferences
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.SubtitleRequest
import dev.sera.toolkit.model.TrimRequest
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class DownloadCoordinator(
    private val context: Context,
    private val preferences: SeraPreferences,
    private val apiClient: SeraApiClient,
) {
    private val runningJobs = ConcurrentHashMap<String, Job>()
    private val cancelledTaskIds = ConcurrentHashMap.newKeySet<String>()

    val tasks: Flow<List<DownloadTaskRecord>> = preferences.downloadTasks

    internal fun registerRunningTask(taskId: String, job: Job) {
        runningJobs[taskId] = job
    }

    internal fun unregisterRunningTask(taskId: String) {
        runningJobs.remove(taskId)
        cancelledTaskIds.remove(taskId)
    }

    internal fun isTaskCancelledByUser(taskId: String): Boolean {
        return taskId in cancelledTaskIds
    }

    suspend fun enqueueResolved(
        sourceUrl: String,
        info: MediaInfo,
        optionIds: List<String>,
        selectedItemIndices: List<Int>,
        selectedKind: MediaKind?,
        selectedQualityLabel: String?,
        packaging: PackagingMode,
        filename: String?,
        trim: TrimRequest?,
        subtitles: SubtitleRequest?,
        maxItemsPerJob: Int?,
    ): String {
        val settings = preferences.currentSettings()
        val taskId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val record = DownloadTaskRecord(
            id = taskId,
            sourceUrl = sourceUrl,
            serverUrl = settings.serverUrl,
            title = info.title.ifBlank { sourceUrl },
            providerLabel = info.providerLabel,
            infoId = info.id,
            optionIds = optionIds,
            selectedItemIndices = selectedItemIndices,
            selectedKind = selectedKind,
            selectedQualityLabel = selectedQualityLabel,
            packaging = packaging,
            filename = filename?.trim()?.takeIf { it.isNotEmpty() },
            trim = trim,
            subtitles = subtitles,
            maxItemsPerJob = maxItemsPerJob,
            status = DownloadTaskStatus.QUEUED,
            step = "Queued",
            createdAtEpochMs = now,
            updatedAtEpochMs = now,
        )
        preferences.updateDownloadTasks { current -> listOf(record) + current }
        scheduleWorker(wifiOnly = settings.wifiOnly, replaceIfIdle = false)
        return taskId
    }

    suspend fun enqueueQuickUrls(
        urls: List<String>,
        preferredKind: MediaKind? = null,
        maxItemsPerJob: Int? = null,
    ): List<String> {
        if (urls.isEmpty()) return emptyList()
        val settings = preferences.currentSettings()
        val effectiveKind = preferredKind ?: settings.preferredKind
        val now = System.currentTimeMillis()
        val records = urls.mapIndexed { idx, url ->
            DownloadTaskRecord(
                id = UUID.randomUUID().toString(),
                sourceUrl = url,
                serverUrl = settings.serverUrl,
                title = url,
                selectedKind = effectiveKind,
                maxItemsPerJob = maxItemsPerJob,
                status = DownloadTaskStatus.QUEUED,
                step = "Queued",
                createdAtEpochMs = now + idx,
                updatedAtEpochMs = now + idx,
            )
        }
        preferences.updateDownloadTasks { current -> records.reversed() + current }
        scheduleWorker(wifiOnly = settings.wifiOnly, replaceIfIdle = false)
        return records.map { it.id }
    }

    suspend fun cancelTask(taskId: String) {
        cancelledTaskIds.add(taskId)
        val existing = preferences.currentDownloadTasks().firstOrNull { it.id == taskId }
        val activeJob = runningJobs[taskId]
        preferences.updateDownloadTasks { list -> list.filterNot { it.id == taskId } }

        if (activeJob != null) {
            activeJob.cancel()
        } else if (existing?.remoteJobId != null) {
            apiClient.cancelJob(existing.serverUrl, existing.remoteJobId)
        }

        val remainingActive = preferences.currentDownloadTasks().any {
            it.status == DownloadTaskStatus.QUEUED || it.status == DownloadTaskStatus.RUNNING
        }
        if (!remainingActive && runningJobs.isEmpty()) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK_NAME)
        }
    }

    suspend fun retryTask(taskId: String) {
        val settings = preferences.currentSettings()
        val now = System.currentTimeMillis()
        preferences.updateDownloadTasks { list ->
            list.map { task ->
                if (task.id == taskId) {
                    task.copy(
                        serverUrl = settings.serverUrl,
                        infoId = null,
                        optionIds = emptyList(),
                        remoteJobId = null,
                        status = DownloadTaskStatus.QUEUED,
                        step = "Queued",
                        percent = 0,
                        indeterminate = true,
                        speedBytesPerSecond = null,
                        etaSeconds = null,
                        currentFile = null,
                        totalFiles = null,
                        error = null,
                        updatedAtEpochMs = now,
                    )
                } else {
                    task
                }
            }
        }
        scheduleWorker(wifiOnly = settings.wifiOnly, replaceIfIdle = false)
    }

    suspend fun removeTask(taskId: String) {
        preferences.updateDownloadTasks { list -> list.filterNot { it.id == taskId } }
    }

    suspend fun clearFailedTasks() {
        preferences.updateDownloadTasks { list ->
            list.filter { it.status == DownloadTaskStatus.QUEUED || it.status == DownloadTaskStatus.RUNNING }
        }
    }

    suspend fun onWifiOnlyChanged(wifiOnly: Boolean) {
        val hasQueued = preferences.currentDownloadTasks().any { it.status == DownloadTaskStatus.QUEUED }
        if (hasQueued && runningJobs.isEmpty()) {
            scheduleWorker(wifiOnly = wifiOnly, replaceIfIdle = true)
        }
    }

    internal fun scheduleWorker(wifiOnly: Boolean, replaceIfIdle: Boolean) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setConstraints(constraints)
            .build()
        val policy = if (replaceIfIdle) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK_NAME, policy, request)
    }

    companion object {
        const val UNIQUE_WORK_NAME = "sera_download_queue"
    }
}
