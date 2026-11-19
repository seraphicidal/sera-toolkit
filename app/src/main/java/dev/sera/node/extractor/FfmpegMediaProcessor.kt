package dev.sera.node.extractor

import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.RemoteTrimRange
import java.io.File
import java.util.Base64
import kotlin.math.min

const val KEYFRAME_TOLERANCE_SECONDS = 0.25

val TAGGABLE_AUDIO = setOf("mp3", "m4a", "opus")

private val AUDIO_ONLY_EXTENSIONS = setOf("mp3", "m4a", "aac", "opus", "ogg", "wav", "flac")

private val AUDIO_ENCODERS = mapOf(
    "mp3" to "libmp3lame",
    "m4a" to "aac",
    "aac" to "aac",
    "opus" to "libopus",
    "ogg" to "libvorbis",
    "wav" to "pcm_s16le",
    "flac" to "flac",
)

private val COPYABLE_AUDIO = mapOf(
    "mp3" to setOf("mp3"),
    "m4a" to setOf("aac"),
    "aac" to setOf("aac"),
    "opus" to setOf("opus"),
    "ogg" to setOf("vorbis"),
    "flac" to setOf("flac"),
    "wav" to emptySet(),
)

data class MediaAudioTags(
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
)

class FfmpegMediaProcessor(
    private val executor: MediaCommandExecutor,
) {
    fun buildConvertArgs(
        input: File,
        output: File,
        spec: ConversionSpec,
        source: FfprobeResult,
        threads: Int = 2,
        maxOutputBytes: Long? = null,
    ): List<String> {
        val args = mutableListOf(
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe,data",
            "-i",
            input.absolutePath,
            "-threads",
            threads.toString(),
            "-max_muxing_queue_size",
            "1024",
        )

        when (spec) {
            is ConversionSpec.Audio -> {
                args.addAll(audioArgs(spec, source.audio?.codec))
                args.addAll(listOf("-map_metadata", "0", "-id3v2_version", "3"))
            }
            is ConversionSpec.Remux -> {
                args.addAll(listOf("-c", "copy"))
                if (spec.container == "mp4" || spec.container == "mov") {
                    args.addAll(listOf("-movflags", "+faststart"))
                }
            }
            is ConversionSpec.Gif -> {
                val fps = spec.fps ?: 15
                val width = spec.maxWidth ?: 480
                args.addAll(
                    listOf(
                        "-t",
                        "30",
                        "-filter_complex",
                        "fps=$fps,scale='min($width,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                        "-loop",
                        "0",
                    ),
                )
            }
            is ConversionSpec.Video -> {
                val vCodec = (source.video?.codec ?: "").lowercase()
                val aCodec = (source.audio?.codec ?: "").lowercase()
                if (spec.container == "mp4") {
                    val videoCompatible = vCodec == "h264" || vCodec.startsWith("avc1")
                    val audioCompatible = source.audio == null ||
                        aCodec == "aac" ||
                        aCodec.startsWith("mp4a") ||
                        aCodec == "mp3"
                    if (videoCompatible && audioCompatible) {
                        args.addAll(listOf("-c", "copy", "-movflags", "+faststart"))
                    } else {
                        args.addAll(
                            listOf(
                                "-c:v",
                                "libx264",
                                "-preset",
                                "veryfast",
                                "-crf",
                                "23",
                                "-pix_fmt",
                                "yuv420p",
                                "-vf",
                                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                                "-movflags",
                                "+faststart",
                            ),
                        )
                        if (source.audio != null) {
                            args.addAll(listOf("-c:a", "aac", "-b:a", "160k"))
                        } else {
                            args.add("-an")
                        }
                    }
                } else {
                    val videoCompatible =
                        vCodec == "vp9" ||
                            vCodec.startsWith("vp09") ||
                            vCodec == "vp8" ||
                            vCodec == "av1" ||
                            vCodec.startsWith("av01")
                    val audioCompatible =
                        source.audio == null || aCodec == "opus" || aCodec == "vorbis"
                    if (videoCompatible && audioCompatible) {
                        args.addAll(listOf("-c", "copy"))
                    } else {
                        args.addAll(
                            listOf(
                                "-c:v",
                                "libvpx-vp9",
                                "-deadline",
                                "good",
                                "-cpu-used",
                                "4",
                                "-crf",
                                "32",
                                "-b:v",
                                "0",
                                "-row-mt",
                                "1",
                            ),
                        )
                        if (source.audio != null) {
                            args.addAll(listOf("-c:a", "libopus", "-b:a", "128k"))
                        } else {
                            args.add("-an")
                        }
                    }
                }
            }
        }

        if (maxOutputBytes != null && maxOutputBytes > 0L) {
            args.addAll(listOf("-fs", maxOutputBytes.toString()))
        }
        args.addAll(listOf("-progress", "pipe:1", "-nostats", output.absolutePath))
        return args
    }

    private fun audioArgs(spec: ConversionSpec.Audio, sourceAudioCodec: String?): List<String> {
        val copyable = COPYABLE_AUDIO[spec.container].orEmpty()
        if (sourceAudioCodec != null && sourceAudioCodec in copyable) {
            return listOf("-vn", "-c:a", "copy")
        }
        val encoder = AUDIO_ENCODERS[spec.container]
            ?: throw seraError(SeraErrorCode.CONVERSION_FAILED, detail = "no encoder for ${spec.container}")
        val args = mutableListOf("-vn", "-c:a", encoder)
        if (spec.bitrateKbps != null && spec.container != "wav" && spec.container != "flac") {
            args.addAll(listOf("-b:a", "${spec.bitrateKbps}k"))
        }
        return args
    }

    suspend fun convert(
        input: File,
        output: File,
        spec: ConversionSpec,
        durationSeconds: Double? = null,
        maxOutputBytes: Long? = null,
        threads: Int = 2,
        timeoutMs: Long,
        isCancelled: () -> Boolean = { false },
        onProgress: (Double) -> Unit = {},
    ) {
        val source = if (spec is ConversionSpec.Remux && durationSeconds != null) {
            FfprobeResult(durationSeconds = durationSeconds)
        } else {
            executor.probeMedia(input, timeoutMs = min(timeoutMs, 30_000L), isCancelled = isCancelled)
        }
        val duration = durationSeconds ?: source.durationSeconds

        if (spec is ConversionSpec.Audio && source.audio == null) {
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                message = "This media has no audio track to extract.",
                hint = "Choose a video format instead.",
                detail = "no audio stream in source",
            )
        }

        var lastPercent = 0.0
        val args = buildConvertArgs(input, output, spec, source, threads, maxOutputBytes)
        val result = executor.runFfmpeg(
            args = args,
            workDir = output.parentFile ?: input.parentFile ?: File("."),
            timeoutMs = timeoutMs,
            onStdoutLine = { line ->
                val eq = line.indexOf('=')
                if (eq > 0 && duration != null && duration > 0.0) {
                    val key = line.substring(0, eq)
                    if (key == "out_time_us" || key == "out_time_ms") {
                        val raw = line.substring(eq + 1).trim()
                        val micros = raw.toDoubleOrNull()
                        if (micros != null && micros.isFinite()) {
                            val percent = min(99.0, (micros / 1_000_000.0 / duration) * 100.0)
                            if (percent > lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            },
            isCancelled = isCancelled,
        )

        if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
        if (result.exitCode != 0) {
            val kindName = when (spec) {
                is ConversionSpec.Audio -> "audio"
                is ConversionSpec.Remux -> "remux"
                is ConversionSpec.Gif -> "gif"
                is ConversionSpec.Video -> "video"
            }
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                detail = "ffmpeg exit ${result.exitCode} for $kindName: ${result.stderrTail.takeLast(500)}",
            )
        }
        onProgress(100.0)
    }

    suspend fun trimMedia(
        input: File,
        output: File,
        range: RemoteTrimRange,
        threads: Int = 2,
        maxOutputBytes: Long? = null,
        timeoutMs: Long,
        isCancelled: () -> Boolean = { false },
    ): Boolean {
        val source = executor.probeMedia(input, timeoutMs = min(timeoutMs, 30_000L), isCancelled = isCancelled)
        val extension = output.extension.lowercase()
        val hasVideo = source.video != null && extension !in AUDIO_ONLY_EXTENSIONS
        val keyframe = if (hasVideo && range.start > 0.0) {
            executor.keyframeAtOrBefore(input, range.start, timeoutMs = min(timeoutMs, 30_000L), isCancelled = isCancelled)
        } else {
            null
        }
        val copy = !hasVideo || copyIsAccurate(range.start, keyframe)
        val length = range.end?.minus(range.start)

        val args = mutableListOf(
            "-hide_banner",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe,data",
            "-ss",
            range.start.toString(),
            "-i",
            input.absolutePath,
        )
        if (length != null) {
            args.addAll(listOf("-t", length.toString()))
        }
        if (copy) {
            args.addAll(listOf("-c", "copy"))
        } else {
            args.addAll(reencodeTrimArgs(extension))
        }
        args.addAll(
            listOf(
                "-avoid_negative_ts",
                "make_zero",
                "-threads",
                threads.toString(),
            ),
        )
        if (extension == "mp4" || extension == "mov" || extension == "m4a") {
            args.addAll(listOf("-movflags", "+faststart"))
        }
        if (maxOutputBytes != null && maxOutputBytes > 0L) {
            args.addAll(listOf("-fs", maxOutputBytes.toString()))
        }
        args.add(output.absolutePath)

        val result = executor.runFfmpeg(
            args = args,
            workDir = output.parentFile ?: input.parentFile ?: File("."),
            timeoutMs = timeoutMs,
            isCancelled = isCancelled,
        )
        if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
        if (result.exitCode != 0) {
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                message = "The media was downloaded, but trimming it failed.",
                detail = "ffmpeg trim exit ${result.exitCode}: ${result.stderrTail.takeLast(500)}",
            )
        }
        return !copy
    }

    suspend fun squareCover(
        input: File,
        output: File,
        timeoutMs: Long = 60_000L,
        isCancelled: () -> Boolean = { false },
    ) {
        val result = executor.runFfmpeg(
            args = listOf(
                "-hide_banner",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file,pipe,data",
                "-i",
                input.absolutePath,
                "-vf",
                "crop='min(iw,ih)':'min(iw,ih)',scale='min(1000,iw)':'min(1000,ih)'",
                "-frames:v",
                "1",
                "-q:v",
                "3",
                output.absolutePath,
            ),
            workDir = output.parentFile ?: input.parentFile ?: File("."),
            timeoutMs = min(timeoutMs, 60_000L),
            isCancelled = isCancelled,
        )
        if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
        if (result.exitCode != 0) {
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                detail = "cover crop exit ${result.exitCode}: ${result.stderrTail.takeLast(300)}",
            )
        }
    }

    suspend fun tagAudio(
        input: File,
        output: File,
        tags: MediaAudioTags,
        coverPath: File?,
        scratchDir: File,
        timeoutMs: Long = 120_000L,
        isCancelled: () -> Boolean = { false },
    ) {
        val extension = output.extension.lowercase()
        if (extension !in TAGGABLE_AUDIO) {
            throw seraError(SeraErrorCode.CONVERSION_FAILED, detail = "cannot tag .$extension")
        }

        val lines = mutableListOf(";FFMETADATA1")
        tags.title?.let { lines.add("title=${escapeMetadata(it)}") }
        tags.artist?.let { lines.add("artist=${escapeMetadata(it)}") }
        tags.album?.let { lines.add("album=${escapeMetadata(it)}") }

        val oggCover = extension == "opus" && coverPath != null
        if (extension == "opus" && coverPath != null) {
            val jpeg = coverPath.readBytes()
            val cover = executor.probeMedia(coverPath, timeoutMs = 30_000L, isCancelled = isCancelled)
            val width = cover.video?.width ?: 0
            val height = cover.video?.height ?: 0
            lines.add("METADATA_BLOCK_PICTURE=${escapeMetadata(pictureBlock(jpeg, width, height))}")
        }

        val metadataPath = File(scratchDir, "tags.ffmeta")
        metadataPath.writeText("${lines.joinToString("\n")}\n", Charsets.UTF_8)

        val picture = coverPath != null && !oggCover
        val args = mutableListOf(
            "-hide_banner",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe,data",
            "-i",
            input.absolutePath,
            "-i",
            metadataPath.absolutePath,
        )
        if (!oggCover && coverPath != null) {
            args.addAll(listOf("-i", coverPath.absolutePath))
        }
        args.addAll(listOf("-map", "0:a"))
        if (picture) {
            args.addAll(listOf("-map", "2:v"))
        }
        args.addAll(listOf("-map_metadata", "1", "-c", "copy"))
        if (picture) {
            args.addAll(listOf("-disposition:v", "attached_pic", "-metadata:s:v", "title=Cover"))
        }
        if (extension == "mp3") {
            args.addAll(listOf("-id3v2_version", "3"))
        }
        args.add(output.absolutePath)

        val result = executor.runFfmpeg(
            args = args,
            workDir = scratchDir,
            timeoutMs = min(timeoutMs, 120_000L),
            isCancelled = isCancelled,
        )
        if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
        if (result.exitCode != 0) {
            throw seraError(
                SeraErrorCode.CONVERSION_FAILED,
                detail = "ffmpeg tag exit ${result.exitCode}: ${result.stderrTail.takeLast(500)}",
            )
        }
    }
}

fun copyIsAccurate(start: Double, keyframe: Double?): Boolean {
    if (start <= 0.0) return true
    return keyframe != null && (start - keyframe) <= KEYFRAME_TOLERANCE_SECONDS
}

private fun reencodeTrimArgs(extension: String): List<String> {
    if (extension in AUDIO_ONLY_EXTENSIONS) {
        return when (extension) {
            "mp3" -> listOf("-vn", "-c:a", "libmp3lame", "-b:a", "192k")
            "opus" -> listOf("-vn", "-c:a", "libopus", "-b:a", "160k")
            "ogg" -> listOf("-vn", "-c:a", "libvorbis", "-b:a", "192k")
            "wav" -> listOf("-vn", "-c:a", "pcm_s16le")
            "flac" -> listOf("-vn", "-c:a", "flac")
            else -> listOf("-vn", "-c:a", "aac", "-b:a", "192k")
        }
    }
    if (extension == "webm") {
        return videoCodecArgs(extension) + listOf("-c:a", "libopus", "-b:a", "160k")
    }
    return videoCodecArgs(extension) + listOf("-c:a", "aac", "-b:a", "192k")
}

private fun videoCodecArgs(extension: String): List<String> {
    if (extension == "webm") {
        return listOf(
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
        )
    }
    return listOf(
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
    )
}

private fun escapeMetadata(value: String): String =
    value.replace(Regex("""[=;#\\\r\n]""")) { "\\${it.value}" }

fun pictureBlock(jpeg: ByteArray, width: Int, height: Int): String {
    val mime = "image/jpeg".toByteArray(Charsets.US_ASCII)
    val totalSize = 32 + mime.size + jpeg.size
    val out = ByteArray(totalSize)
    var offset = 0

    fun writeU32(value: Int) {
        out[offset] = ((value ushr 24) and 0xff).toByte()
        out[offset + 1] = ((value ushr 16) and 0xff).toByte()
        out[offset + 2] = ((value ushr 8) and 0xff).toByte()
        out[offset + 3] = (value and 0xff).toByte()
        offset += 4
    }

    fun writeBytes(bytes: ByteArray) {
        System.arraycopy(bytes, 0, out, offset, bytes.size)
        offset += bytes.size
    }

    writeU32(3)
    writeU32(mime.size)
    writeBytes(mime)
    writeU32(0)
    writeU32(width)
    writeU32(height)
    writeU32(24)
    writeU32(0)
    writeU32(jpeg.size)
    writeBytes(jpeg)
    return Base64.getEncoder().encodeToString(out)
}
