package dev.sera.toolkit.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

const val SERA_APP_VERSION = "1.8.0"

@Serializable
enum class MediaKind {
    @SerialName("video")
    VIDEO,
    @SerialName("audio")
    AUDIO,
    @SerialName("image")
    IMAGE,
    @SerialName("gif")
    GIF,
    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
enum class MediaInfoType {
    @SerialName("single")
    SINGLE,
    @SerialName("collection")
    COLLECTION,
    @SerialName("playlist")
    PLAYLIST,
}

@Serializable
enum class JobState {
    @SerialName("queued")
    QUEUED,
    @SerialName("resolving")
    RESOLVING,
    @SerialName("downloading")
    DOWNLOADING,
    @SerialName("merging")
    MERGING,
    @SerialName("converting")
    CONVERTING,
    @SerialName("packaging")
    PACKAGING,
    @SerialName("finalizing")
    FINALIZING,
    @SerialName("ready")
    READY,
    @SerialName("failed")
    FAILED,
    @SerialName("cancelled")
    CANCELLED,
    @SerialName("expired")
    EXPIRED;

    val isTerminal: Boolean
        get() = this == READY || this == FAILED || this == CANCELLED || this == EXPIRED
}

@Serializable
enum class PackagingMode(val wireValue: String, val label: String) {
    @SerialName("auto")
    AUTO("auto", "Automatic"),
    @SerialName("zip")
    ZIP("zip", "One ZIP"),
    @SerialName("individual")
    INDIVIDUAL("individual", "Separate files"),
}

@Serializable
enum class SubtitleFormat(val wireValue: String, val label: String) {
    @SerialName("embed")
    EMBED("embed", "In the video"),
    @SerialName("srt")
    SRT("srt", "SRT file"),
    @SerialName("vtt")
    VTT("vtt", "VTT file"),
}

@Serializable
enum class LegalReportCategory(val wireValue: String, val label: String) {
    @SerialName("copyright")
    COPYRIGHT("copyright", "Copyright Infringement"),
    @SerialName("malware")
    MALWARE("malware", "Malware / Security Threat"),
    @SerialName("illegal_content")
    ILLEGAL_CONTENT("illegal_content", "Illegal Content"),
    @SerialName("other")
    OTHER("other", "Other Policy Violation"),
}

@Serializable
enum class ProviderStatus {
    @SerialName("ok")
    OK,
    @SerialName("degraded")
    DEGRADED,
    @SerialName("unavailable")
    UNAVAILABLE,
}

@Serializable
enum class HealthStatus {
    @SerialName("ok")
    OK,
    @SerialName("degraded")
    DEGRADED,
    @SerialName("error")
    ERROR,
}

@Serializable
enum class HealthCheckStatus {
    @SerialName("ok")
    OK,
    @SerialName("error")
    ERROR,
}

@Serializable
data class DownloadOption(
    val id: String,
    val itemId: String,
    val kind: MediaKind,
    val container: String,
    val label: String,
    val detail: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val fps: Double? = null,
    val audioBitrateKbps: Double? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val filesizeBytes: Long? = null,
    val filesizeIsApproximate: Boolean? = null,
    val requiresConversion: Boolean = false,
    val recommended: Boolean = false,
)

@Serializable
data class SubtitleTrack(
    val lang: String,
    val label: String,
    val auto: Boolean = false,
)

@Serializable
data class MediaItem(
    val id: String,
    val index: Int,
    val kind: MediaKind,
    val title: String? = null,
    val thumbnail: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val container: String? = null,
    val filesizeBytes: Long? = null,
    val isLive: Boolean? = null,
    val subtitles: List<SubtitleTrack>? = null,
    val options: List<DownloadOption> = emptyList(),
)

@Serializable
data class MediaInfo(
    val id: String,
    val provider: String,
    val providerLabel: String,
    val url: String,
    val type: MediaInfoType,
    val title: String,
    val description: String? = null,
    val author: String? = null,
    val authorUrl: String? = null,
    val thumbnail: String? = null,
    val duration: Double? = null,
    val createdAt: String? = null,
    val items: List<MediaItem> = emptyList(),
    val metadata: Map<String, JsonPrimitive>? = null,
    val expiresIn: Long = 0,
)

@Serializable
data class JobProgress(
    val percent: Double = 0.0,
    val bytesDownloaded: Long? = null,
    val bytesTotal: Long? = null,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
    val currentFile: Int? = null,
    val totalFiles: Int? = null,
)

@Serializable
data class JobResultFile(
    val name: String,
    val sizeBytes: Long,
    val mimeType: String,
    val downloadPath: String,
)

@Serializable
data class JobDelivery(
    val backend: String,
    val substituted: List<SubstitutedItem>? = null,
) {
    @Serializable
    data class SubstitutedItem(
        val requested: String,
        val actual: String,
    )
}

@Serializable
data class JobResult(
    val downloadPath: String,
    val filename: String,
    val sizeBytes: Long,
    val mimeType: String,
    val isArchive: Boolean = false,
    val files: List<JobResultFile>? = null,
    val expiresAt: String,
    val delivery: JobDelivery? = null,
)

@Serializable
data class JobError(
    val code: String,
    val message: String,
    val hint: String? = null,
    val retryable: Boolean = false,
)

@Serializable
data class Job(
    val id: String,
    val state: JobState,
    val step: String,
    val progress: JobProgress,
    val provider: String,
    val createdAt: String,
    val updatedAt: String,
    val result: JobResult? = null,
    val error: JobError? = null,
)

@Serializable
data class SseJobEvent(
    val type: String,
    val job: Job? = null,
    val message: String? = null,
)

@Serializable
data class ResolveRequest(
    val url: String,
)

@Serializable
data class TrimRequest(
    val start: String? = null,
    val end: String? = null,
)

data class TrimRange(
    val start: Long,
    val end: Long? = null,
)

@Serializable
data class SubtitleRequest(
    val lang: String,
    val auto: Boolean? = null,
    val format: SubtitleFormat,
    val only: Boolean? = null,
)

@Serializable
data class CreateJobRequest(
    val infoId: String,
    val optionIds: List<String>,
    val packaging: PackagingMode? = null,
    val filename: String? = null,
    val trim: TrimRequest? = null,
    val subtitles: SubtitleRequest? = null,
)

@Serializable
data class ProviderCapabilities(
    val video: Boolean = false,
    val image: Boolean = false,
    val audio: Boolean = false,
    val audioExtraction: Boolean = false,
    val carousel: Boolean = false,
    val gallery: Boolean = false,
    val gif: Boolean = false,
    val live: Boolean = false,
    val authenticatedMode: Boolean = false,
    val requiresOauth: Boolean = false,
    val residentialFallback: Boolean = false,
    val cloudExtraction: Boolean = false,
    val browserImport: Boolean = false,
    val authRequiredFor: List<String>? = null,
)

@Serializable
data class ProviderSummary(
    val id: String,
    val label: String,
    val hosts: List<String> = emptyList(),
    val status: ProviderStatus,
    val capabilities: ProviderCapabilities,
)

@Serializable
data class ServiceLimits(
    val maxFilesizeBytes: Long,
    val maxDurationSeconds: Long,
    val maxItemsPerJob: Int,
    val retentionSeconds: Long,
)

@Serializable
data class ServiceInfo(
    val name: String,
    val version: String,
    val providers: List<ProviderSummary> = emptyList(),
    val limits: ServiceLimits,
)

@Serializable
data class HealthCheck(
    val name: String,
    val status: HealthCheckStatus,
    val detail: String? = null,
)

@Serializable
data class HealthReport(
    val status: HealthStatus,
    val version: String,
    val uptimeSeconds: Double,
    val checks: List<HealthCheck> = emptyList(),
)

@Serializable
data class ApiErrorBody(
    val error: JobError,
)

@Serializable
data class LegalReportRequest(
    val targetUrl: String,
    val category: LegalReportCategory,
    val explanation: String,
    val notifierName: String,
    val notifierOrganization: String? = null,
    val notifierEmail: String,
    val goodFaithConfirmed: Boolean = true,
)

@Serializable
data class LegalReportResponse(
    val reportId: String,
    val receivedAt: String,
    val status: String,
    val mitigated: Boolean? = null,
)

@Serializable
data class ImportedCandidate(
    val url: String? = null,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class ImportedPostNode(
    val id: String? = null,
    val code: String? = null,
    @SerialName("media_type")
    val mediaType: Int? = null,
    @SerialName("carousel_media")
    val carouselMedia: List<ImportedPostNode>? = null,
    @SerialName("image_versions2")
    val imageVersions2: ImageVersions? = null,
    @SerialName("video_versions")
    val videoVersions: List<ImportedCandidate>? = null,
    @SerialName("video_duration")
    val videoDuration: Double? = null,
    @SerialName("accessibility_caption")
    val accessibilityCaption: String? = null,
    val user: ImportedUser? = null,
    val caption: ImportedCaption? = null,
) {
    @Serializable
    data class ImageVersions(val candidates: List<ImportedCandidate>? = null)

    @Serializable
    data class ImportedUser(val username: String? = null, @SerialName("full_name") val fullName: String? = null)

    @Serializable
    data class ImportedCaption(val text: String? = null)
}

@Serializable
data class ImportRequest(
    val url: String,
    val node: ImportedPostNode,
)

object ErrorCodes {
    const val INVALID_URL = "INVALID_URL"
    const val PROVIDER_AUTH_REQUIRED = "PROVIDER_AUTH_REQUIRED"
    const val EXPIRED = "EXPIRED"
    const val NETWORK_ERROR = "NETWORK_ERROR"
    const val INTERNAL = "INTERNAL"
    const val CANCELLED = "CANCELLED"
}

val SUBTITLE_EMBED_CONTAINERS = setOf("mp4", "mkv", "webm")
const val MAX_URL_LENGTH = 2048
const val MAX_FILENAME_LENGTH = 200
const val MAX_SELECTED_ITEMS = 25
