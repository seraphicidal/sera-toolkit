package dev.sera.toolkit.domain

import dev.sera.toolkit.data.DownloadExpiredException
import dev.sera.toolkit.data.DownloadHttpException
import dev.sera.toolkit.data.DownloadTaskRecord
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.SeraApiException
import dev.sera.toolkit.data.TransferProgress
import dev.sera.toolkit.model.CreateJobRequest
import dev.sera.toolkit.model.ErrorCodes
import dev.sera.toolkit.model.Job
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.JobState
import dev.sera.toolkit.model.MediaInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.math.roundToInt

data class SavedMediaFile(
    val uriString: String,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
)

fun interface DeviceFileSaver {
    suspend fun saveFile(
        baseUrl: String,
        downloadPath: String,
        filename: String,
        mimeType: String,
        expectedSizeBytes: Long?,
        onProgress: suspend (TransferProgress) -> Unit,
    ): SavedMediaFile
}

data class PipelineProgress(
    val remoteJobId: String? = null,
    val title: String? = null,
    val providerLabel: String? = null,
    val step: String,
    val percent: Int = 0,
    val indeterminate: Boolean = true,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
    val currentFile: Int? = null,
    val totalFiles: Int? = null,
)

sealed interface PipelineResult {
    data class Completed(
        val jobId: String,
        val title: String,
        val providerLabel: String,
        val primaryFile: SavedMediaFile,
        val files: List<SavedMediaFile>,
        val downloadPath: String,
        val expiresAt: String,
    ) : PipelineResult

    data class Failed(
        val error: JobError,
        val remoteJobId: String?,
    ) : PipelineResult
}

class DownloadPipeline(
    private val apiClient: SeraApiClient,
    private val fileSaver: DeviceFileSaver,
) {
    suspend fun execute(
        task: DownloadTaskRecord,
        onProgress: suspend (PipelineProgress) -> Unit = {},
    ): PipelineResult {
        val baseUrl = task.serverUrl
        var currentTitle = task.title
        var currentProvider = task.providerLabel
        var activeInfoId = task.infoId
        var activeOptionIds = task.optionIds
        var activeRemoteJobId: String? = null
        var recoveredOnce = false

        try {
            while (true) {
                if (activeInfoId.isNullOrBlank() || activeOptionIds.isEmpty()) {
                    onProgress(
                        PipelineProgress(
                            title = currentTitle,
                            providerLabel = currentProvider,
                            step = if (recoveredOnce) "Refreshing link…" else "Resolving link…",
                            indeterminate = true,
                        ),
                    )
                    val resolved = apiClient.resolveMedia(baseUrl, task.sourceUrl)
                    currentTitle = resolved.title.ifBlank { currentTitle }
                    currentProvider = resolved.providerLabel.ifBlank { currentProvider }
                    val pickedOptions = pickOptionsForTask(resolved, task)
                    if (pickedOptions.isEmpty()) {
                        return PipelineResult.Failed(
                            error = JobError(
                                code = ErrorCodes.MEDIA_UNAVAILABLE,
                                message = "No downloadable format was available for this link.",
                                retryable = false,
                            ),
                            remoteJobId = activeRemoteJobId,
                        )
                    }
                    activeInfoId = resolved.id
                    activeOptionIds = pickedOptions
                }

                onProgress(
                    PipelineProgress(
                        title = currentTitle,
                        providerLabel = currentProvider,
                        step = "Starting download…",
                        indeterminate = true,
                    ),
                )

                val createRequest = CreateJobRequest(
                    infoId = activeInfoId,
                    optionIds = activeOptionIds,
                    packaging = task.packaging,
                    filename = task.filename?.trim()?.takeIf { it.isNotEmpty() },
                    trim = task.trim,
                    subtitles = task.subtitles,
                )

                val createdJob = try {
                    apiClient.createJob(baseUrl, createRequest)
                } catch (e: SeraApiException) {
                    if (!recoveredOnce && isRecoverableExpiry(e)) {
                        recoveredOnce = true
                        activeInfoId = null
                        activeOptionIds = emptyList()
                        continue
                    }
                    return PipelineResult.Failed(e.apiError, activeRemoteJobId)
                }

                activeRemoteJobId = createdJob.id
                if (currentProvider.isBlank()) {
                    currentProvider = createdJob.provider
                }

                var terminalJob: Job = createdJob
                apiClient.observeJob(baseUrl, createdJob.id, createdJob).collect { job ->
                    terminalJob = job
                    val pct = job.progress.percent.roundToInt().coerceIn(0, 100)
                    onProgress(
                        PipelineProgress(
                            remoteJobId = job.id,
                            title = currentTitle,
                            providerLabel = currentProvider,
                            step = job.step.ifBlank { stepFallback(job.state) },
                            percent = pct,
                            indeterminate = pct <= 0 && !job.state.isTerminal,
                            speedBytesPerSecond = job.progress.speedBytesPerSecond,
                            etaSeconds = job.progress.etaSeconds,
                            currentFile = job.progress.currentFile,
                            totalFiles = job.progress.totalFiles,
                        ),
                    )
                }

                if (shouldRecoverJob(terminalJob) && !recoveredOnce) {
                    recoveredOnce = true
                    activeInfoId = null
                    activeOptionIds = emptyList()
                    activeRemoteJobId = null
                    continue
                }

                if (terminalJob.state != JobState.READY) {
                    val failureError = terminalJob.error ?: JobError(
                        code = if (terminalJob.state == JobState.EXPIRED) ErrorCodes.EXPIRED else ErrorCodes.INTERNAL,
                        message = if (terminalJob.state == JobState.EXPIRED) {
                            "That download has expired."
                        } else {
                            "The download failed."
                        },
                        retryable = true,
                    )
                    return PipelineResult.Failed(failureError, activeRemoteJobId)
                }

                val result = terminalJob.result ?: return PipelineResult.Failed(
                    error = JobError(
                        code = ErrorCodes.INTERNAL,
                        message = "The server finished without providing a download file.",
                        retryable = true,
                    ),
                    remoteJobId = activeRemoteJobId,
                )

                val savedFiles = try {
                    downloadResultFiles(
                        baseUrl = baseUrl,
                        job = terminalJob,
                        title = currentTitle,
                        providerLabel = currentProvider,
                        onProgress = onProgress,
                    )
                } catch (_: DownloadExpiredException) {
                    if (!recoveredOnce) {
                        recoveredOnce = true
                        activeInfoId = null
                        activeOptionIds = emptyList()
                        activeRemoteJobId = null
                        continue
                    }
                    return PipelineResult.Failed(
                        error = JobError(
                            code = ErrorCodes.EXPIRED,
                            message = "That download has expired.",
                            hint = "Your network connection may have changed. Try again.",
                            retryable = true,
                        ),
                        remoteJobId = activeRemoteJobId,
                    )
                }

                val primary = savedFiles.first()
                return PipelineResult.Completed(
                    jobId = terminalJob.id,
                    title = currentTitle.ifBlank { primary.filename },
                    providerLabel = currentProvider.ifBlank { terminalJob.provider },
                    primaryFile = primary,
                    files = savedFiles,
                    downloadPath = result.downloadPath,
                    expiresAt = result.expiresAt,
                )
            }
        } catch (e: CancellationException) {
            withContext(NonCancellable) {
                activeRemoteJobId?.let { apiClient.cancelJob(baseUrl, it) }
            }
            throw e
        } catch (e: SeraApiException) {
            return PipelineResult.Failed(e.apiError, activeRemoteJobId)
        } catch (e: DownloadHttpException) {
            return PipelineResult.Failed(
                error = JobError(
                    code = if (e.statusCode == 429) ErrorCodes.RATE_LIMITED else ErrorCodes.INTERNAL,
                    message = e.message ?: "Download failed (HTTP ${e.statusCode}).",
                    retryable = e.statusCode >= 500 || e.statusCode == 429,
                ),
                remoteJobId = activeRemoteJobId,
            )
        } catch (e: IOException) {
            return PipelineResult.Failed(
                error = JobError(
                    code = ErrorCodes.NETWORK_ERROR,
                    message = e.message ?: "The download connection was interrupted.",
                    hint = "Check your connection and try again.",
                    retryable = true,
                ),
                remoteJobId = activeRemoteJobId,
            )
        } catch (e: Exception) {
            return PipelineResult.Failed(
                error = JobError(
                    code = ErrorCodes.INTERNAL,
                    message = e.message ?: "Something went wrong while saving the file.",
                    retryable = true,
                ),
                remoteJobId = activeRemoteJobId,
            )
        }
    }

    private suspend fun downloadResultFiles(
        baseUrl: String,
        job: Job,
        title: String,
        providerLabel: String,
        onProgress: suspend (PipelineProgress) -> Unit,
    ): List<SavedMediaFile> {
        val result = requireNotNull(job.result)
        val individualFiles = result.files?.takeIf { !result.isArchive && it.size > 1 }
        if (individualFiles != null) {
            val saved = mutableListOf<SavedMediaFile>()
            val totalCount = individualFiles.size
            for ((index, file) in individualFiles.withIndex()) {
                val fileNumber = index + 1
                val savedFile = fileSaver.saveFile(
                    baseUrl = baseUrl,
                    downloadPath = file.downloadPath,
                    filename = file.name,
                    mimeType = file.mimeType,
                    expectedSizeBytes = file.sizeBytes.takeIf { it > 0L },
                ) { transfer ->
                    onProgress(
                        PipelineProgress(
                            remoteJobId = job.id,
                            title = title,
                            providerLabel = providerLabel,
                            step = "Saving file $fileNumber of $totalCount…",
                            percent = transfer.percent,
                            indeterminate = transfer.totalBytes <= 0L,
                            speedBytesPerSecond = transfer.speedBytesPerSecond,
                            etaSeconds = transfer.etaSeconds,
                            currentFile = fileNumber,
                            totalFiles = totalCount,
                        ),
                    )
                }
                saved.add(savedFile)
            }
            return saved
        }

        val savedFile = fileSaver.saveFile(
            baseUrl = baseUrl,
            downloadPath = result.downloadPath,
            filename = result.filename,
            mimeType = result.mimeType,
            expectedSizeBytes = result.sizeBytes.takeIf { it > 0L },
        ) { transfer ->
            onProgress(
                PipelineProgress(
                    remoteJobId = job.id,
                    title = title,
                    providerLabel = providerLabel,
                    step = "Saving to device…",
                    percent = transfer.percent,
                    indeterminate = transfer.totalBytes <= 0L,
                    speedBytesPerSecond = transfer.speedBytesPerSecond,
                    etaSeconds = transfer.etaSeconds,
                ),
            )
        }
        return listOf(savedFile)
    }

    private fun pickOptionsForTask(info: MediaInfo, task: DownloadTaskRecord): List<String> {
        val targetItems = if (task.selectedItemIndices.isNotEmpty()) {
            val indexSet = task.selectedItemIndices.toSet()
            info.items.filter { it.index in indexSet }.ifEmpty { info.items }
        } else {
            val selectedIds = SelectionLogic.selectItemsUpToMax(info.items, task.maxItemsPerJob)
            info.items.filter { it.id in selectedIds }
        }
        val limit = task.maxItemsPerJob?.takeIf { it > 0 } ?: Int.MAX_VALUE
        val cappedItems = targetItems.take(limit)
        return cappedItems.mapNotNull { item ->
            SelectionLogic.optionForItem(item, task.selectedKind, task.selectedQualityLabel)?.id
        }
    }

    private fun isRecoverableExpiry(exception: SeraApiException): Boolean {
        val code = exception.apiError.code
        return code == ErrorCodes.EXPIRED ||
            code == ErrorCodes.NOT_FOUND ||
            exception.httpStatus == 404 ||
            exception.httpStatus == 410
    }

    private fun shouldRecoverJob(job: Job): Boolean {
        if (job.state == JobState.EXPIRED) return true
        if (job.state == JobState.FAILED) {
            val code = job.error?.code
            return code == ErrorCodes.EXPIRED || code == ErrorCodes.NOT_FOUND
        }
        return false
    }

    private fun stepFallback(state: JobState): String = when (state) {
        JobState.QUEUED -> "Queued"
        JobState.RESOLVING -> "Resolving…"
        JobState.DOWNLOADING -> "Downloading…"
        JobState.MERGING -> "Merging streams…"
        JobState.CONVERTING -> "Converting…"
        JobState.PACKAGING -> "Packaging…"
        JobState.FINALIZING -> "Finalizing…"
        JobState.READY -> "Ready"
        JobState.FAILED -> "Failed"
        JobState.CANCELLED -> "Cancelled"
        JobState.EXPIRED -> "Expired"
        JobState.UNKNOWN -> "Working…"
    }
}
