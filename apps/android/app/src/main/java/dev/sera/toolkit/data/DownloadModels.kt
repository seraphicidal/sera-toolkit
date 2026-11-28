package dev.sera.toolkit.data

import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.SubtitleRequest
import dev.sera.toolkit.model.TrimRequest
import kotlinx.serialization.Serializable

@Serializable
enum class DownloadTaskStatus {
    QUEUED,
    RUNNING,
    FAILED,
    CANCELLED,
    COMPLETED,
}

@Serializable
data class DownloadTaskRecord(
    val id: String,
    val sourceUrl: String,
    val serverUrl: String,
    val title: String,
    val providerLabel: String = "",
    val infoId: String? = null,
    val optionIds: List<String> = emptyList(),
    val selectedItemIndices: List<Int> = emptyList(),
    val selectedKind: MediaKind? = null,
    val selectedQualityLabel: String? = null,
    val packaging: PackagingMode = PackagingMode.AUTO,
    val filename: String? = null,
    val trim: TrimRequest? = null,
    val subtitles: SubtitleRequest? = null,
    val maxItemsPerJob: Int? = null,
    val remoteJobId: String? = null,
    val status: DownloadTaskStatus = DownloadTaskStatus.QUEUED,
    val step: String = "Queued",
    val percent: Int = 0,
    val indeterminate: Boolean = true,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
    val currentFile: Int? = null,
    val totalFiles: Int? = null,
    val error: JobError? = null,
    val createdAtEpochMs: Long = System.currentTimeMillis(),
    val updatedAtEpochMs: Long = System.currentTimeMillis(),
)
