package dev.sera.toolkit.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

const val SERA_APP_VERSION = "1.8.0"

val SeraJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = false
    coerceInputValues = true
}

open class FallbackEnumSerializer<T : Enum<T>>(
    serialName: String,
    values: Iterable<T>,
    private val wireValue: (T) -> String,
    private val fallback: T,
) : KSerializer<T> {
    private val byWire: Map<String, T> = values.associateBy { wireValue(it) }

    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: T) {
        encoder.encodeString(wireValue(value))
    }

    override fun deserialize(decoder: Decoder): T {
        val raw = decoder.decodeString()
        return byWire[raw] ?: fallback
    }
}

object MediaKindSerializer : FallbackEnumSerializer<MediaKind>(
    serialName = "dev.sera.toolkit.model.MediaKind",
    values = MediaKind.entries,
    wireValue = { it.wireValue },
    fallback = MediaKind.UNKNOWN,
)

@Serializable(with = MediaKindSerializer::class)
enum class MediaKind(val wireValue: String) {
    @SerialName("video")
    VIDEO("video"),
    @SerialName("audio")
    AUDIO("audio"),
    @SerialName("image")
    IMAGE("image"),
    @SerialName("gif")
    GIF("gif"),
    @SerialName("file")
    FILE("file"),
    @SerialName("unknown")
    UNKNOWN("unknown"),
}

object MediaInfoTypeSerializer : FallbackEnumSerializer<MediaInfoType>(
    serialName = "dev.sera.toolkit.model.MediaInfoType",
    values = MediaInfoType.entries,
    wireValue = { it.wireValue },
    fallback = MediaInfoType.UNKNOWN,
)

@Serializable(with = MediaInfoTypeSerializer::class)
enum class MediaInfoType(val wireValue: String) {
    @SerialName("single")
    SINGLE("single"),
    @SerialName("collection")
    COLLECTION("collection"),
    @SerialName("playlist")
    PLAYLIST("playlist"),
    @SerialName("unknown")
    UNKNOWN("unknown"),
}

object JobStateSerializer : FallbackEnumSerializer<JobState>(
    serialName = "dev.sera.toolkit.model.JobState",
    values = JobState.entries,
    wireValue = { it.wireValue },
    fallback = JobState.UNKNOWN,
)

@Serializable(with = JobStateSerializer::class)
enum class JobState(val wireValue: String) {
    @SerialName("queued")
    QUEUED("queued"),
    @SerialName("resolving")
    RESOLVING("resolving"),
    @SerialName("downloading")
    DOWNLOADING("downloading"),
    @SerialName("merging")
    MERGING("merging"),
    @SerialName("converting")
    CONVERTING("converting"),
    @SerialName("packaging")
    PACKAGING("packaging"),
    @SerialName("finalizing")
    FINALIZING("finalizing"),
    @SerialName("ready")
    READY("ready"),
    @SerialName("failed")
    FAILED("failed"),
    @SerialName("cancelled")
    CANCELLED("cancelled"),
    @SerialName("expired")
    EXPIRED("expired"),
    @SerialName("unknown")
    UNKNOWN("unknown");

    val isTerminal: Boolean
        get() = this == READY || this == FAILED || this == CANCELLED || this == EXPIRED
}

object PackagingModeSerializer : FallbackEnumSerializer<PackagingMode>(
    serialName = "dev.sera.toolkit.model.PackagingMode",
    values = PackagingMode.entries,
    wireValue = { it.wireValue },
    fallback = PackagingMode.AUTO,
)

@Serializable(with = PackagingModeSerializer::class)
enum class PackagingMode(val wireValue: String, val label: String) {
    @SerialName("auto")
    AUTO("auto", "Automatic"),
    @SerialName("zip")
    ZIP("zip", "One ZIP"),
    @SerialName("individual")
    INDIVIDUAL("individual", "Separate files"),
}

object SubtitleFormatSerializer : FallbackEnumSerializer<SubtitleFormat>(
    serialName = "dev.sera.toolkit.model.SubtitleFormat",
    values = SubtitleFormat.entries,
    wireValue = { it.wireValue },
    fallback = SubtitleFormat.SRT,
)

@Serializable(with = SubtitleFormatSerializer::class)
enum class SubtitleFormat(val wireValue: String, val label: String) {
    @SerialName("embed")
    EMBED("embed", "In the video"),
    @SerialName("srt")
    SRT("srt", "SRT file"),
    @SerialName("vtt")
    VTT("vtt", "VTT file"),
}

object LegalReportCategorySerializer : FallbackEnumSerializer<LegalReportCategory>(
    serialName = "dev.sera.toolkit.model.LegalReportCategory",
    values = LegalReportCategory.entries,
    wireValue = { it.wireValue },
    fallback = LegalReportCategory.OTHER,
)

@Serializable(with = LegalReportCategorySerializer::class)
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

object ProviderStatusSerializer : FallbackEnumSerializer<ProviderStatus>(
    serialName = "dev.sera.toolkit.model.ProviderStatus",
    values = ProviderStatus.entries,
    wireValue = { it.wireValue },
    fallback = ProviderStatus.UNKNOWN,
)

@Serializable(with = ProviderStatusSerializer::class)
enum class ProviderStatus(val wireValue: String) {
    @SerialName("ok")
    OK("ok"),
    @SerialName("degraded")
    DEGRADED("degraded"),
    @SerialName("unavailable")
    UNAVAILABLE("unavailable"),
    @SerialName("unknown")
    UNKNOWN("unknown"),
}

object HealthStatusSerializer : FallbackEnumSerializer<HealthStatus>(
    serialName = "dev.sera.toolkit.model.HealthStatus",
    values = HealthStatus.entries,
    wireValue = { it.wireValue },
    fallback = HealthStatus.UNKNOWN,
)

@Serializable(with = HealthStatusSerializer::class)
enum class HealthStatus(val wireValue: String) {
    @SerialName("ok")
    OK("ok"),
    @SerialName("degraded")
    DEGRADED("degraded"),
    @SerialName("error")
    ERROR("error"),
    @SerialName("unknown")
    UNKNOWN("unknown"),
}

object HealthCheckStatusSerializer : FallbackEnumSerializer<HealthCheckStatus>(
    serialName = "dev.sera.toolkit.model.HealthCheckStatus",
    values = HealthCheckStatus.entries,
    wireValue = { it.wireValue },
    fallback = HealthCheckStatus.UNKNOWN,
)

@Serializable(with = HealthCheckStatusSerializer::class)
enum class HealthCheckStatus(val wireValue: String) {
    @SerialName("ok")
    OK("ok"),
    @SerialName("error")
    ERROR("error"),
    @SerialName("unknown")
    UNKNOWN("unknown"),
}

@Serializable
data class DownloadOption(
    val id: String,
    val itemId: String,
    val kind: MediaKind = MediaKind.UNKNOWN,
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
    val kind: MediaKind = MediaKind.UNKNOWN,
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
    val type: MediaInfoType = MediaInfoType.SINGLE,
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
    val state: JobState = JobState.UNKNOWN,
    val step: String = "",
    val progress: JobProgress = JobProgress(),
    val provider: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
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
    val status: ProviderStatus = ProviderStatus.UNKNOWN,
    val capabilities: ProviderCapabilities = ProviderCapabilities(),
)

@Serializable
data class NodeAvailability(
    val enabled: Boolean = false,
    val totalNodes: Int = 0,
    val healthyNodes: Int = 0,
    val residentialNodes: Int = 0,
    val primaryNodes: Int? = null,
    val backupNodes: Int? = null,
    val features: List<String> = emptyList(),
    val providers: List<String> = emptyList(),
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
    val nodeAvailability: NodeAvailability? = null,
)

@Serializable
data class HealthCheck(
    val name: String,
    val status: HealthCheckStatus = HealthCheckStatus.UNKNOWN,
    val detail: String? = null,
)

@Serializable
data class HealthReport(
    val status: HealthStatus = HealthStatus.UNKNOWN,
    val version: String,
    val uptimeSeconds: Double = 0.0,
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
    data class ImportedUser(
        val username: String? = null,
        @SerialName("full_name") val fullName: String? = null,
    )

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
    const val VALIDATION_ERROR = "VALIDATION_ERROR"
    const val FORBIDDEN = "FORBIDDEN"
    const val UNSUPPORTED_SOURCE = "UNSUPPORTED_SOURCE"
    const val PRIVATE_CONTENT = "PRIVATE_CONTENT"
    const val MEDIA_UNAVAILABLE = "MEDIA_UNAVAILABLE"
    const val GEO_RESTRICTED = "GEO_RESTRICTED"
    const val AGE_RESTRICTED = "AGE_RESTRICTED"
    const val LOGIN_REQUIRED = "LOGIN_REQUIRED"
    const val SOURCE_BLOCKED = "SOURCE_BLOCKED"
    const val PROVIDER_AUTH_REQUIRED = "PROVIDER_AUTH_REQUIRED"
    const val PROVIDER_CONFIGURATION_ERROR = "PROVIDER_CONFIGURATION_ERROR"
    const val ROBOTS_DISALLOWED = "ROBOTS_DISALLOWED"
    const val DRM_PROTECTED = "DRM_PROTECTED"
    const val LIVE_IN_PROGRESS = "LIVE_IN_PROGRESS"
    const val RATE_LIMITED = "RATE_LIMITED"
    const val PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    const val NETWORK_ERROR = "NETWORK_ERROR"
    const val TOO_LARGE = "TOO_LARGE"
    const val TOO_LONG = "TOO_LONG"
    const val CONVERSION_FAILED = "CONVERSION_FAILED"
    const val TIMEOUT = "TIMEOUT"
    const val CANCELLED = "CANCELLED"
    const val NOT_FOUND = "NOT_FOUND"
    const val EXPIRED = "EXPIRED"
    const val BLOCKED_ADDRESS = "BLOCKED_ADDRESS"
    const val QUEUE_FULL = "QUEUE_FULL"
    const val INTERNAL = "INTERNAL"
}

val SUBTITLE_EMBED_CONTAINERS = setOf("mp4", "mkv", "webm")
const val MAX_URL_LENGTH = 2048
const val MAX_FILENAME_LENGTH = 200
const val MAX_SELECTED_ITEMS = 25
