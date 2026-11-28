package dev.sera.toolkit.worker

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import dev.sera.toolkit.SeraApplication
import dev.sera.toolkit.data.DeviceDownloadManager
import dev.sera.toolkit.data.DownloadTaskRecord
import dev.sera.toolkit.data.DownloadTaskStatus
import dev.sera.toolkit.domain.DeviceFileSaver
import dev.sera.toolkit.domain.DownloadPipeline
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.domain.HistoryEntry
import dev.sera.toolkit.domain.PipelineProgress
import dev.sera.toolkit.domain.PipelineResult
import dev.sera.toolkit.domain.SavedMediaFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

class DownloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as SeraApplication
        val preferences = app.preferences
        val apiClient = app.apiClient
        val downloadManager = app.downloadManager
        val coordinator = app.downloadCoordinator

        val pipeline = DownloadPipeline(
            apiClient = apiClient,
            fileSaver = DeviceFileSaver { baseUrl, downloadPath, filename, mimeType, expectedSizeBytes, onProgress ->
                val saved = downloadManager.downloadAndSave(
                    baseUrl = baseUrl,
                    downloadPath = downloadPath,
                    filename = filename,
                    mimeType = mimeType,
                    expectedSizeBytes = expectedSizeBytes,
                    onProgress = onProgress,
                )
                SavedMediaFile(
                    uriString = saved.uri.toString(),
                    filename = saved.filename,
                    mimeType = saved.mimeType,
                    sizeBytes = saved.sizeBytes,
                )
            },
        )

        preferences.updateDownloadTasks { tasks ->
            tasks.map { task ->
                if (task.status == DownloadTaskStatus.RUNNING) {
                    task.copy(status = DownloadTaskStatus.QUEUED, step = "Queued")
                } else {
                    task
                }
            }
        }

        while (true) {
            val nextTask = preferences.currentDownloadTasks()
                .filter { it.status == DownloadTaskStatus.QUEUED }
                .minByOrNull { it.createdAtEpochMs }
                ?: break

            runCatching {
                setForeground(
                    buildForegroundInfo(
                        downloadManager = downloadManager,
                        taskId = nextTask.id,
                        title = nextTask.title,
                        statusText = nextTask.step,
                        percent = 0,
                        indeterminate = true,
                    ),
                )
            }

            preferences.updateDownloadTasks { tasks ->
                tasks.map { task ->
                    if (task.id == nextTask.id) {
                        task.copy(
                            status = DownloadTaskStatus.RUNNING,
                            step = "Starting…",
                            percent = 0,
                            indeterminate = true,
                            updatedAtEpochMs = System.currentTimeMillis(),
                        )
                    } else {
                        task
                    }
                }
            }

            var workerCancelled = false
            try {
                executeSingleTask(
                    task = nextTask,
                    pipeline = pipeline,
                    app = app,
                )
            } catch (e: CancellationException) {
                if (!coordinator.isTaskCancelledByUser(nextTask.id)) {
                    workerCancelled = true
                    withContext(NonCancellable) {
                        preferences.updateDownloadTasks { tasks ->
                            tasks.map { task ->
                                if (task.id == nextTask.id && task.status == DownloadTaskStatus.RUNNING) {
                                    task.copy(
                                        status = DownloadTaskStatus.QUEUED,
                                        step = "Waiting for connection…",
                                        updatedAtEpochMs = System.currentTimeMillis(),
                                    )
                                } else {
                                    task
                                }
                            }
                        }
                    }
                }
                if (workerCancelled) {
                    return Result.retry()
                }
            }
        }

        return Result.success()
    }

    private suspend fun executeSingleTask(
        task: DownloadTaskRecord,
        pipeline: DownloadPipeline,
        app: SeraApplication,
    ) {
        val preferences = app.preferences
        val downloadManager = app.downloadManager
        val coordinator = app.downloadCoordinator
        var lastUpdateAt = 0L
        var lastPercent = -1
        var lastStep = ""

        var outcome: PipelineResult? = null
        coroutineScope {
            val childJob = launch {
                outcome = pipeline.execute(task) { progress ->
                    val now = System.currentTimeMillis()
                    val stepChanged = progress.step != lastStep
                    val pctChanged = progress.percent != lastPercent
                    if (!stepChanged && !pctChanged && now - lastUpdateAt < 300L) {
                        return@execute
                    }
                    lastUpdateAt = now
                    lastPercent = progress.percent
                    lastStep = progress.step

                    preferences.updateDownloadTasks { tasks ->
                        tasks.map { existing ->
                            if (existing.id == task.id) {
                                existing.copy(
                                    remoteJobId = progress.remoteJobId ?: existing.remoteJobId,
                                    title = progress.title?.ifBlank { existing.title } ?: existing.title,
                                    providerLabel = progress.providerLabel?.ifBlank { existing.providerLabel }
                                        ?: existing.providerLabel,
                                    step = progress.step,
                                    percent = progress.percent,
                                    indeterminate = progress.indeterminate,
                                    speedBytesPerSecond = progress.speedBytesPerSecond,
                                    etaSeconds = progress.etaSeconds,
                                    currentFile = progress.currentFile,
                                    totalFiles = progress.totalFiles,
                                    updatedAtEpochMs = now,
                                )
                            } else {
                                existing
                            }
                        }
                    }

                    val statusLine = formatNotificationStatus(progress)
                    runCatching {
                        setForeground(
                            buildForegroundInfo(
                                downloadManager = downloadManager,
                                taskId = task.id,
                                title = progress.title ?: task.title,
                                statusText = statusLine,
                                percent = progress.percent,
                                indeterminate = progress.indeterminate,
                            ),
                        )
                    }
                }
            }
            coordinator.registerRunningTask(task.id, childJob)
            try {
                childJob.join()
            } finally {
                coordinator.unregisterRunningTask(task.id)
            }
        }

        when (val result = outcome) {
            is PipelineResult.Completed -> {
                val totalBytes = result.files.sumOf { it.sizeBytes }
                val entry = HistoryEntry(
                    jobId = result.jobId,
                    title = result.title,
                    source = result.providerLabel,
                    url = task.sourceUrl,
                    filename = result.primaryFile.filename,
                    downloadPath = result.downloadPath,
                    savedAt = Instant.now().toString(),
                    expiresAt = result.expiresAt,
                    localUri = result.primaryFile.uriString,
                    mimeType = result.primaryFile.mimeType,
                    sizeBytes = totalBytes,
                    fileCount = result.files.size,
                )
                preferences.addHistoryEntry(entry)
                preferences.updateDownloadTasks { tasks -> tasks.filterNot { it.id == task.id } }
                downloadManager.postCompletionNotification(
                    taskId = task.id,
                    title = result.title,
                    fileCount = result.files.size,
                    uri = android.net.Uri.parse(result.primaryFile.uriString),
                    mimeType = result.primaryFile.mimeType,
                )
            }
            is PipelineResult.Failed -> {
                preferences.updateDownloadTasks { tasks ->
                    tasks.map { existing ->
                        if (existing.id == task.id) {
                            existing.copy(
                                remoteJobId = result.remoteJobId ?: existing.remoteJobId,
                                status = DownloadTaskStatus.FAILED,
                                step = "Failed",
                                speedBytesPerSecond = null,
                                etaSeconds = null,
                                error = result.error,
                                updatedAtEpochMs = System.currentTimeMillis(),
                            )
                        } else {
                            existing
                        }
                    }
                }
                downloadManager.postFailureNotification(
                    taskId = task.id,
                    title = task.title,
                    message = result.error.message,
                    hint = result.error.hint,
                )
            }
            null -> Unit
        }
    }

    private fun buildForegroundInfo(
        downloadManager: DeviceDownloadManager,
        taskId: String,
        title: String,
        statusText: String,
        percent: Int,
        indeterminate: Boolean,
    ): ForegroundInfo {
        val notification = downloadManager.buildProgressNotification(
            taskId = taskId,
            title = title,
            statusText = statusText,
            percent = percent,
            indeterminate = indeterminate,
        )
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                DeviceDownloadManager.PROGRESS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(
                DeviceDownloadManager.PROGRESS_NOTIFICATION_ID,
                notification,
            )
        }
    }

    private fun formatNotificationStatus(progress: PipelineProgress): String {
        val parts = mutableListOf(progress.step)
        if (!progress.indeterminate && progress.percent in 1..100) {
            parts.add("${progress.percent}%")
        }
        val speed = Formatters.formatSpeed(progress.speedBytesPerSecond)
        if (speed.isNotEmpty()) {
            parts.add(speed)
        }
        val eta = Formatters.formatEta(progress.etaSeconds)
        if (eta.isNotEmpty()) {
            parts.add(eta)
        }
        return parts.joinToString(" · ")
    }
}
