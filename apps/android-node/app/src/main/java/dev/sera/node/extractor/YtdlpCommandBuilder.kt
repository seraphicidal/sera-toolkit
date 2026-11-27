package dev.sera.node.extractor

import java.io.File
import kotlin.math.max
import kotlin.math.min

private const val PROGRESS_SEP = "\u0001"
private const val PROGRESS_PREFIX = "SERA-PROGRESS"
private const val POSTPROCESS_PREFIX = "SERA-POSTPROCESS"

val YTDLP_DOWNLOAD_TEMPLATE = listOf(
    "download:$PROGRESS_PREFIX",
    "%(progress.status)s",
    "%(progress.downloaded_bytes)s",
    "%(progress.total_bytes)s",
    "%(progress.total_bytes_estimate)s",
    "%(progress.speed)s",
    "%(progress.eta)s",
    "%(info.format_id)s",
).joinToString(PROGRESS_SEP)

val YTDLP_POSTPROCESS_TEMPLATE = listOf(
    "postprocess:$POSTPROCESS_PREFIX",
    "%(progress.status)s",
    "%(progress.postprocessor)s",
).joinToString(PROGRESS_SEP)

private val SAFE_WIRE_EXTRACTOR_ARG = Regex("^[a-z0-9][a-z0-9_-]{0,31}:[A-Za-z0-9_.,;+=-]{1,180}$")
private val FORBIDDEN_WIRE_EXTRACTOR_ARG = Regex("(?:^|[:;])(?:base_url|proxy|cookies?|file|path|exec)=", RegexOption.IGNORE_CASE)

private val ALLOWED_BOOLEAN_EXTRA_FLAGS = setOf(
    "--no-remote-components",
    "--force-ipv4",
    "-4",
    "--force-ipv6",
    "-6",
    "--geo-bypass",
    "--no-geo-bypass",
    "--no-check-formats",
    "--ignore-no-formats-error",
    "--hls-prefer-native",
    "--hls-use-mpegts",
    "--prefer-free-formats",
    "--no-prefer-free-formats",
)

private val ALLOWED_VALUE_EXTRA_FLAGS: Map<String, (String) -> Boolean> = mapOf(
    "--remote-components" to { v -> Regex("^[a-z0-9_.:,-]{1,128}$", RegexOption.IGNORE_CASE).matches(v) },
    "--impersonate" to { v -> Regex("^[A-Za-z0-9_.:,-]{1,64}$").matches(v) },
    "--sleep-requests" to { v -> Regex("^\\d{1,3}(?:\\.\\d{1,3})?$").matches(v) },
    "--sleep-interval" to { v -> Regex("^\\d{1,3}(?:\\.\\d{1,3})?$").matches(v) },
    "--max-sleep-interval" to { v -> Regex("^\\d{1,3}(?:\\.\\d{1,3})?$").matches(v) },
    "--sleep-subtitles" to { v -> Regex("^\\d{1,3}(?:\\.\\d{1,3})?$").matches(v) },
    "--retries" to { v -> Regex("^\\d{1,2}$").matches(v) },
    "--fragment-retries" to { v -> Regex("^\\d{1,2}$").matches(v) },
    "--extractor-retries" to { v -> Regex("^\\d{1,2}$").matches(v) },
    "--socket-timeout" to { v -> Regex("^\\d{1,3}$").matches(v) },
    "--concurrent-fragments" to { v -> Regex("^(?:[1-9]|1[0-6])$").matches(v) },
    "--throttled-rate" to { v -> Regex("^\\d{1,6}[KMG]?$").matches(v) },
    "--geo-bypass-country" to { v -> Regex("^[A-Z]{2}$", RegexOption.IGNORE_CASE).matches(v) },
    "--compat-options" to { v -> Regex("^[a-z0-9_,-]{1,64}$", RegexOption.IGNORE_CASE).matches(v) },
    "--format-sort" to { v -> Regex("^[A-Za-z0-9][A-Za-z0-9_.:,+~-]{0,127}$").matches(v) },
    "--extractor-args" to { v -> YtdlpCommandBuilder.isSafeWireExtractorArg(v) },
)

private val VALID_REMOTE_COMPONENT = Regex("^[a-z0-9_.:-]{1,64}$", RegexOption.IGNORE_CASE)

data class YtdlpRuntimePaths(
    val ffmpegLocation: String? = null,
    val quickjsPath: String? = null,
    val ejsCacheDir: File? = null,
)

object YtdlpCommandBuilder {
    fun baseArgs(
        runtimePaths: YtdlpRuntimePaths,
        proxy: String? = null,
        extractorArgs: List<String> = emptyList(),
        extraArgs: List<String> = emptyList(),
        remoteComponents: List<String> = emptyList(),
        useExtractors: String? = null,
    ): MutableList<String> {
        val args = mutableListOf(
            "--ignore-config",
            "--no-warnings",
            "--no-colors",
            "--no-playlist",
            "--no-mtime",
            "--socket-timeout",
            "15",
            "--retries",
            "3",
            "--fragment-retries",
            "5",
            "--extractor-retries",
            "2",
        )
        if (!runtimePaths.ffmpegLocation.isNullOrBlank()) {
            args.addAll(listOf("--ffmpeg-location", runtimePaths.ffmpegLocation))
        }
        if (!runtimePaths.quickjsPath.isNullOrBlank()) {
            args.addAll(listOf("--js-runtimes", "quickjs:${runtimePaths.quickjsPath}"))
        }
        val safeExtra = filterSafeExtraArgs(extraArgs)
        val hasRemoteOverride = safeExtra.any {
            val flag = it.substringBefore('=')
            flag == "--remote-components" || flag == "--no-remote-components"
        }
        if (!hasRemoteOverride) {
            val effectiveComponents = remoteComponents
                .map { it.trim() }
                .filter { it.isNotEmpty() && VALID_REMOTE_COMPONENT.matches(it) }
            if (effectiveComponents.isNotEmpty()) {
                args.addAll(listOf("--remote-components", effectiveComponents.joinToString(",")))
            } else if (runtimePaths.ejsCacheDir != null || !runtimePaths.quickjsPath.isNullOrBlank()) {
                args.addAll(listOf("--remote-components", "ejs:github"))
            }
        }
        if (runtimePaths.ejsCacheDir != null) {
            args.addAll(listOf("--cache-dir", runtimePaths.ejsCacheDir.absolutePath))
        }
        if (!proxy.isNullOrBlank()) {
            args.addAll(listOf("--proxy", proxy))
        }
        for (arg in extractorArgs) {
            if (arg.isNotBlank()) args.addAll(listOf("--extractor-args", arg))
        }
        args.addAll(safeExtra)
        args.addAll(listOf("--use-extractors", useExtractors ?: "default,-generic"))
        return args
    }

    fun buildDumpInfoArgs(
        url: String,
        options: YtdlpProbeOptions,
        runtimePaths: YtdlpRuntimePaths,
    ): List<String> {
        val args = baseArgs(
            runtimePaths = runtimePaths,
            proxy = options.proxy,
            extractorArgs = options.extractorArgs,
            extraArgs = options.extraArgs,
            remoteComponents = options.remoteComponents,
            useExtractors = options.useExtractors,
        )
        if (options.playlist) {
            args.remove("--no-playlist")
            val playlistEnd = options.maxEntries?.let { min(100, it) } ?: 100
            args.addAll(listOf("--yes-playlist", "--playlist-end", playlistEnd.toString()))
        }
        if (options.flatPlaylist) {
            args.add("--flat-playlist")
        }
        args.addAll(listOf("--dump-single-json", "--", url))
        return args
    }

    fun buildDownloadArgs(
        options: YtdlpDownloadOptions,
        runtimePaths: YtdlpRuntimePaths,
    ): List<String> {
        val args = baseArgs(
            runtimePaths = runtimePaths,
            proxy = options.proxy,
            extractorArgs = options.extractorArgs,
            extraArgs = options.extraArgs,
            remoteComponents = options.remoteComponents,
            useExtractors = options.useExtractors,
        )
        if (options.playlistItem != null) {
            args.remove("--no-playlist")
            args.addAll(listOf("--yes-playlist", "--playlist-items", options.playlistItem.toString()))
        }
        args.addAll(
            listOf(
                "--newline",
                "--progress",
                "--progress-template",
                YTDLP_DOWNLOAD_TEMPLATE,
                "--progress-template",
                YTDLP_POSTPROCESS_TEMPLATE,
                "--concurrent-fragments",
                "4",
                "--buffer-size",
                "64K",
                "--paths",
                "temp:${options.workdir.absolutePath}",
                "--paths",
                "home:${options.workdir.absolutePath}",
                "--output",
                options.outputTemplate,
                "--format",
                confineToHttp(options.format),
                "--no-overwrites",
                "--no-post-overwrites",
            ),
        )
        options.sections?.let { sec ->
            val range = "*${sec.start}-${sec.end?.toString() ?: "inf"}"
            args.addAll(listOf("--download-sections", range))
            if (sec.forceKeyframes) args.add("--force-keyframes-at-cuts")
        }
        options.subtitles?.let { sub ->
            args.addAll(subtitleArgs(sub))
            args.add("--embed-subs")
        }
        if (!options.mergeContainer.isNullOrBlank()) {
            args.addAll(listOf("--merge-output-format", options.mergeContainer))
        }
        if (!options.remuxContainer.isNullOrBlank()) {
            args.addAll(listOf("--remux-video", options.remuxContainer))
        }
        if (!options.audioFormat.isNullOrBlank()) {
            args.addAll(
                listOf(
                    "--extract-audio",
                    "--audio-format",
                    options.audioFormat,
                    "--audio-quality",
                    options.audioQuality ?: "0",
                ),
            )
        }
        if (options.maxFilesizeBytes != null && options.maxFilesizeBytes > 0L) {
            args.addAll(listOf("--max-filesize", options.maxFilesizeBytes.toString()))
        }
        if (options.loadInfoJsonPath != null) {
            args.addAll(listOf("--load-info-json", options.loadInfoJsonPath.absolutePath))
        } else {
            args.addAll(listOf("--", options.url))
        }
        return args
    }

    fun buildSubtitleArgs(
        options: YtdlpSubtitleOptions,
        runtimePaths: YtdlpRuntimePaths,
    ): List<String> {
        val args = baseArgs(
            runtimePaths = runtimePaths,
            proxy = options.proxy,
            extractorArgs = options.extractorArgs,
            extraArgs = options.extraArgs,
            remoteComponents = options.remoteComponents,
            useExtractors = options.useExtractors,
        )
        if (options.playlistItem != null) {
            args.remove("--no-playlist")
            args.addAll(listOf("--yes-playlist", "--playlist-items", options.playlistItem.toString()))
        }
        args.add("--skip-download")
        args.addAll(subtitleArgs(YtdlpSubtitleFilter(options.lang, options.auto)))
        args.addAll(
            listOf(
                "--sub-format",
                "${options.format}/best",
                "--convert-subs",
                options.format,
                "--paths",
                "temp:${options.workdir.absolutePath}",
                "--paths",
                "home:${options.workdir.absolutePath}",
                "--output",
                "subtitle.%(ext)s",
                "--",
                options.url,
            ),
        )
        return args
    }

    fun subtitleArgs(track: YtdlpSubtitleFilter): List<String> =
        listOf(if (track.auto) "--write-auto-subs" else "--write-subs", "--sub-langs", track.lang)

    fun isForbiddenWireExtractorArg(raw: String): Boolean =
        FORBIDDEN_WIRE_EXTRACTOR_ARG.containsMatchIn(raw.trim())

    fun isSafeWireExtractorArg(raw: String): Boolean {
        val trimmed = raw.trim()
        if (trimmed.length !in 3..200) return false
        return SAFE_WIRE_EXTRACTOR_ARG.matches(trimmed) && !FORBIDDEN_WIRE_EXTRACTOR_ARG.containsMatchIn(trimmed)
    }

    fun filterSafeExtraArgs(raw: List<String>): List<String> {
        val out = ArrayList<String>(raw.size)
        var i = 0
        while (i < raw.size) {
            val trimmed = raw[i].trim()
            i += 1
            if (trimmed.isEmpty() || !trimmed.startsWith("-")) continue

            val eqIdx = trimmed.indexOf('=')
            val flagName = if (eqIdx >= 0) trimmed.substring(0, eqIdx) else trimmed
            val inlineValue = if (eqIdx >= 0) trimmed.substring(eqIdx + 1) else null

            if (inlineValue == null && flagName in ALLOWED_BOOLEAN_EXTRA_FLAGS) {
                out.add(flagName)
                continue
            }

            val valueValidator = ALLOWED_VALUE_EXTRA_FLAGS[flagName]
            if (valueValidator != null) {
                val value = if (inlineValue != null) {
                    inlineValue
                } else if (i < raw.size) {
                    val candidate = raw[i].trim()
                    if (!candidate.startsWith("-")) {
                        i += 1
                        candidate
                    } else {
                        null
                    }
                } else {
                    null
                }
                if (value != null && !value.startsWith("-") && valueValidator(value)) {
                    out.add(flagName)
                    out.add(value)
                }
                continue
            }

            if (inlineValue == null && i < raw.size && !raw[i].trim().startsWith("-")) {
                i += 1
            }
        }
        return out
    }
}

class YtdlpProgressParser(
    private val expectedTotalBytes: Long?,
    private val hasMergeContainer: Boolean,
    private val onProgress: (YtdlpProgress) -> Unit,
) {
    private val bytesByFormat = LinkedHashMap<String, Long>()
    private val totalsByFormat = LinkedHashMap<String, Long>()
    private var lastPercent = 0.0

    fun feedLine(line: String) {
        if (line.startsWith(POSTPROCESS_PREFIX)) {
            val parts = line.split(PROGRESS_SEP)
            val status = parts.getOrNull(1)
            val name = parts.getOrNull(2)
            if (status == "started" && !name.isNullOrEmpty() && name != "NA") {
                onProgress(
                    YtdlpProgress(
                        percent = lastPercent,
                        bytesDownloaded = bytesByFormat.values.sum(),
                        postprocessor = name,
                    ),
                )
            }
            return
        }
        if (!line.startsWith(PROGRESS_PREFIX)) return

        val parts = line.split(PROGRESS_SEP)
        val status = parts.getOrNull(1)
        val done = parseNumeric(parts.getOrNull(2))?.toLong() ?: return
        val total = parseNumeric(parts.getOrNull(3))?.toLong()
        val totalEstimate = parseNumeric(parts.getOrNull(4))?.toLong()
        val speed = parseNumeric(parts.getOrNull(5))
        val eta = parseNumeric(parts.getOrNull(6))
        val formatId = parts.getOrNull(7)

        val streamKey = if (!formatId.isNullOrEmpty() && formatId != "NA") formatId else "default"
        bytesByFormat[streamKey] = done
        val bytesDownloaded = bytesByFormat.values.sum()

        val streamTotal = total ?: totalEstimate
        if (streamTotal != null) {
            totalsByFormat[streamKey] = max(done, streamTotal)
        }
        val bytesTotal = expectedTotalBytes ?: if (
            totalsByFormat.size == bytesByFormat.size && totalsByFormat.isNotEmpty()
        ) {
            totalsByFormat.values.sum()
        } else {
            null
        }

        if (bytesTotal != null && bytesTotal > 0L) {
            lastPercent = max(lastPercent, min(99.5, (bytesDownloaded.toDouble() / bytesTotal.toDouble()) * 100.0))
        } else if (status == "finished" && !hasMergeContainer) {
            lastPercent = max(lastPercent, 99.0)
        }

        onProgress(
            YtdlpProgress(
                percent = lastPercent,
                bytesDownloaded = bytesDownloaded,
                bytesTotal = bytesTotal,
                speedBytesPerSecond = speed,
                etaSeconds = eta,
            ),
        )
    }

    private fun parseNumeric(raw: String?): Double? {
        if (raw.isNullOrEmpty() || raw == "NA") return null
        val parsed = raw.toDoubleOrNull() ?: return null
        return if (parsed.isFinite()) parsed else null
    }
}
