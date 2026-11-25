package dev.sera.node.model

import dev.sera.node.extractor.ALL_PROVIDER_IDS
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonPrimitive

@OptIn(ExperimentalSerializationApi::class)
val SeraJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

const val DEFAULT_INSTAGRAM_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

val VALID_TASK_ID_REGEX = Regex("^[A-Za-z0-9_-]{1,64}$")

fun isValidTaskId(taskId: String): Boolean = VALID_TASK_ID_REGEX.matches(taskId)

enum class NetworkTransport(val wireValue: String, val displayLabel: String) {
    WIFI("wifi", "Wi-Fi"),
    CELLULAR("cellular", "Cellular"),
    OTHER("other", "Network"),
    NONE("none", "Offline");

    fun wireValueOrNull(): String? = if (this == NONE) null else wireValue
}

data class NetworkState(
    val isConnected: Boolean = false,
    val transport: NetworkTransport = NetworkTransport.NONE,
    val isMetered: Boolean = false,
    val activeNetworkId: Long = 0L,
    val epoch: Long = 0L,
) {
    fun isAllowed(allowWifi: Boolean, allowCellular: Boolean): Boolean {
        if (!isConnected) return false
        return when (transport) {
            NetworkTransport.WIFI -> allowWifi
            NetworkTransport.CELLULAR -> allowCellular
            NetworkTransport.OTHER -> allowWifi || allowCellular
            NetworkTransport.NONE -> false
        }
    }
}

@Serializable
enum class NodeRole(val wireValue: String, val label: String) {
    @SerialName("backup")
    BACKUP("backup", "Backup"),

    @SerialName("primary")
    PRIMARY("primary", "Primary");

    companion object {
        fun fromWireValue(raw: String?): NodeRole? {
            val normalized = raw?.trim()?.lowercase() ?: return null
            return entries.firstOrNull { it.wireValue == normalized }
        }

        fun fromStorage(raw: String?): NodeRole = fromWireValue(raw) ?: BACKUP
    }
}

@Serializable
data class NodeRuntimeConfig(
    val apiBaseUrl: String,
    val nodeToken: String,
    val nodeId: String = "android-node",
    val providers: List<String> = ALL_PROVIDER_IDS,
    val networkClass: String = "residential",
    val role: NodeRole = NodeRole.BACKUP,
    val instagramSessionId: String? = null,
    val youtubePlayerClients: String? = null,
    val youtubePotProviderUrl: String? = null,
    val redditClientId: String? = null,
    val redditClientSecret: String? = null,
    val preferredCapacity: Int = 2,
    val workDirPath: String = "",
    val maxFilesizeBytes: Long = 4L * 1024L * 1024L * 1024L,
    val jobTimeoutSeconds: Int = 1800,
    val allowPrivateAddresses: Boolean = false,
)

@Serializable
data class ClaimRequest(
    val nodeId: String,
    val providers: List<String>,
    val capacity: Int,
    val networkClass: String = "residential",
    val role: NodeRole = NodeRole.BACKUP,
    val priority: Int? = null,
    val features: List<String>,
    val transport: String? = null,
    val appVersion: String? = null,
    val ytdlpVersion: String? = null,
    val ffmpegVersion: String? = null,
)

@Serializable
data class RemoteTaskItem(
    val index: Int,
    val sourceId: String? = null,
)

@Serializable
data class RemoteTrimRange(
    val start: Double,
    val end: Double? = null,
)

@Serializable
data class RemoteSubtitleSpec(
    val lang: String,
    val auto: Boolean = false,
    val format: String,
    val only: Boolean = false,
)

@Serializable
data class RemoteTask(
    val id: String,
    val kind: String,
    val url: String,
    val providerId: String,
    val networkClass: String? = null,
    val planKeys: List<String>? = null,
    val items: List<RemoteTaskItem>? = null,
    val filename: String? = null,
    val trim: RemoteTrimRange? = null,
    val requires: List<String>? = null,
    val avoid: List<String>? = null,
    val subtitles: RemoteSubtitleSpec? = null,
    val createdAt: Long? = null,
)

@Serializable
data class ProgressRequest(
    val percent: Double,
    val step: String,
    val bytesDownloaded: Long? = null,
    val bytesTotal: Long? = null,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
)

@Serializable
data class ProgressResponse(
    val cancelled: Boolean = false,
)

@Serializable
data class ResolvedBody(
    val media: ResolvedMedia,
)

@Serializable
data class AcceptedResponse(
    val accepted: Boolean = false,
    val sizeBytes: Long? = null,
    val complete: Boolean? = null,
    val cancelled: Boolean? = null,
    val superseded: Boolean? = null,
)

@Serializable
data class FileUploadStatusResponse(
    val exists: Boolean = false,
    val complete: Boolean = false,
    val sizeBytes: Long = 0L,
)

@Serializable
data class FailedRequest(
    val code: String,
    val message: String? = null,
    val detail: String? = null,
)

@Serializable
data class AudioExtractSpec(
    val format: String,
    val quality: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("via")
sealed class FetchPlan {
    @Serializable
    @SerialName("ytdlp")
    data class Ytdlp(
        val selector: String,
        val merge: String? = null,
        val audio: AudioExtractSpec? = null,
        val remux: String? = null,
        val extractorArgs: List<String>? = null,
        val target: String? = null,
        val useExtractors: String? = null,
    ) : FetchPlan()

    @Serializable
    @SerialName("direct")
    data class Direct(
        val url: String,
    ) : FetchPlan()
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ConversionSpec {
    @Serializable
    @SerialName("remux")
    data class Remux(
        val container: String,
    ) : ConversionSpec()

    @Serializable
    @SerialName("video")
    data class Video(
        val container: String,
    ) : ConversionSpec()

    @Serializable
    @SerialName("audio")
    data class Audio(
        val container: String,
        val bitrateKbps: Int? = null,
    ) : ConversionSpec()

    @Serializable
    @SerialName("gif")
    data class Gif(
        val maxWidth: Int? = null,
        val fps: Int? = null,
    ) : ConversionSpec()
}

@Serializable
data class ResolvedPlan(
    val kind: String,
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
    val fetch: FetchPlan,
    val convert: ConversionSpec? = null,
)

@Serializable
data class SubtitleTrack(
    val lang: String,
    val label: String,
    val auto: Boolean? = null,
)

@Serializable
data class MediaTags(
    val artist: String? = null,
    val album: String? = null,
    val track: String? = null,
)

@Serializable
data class ResolvedItem(
    val sourceId: String? = null,
    val index: Int = 0,
    val kind: String,
    val title: String? = null,
    val thumbnailUrl: String? = null,
    val thumbnailFallbackUrl: String? = null,
    val subtitles: List<SubtitleTrack>? = null,
    val tags: MediaTags? = null,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val container: String? = null,
    val filesizeBytes: Long? = null,
    val isLive: Boolean? = null,
    val plans: List<ResolvedPlan>,
)

@Serializable
data class ResolvedMedia(
    val provider: String,
    val providerLabel: String,
    val url: String,
    val type: String,
    val title: String,
    val description: String? = null,
    val author: String? = null,
    val authorUrl: String? = null,
    val thumbnailUrl: String? = null,
    val duration: Double? = null,
    val createdAt: String? = null,
    val remoteBackend: String? = null,
    val items: List<ResolvedItem>,
    val metadata: Map<String, JsonPrimitive>? = null,
)

fun planKey(plan: ResolvedPlan): String = "${plan.kind}/${plan.container}/${plan.label}"

@Serializable
data class YoutubeHotConfig(
    val playerClients: List<String> = emptyList(),
    val extraArgs: List<String> = emptyList(),
    val remoteComponents: List<String> = listOf("ejs:github"),
    val potProviderUrl: String? = null,
)

@Serializable
data class InstagramHotConfig(
    val webApiAppId: String = "936619743392459",
    val userAgent: String = DEFAULT_INSTAGRAM_USER_AGENT,
    val cdnHosts: List<String> = listOf("cdninstagram.com", "fbcdn.net"),
    val strategyOrder: List<String> = listOf("ytdlp", "web-api", "oembed"),
)

@Serializable
data class ProviderHotConfig(
    val youtube: YoutubeHotConfig = YoutubeHotConfig(),
    val instagram: InstagramHotConfig = InstagramHotConfig(),
)

@Serializable
data class YtdlpUpdateInfo(
    val version: String,
    val assetName: String,
    val sha256: String? = null,
    val url: String,
    val proxyPath: String,
)

@Serializable
data class AndroidAppUpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val sha256: String,
    val apkUrl: String,
    val proxyPath: String = "",
    val releaseNotes: String? = null,
    val minVersionCode: Int? = null,
)

@Serializable
data class NodeUpdateManifest(
    val manifestHash: String,
    val generatedAt: String,
    val ytdlp: YtdlpUpdateInfo,
    val androidNodeApp: AndroidAppUpdateInfo? = null,
    val providerConfig: ProviderHotConfig = ProviderHotConfig(),
)

data class TaskProgress(
    val percent: Double,
    val step: String,
    val bytesDownloaded: Long? = null,
    val bytesTotal: Long? = null,
    val speedBytesPerSecond: Double? = null,
    val etaSeconds: Double? = null,
)

data class ProducedFile(
    val name: String,
    val mimeType: String,
    val filePath: String,
    val sizeBytes: Long,
)

sealed interface TaskExecutionOutcome {
    data class Resolved(val media: ResolvedMedia) : TaskExecutionOutcome
    data class JobFiles(
        val files: List<ProducedFile>,
        val cleanupDirPath: String? = null,
    ) : TaskExecutionOutcome
    data class Failed(
        val code: String,
        val message: String,
        val detail: String? = null,
    ) : TaskExecutionOutcome
    data object Cancelled : TaskExecutionOutcome
}

data class ToolsVersionInfo(
    val ready: Boolean,
    val ytdlpVersion: String? = null,
    val ffmpegVersion: String? = null,
    val ffprobeVersion: String? = null,
    val jsRuntimeName: String? = null,
    val jsRuntimePath: String? = null,
    val ejsScriptsReady: Boolean = false,
    val error: String? = null,
)

data class ToolUpdateResult(
    val updated: Boolean,
    val previousVersion: String? = null,
    val currentVersion: String? = null,
    val sha256Verified: Boolean = false,
    val message: String,
)

interface NodeTaskRunner {
    suspend fun executeTask(
        task: RemoteTask,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        onProgress: suspend (TaskProgress) -> Boolean,
    ): TaskExecutionOutcome
}

interface ExtractionToolsManager {
    suspend fun ensureReady()
    suspend fun getToolsVersions(): ToolsVersionInfo
    suspend fun updateYtdlpFromManifest(
        manifest: YtdlpUpdateInfo,
        authToken: String?,
        apiBaseUrl: String?,
    ): ToolUpdateResult
    suspend fun forceRefreshTools(
        manifest: YtdlpUpdateInfo?,
        authToken: String?,
        apiBaseUrl: String?,
    ): ToolUpdateResult
}
