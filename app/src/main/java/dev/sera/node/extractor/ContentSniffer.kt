package dev.sera.node.extractor

import java.io.File
import java.io.FileInputStream

const val SNIFF_BYTES = 32

private val EQUIVALENT_CONTAINERS = listOf(
    setOf("jpg", "jpeg"),
    setOf("mp4", "m4v", "m4a"),
    setOf("ogg", "oga", "opus"),
    setOf("mkv", "webm"),
    setOf("zip", "apk", "epub"),
)

val MIME_TYPES: Map<String, String> = mapOf(
    "srt" to "application/x-subrip",
    "vtt" to "text/vtt",
    "mp4" to "video/mp4",
    "webm" to "video/webm",
    "mov" to "video/quicktime",
    "mkv" to "video/x-matroska",
    "mp3" to "audio/mpeg",
    "m4a" to "audio/mp4",
    "aac" to "audio/aac",
    "opus" to "audio/opus",
    "ogg" to "audio/ogg",
    "wav" to "audio/wav",
    "flac" to "audio/flac",
    "gif" to "image/gif",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "png" to "image/png",
    "webp" to "image/webp",
    "avif" to "image/avif",
    "pdf" to "application/pdf",
    "iso" to "application/x-iso9660-image",
    "tar" to "application/x-tar",
    "7z" to "application/x-7z-compressed",
    "apk" to "application/vnd.android.package-archive",
    "dmg" to "application/x-apple-diskimage",
    "exe" to "application/x-msdownload",
    "epub" to "application/epub+zip",
    "zip" to "application/zip",
    "bin" to "application/octet-stream",
)

fun mimeTypeFor(filename: String): String {
    val ext = filename.substringAfterLast('.', "").lowercase()
    return MIME_TYPES[ext] ?: "application/octet-stream"
}

private fun ByteArray.matchesAt(offset: Int, vararg expected: Int): Boolean {
    if (offset + expected.size > size) return false
    for (i in expected.indices) {
        if ((this[offset + i].toInt() and 0xff) != expected[i]) return false
    }
    return true
}

private fun ByteArray.matchesAscii(offset: Int, text: String): Boolean {
    if (offset + text.length > size) return false
    for (i in text.indices) {
        if ((this[offset + i].toInt() and 0xff) != text[i].code) return false
    }
    return true
}

fun sniffContainer(head: ByteArray): String? {
    if (head.matchesAt(0, 0xff, 0xd8, 0xff)) return "jpg"
    if (head.matchesAt(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png"
    if (head.matchesAscii(0, "GIF87a") || head.matchesAscii(0, "GIF89a")) return "gif"
    if (head.matchesAscii(0, "RIFF") && head.matchesAscii(8, "WEBP")) return "webp"
    if (head.matchesAscii(0, "RIFF") && head.matchesAscii(8, "WAVE")) return "wav"
    if (head.matchesAscii(4, "ftyp")) {
        if (head.matchesAscii(8, "avif") || head.matchesAscii(8, "avis")) return "avif"
        if (head.matchesAscii(8, "heic") || head.matchesAscii(8, "heix") || head.matchesAscii(8, "mif1")) {
            return "jpg"
        }
        if (head.matchesAscii(8, "qt  ")) return "mov"
        return "mp4"
    }
    if (head.matchesAt(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm"
    if (head.matchesAscii(0, "OggS")) return "ogg"
    if (head.matchesAscii(0, "fLaC")) return "flac"
    if (head.matchesAscii(0, "ID3")) return "mp3"
    if (head.size >= 2) {
        val b0 = head[0].toInt() and 0xff
        val b1 = head[1].toInt() and 0xff
        if (b0 == 0xff && (b1 and 0xe0) == 0xe0 && (b1 and 0x06) != 0x00) {
            return "mp3"
        }
    }
    if (head.matchesAscii(0, "%PDF-")) return "pdf"
    if (head.matchesAt(0, 0x50, 0x4b, 0x03, 0x04)) return "zip"
    if (head.matchesAt(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "7z"
    if (head.matchesAt(0, 0x4d, 0x5a)) return "exe"
    return null
}

fun sniffTextImposter(head: ByteArray): String? {
    var start = 0
    if (head.size >= 3 && head.matchesAt(0, 0xef, 0xbb, 0xbf)) start = 3
    while (start < head.size && (head[start].toInt() and 0xff) <= 0x20) start += 1
    if (start >= head.size) return null

    val text = String(head, start, head.size - start, Charsets.ISO_8859_1).lowercase()
    if (text.isEmpty()) return null
    if (
        text.startsWith("<!doctype html") ||
        text.startsWith("<html") ||
        text.startsWith("<head") ||
        text.startsWith("<script")
    ) {
        return "html"
    }
    if (
        text.startsWith("<?xml") ||
        text.startsWith("<svg") ||
        text.startsWith("<!doctype svg") ||
        text.startsWith("<!doctype xml")
    ) {
        return "xml"
    }
    if (text.startsWith("{") || text.startsWith("[")) return "json"
    return null
}

fun isExecutableHeader(head: ByteArray): Boolean {
    if (head.size < 4) return false
    val b0 = head[0].toInt() and 0xff
    val b1 = head[1].toInt() and 0xff
    val b2 = head[2].toInt() and 0xff
    val b3 = head[3].toInt() and 0xff
    if (b0 == 0x4d && b1 == 0x5a) return true
    if (b0 == 0x7f && b1 == 0x45 && b2 == 0x4c && b3 == 0x46) return true
    val isMachOBe = b0 == 0xfe && b1 == 0xed && b2 == 0xfa && (b3 == 0xce || b3 == 0xcf)
    val isMachOLe = (b0 == 0xce || b0 == 0xcf) && b1 == 0xfa && b2 == 0xed && b3 == 0xfe
    val isFatMachO = b0 == 0xca && b1 == 0xfe && b2 == 0xba && b3 == 0xbe
    return isMachOBe || isMachOLe || isFatMachO
}

fun contradicts(claimed: String, sniffed: String): Boolean {
    if (claimed == sniffed) return false
    return EQUIVALENT_CONTAINERS.none { claimed in it && sniffed in it }
}

fun headOf(file: File): ByteArray {
    return try {
        FileInputStream(file).use { stream ->
            val buf = ByteArray(SNIFF_BYTES)
            val read = stream.read(buf)
            if (read <= 0) ByteArray(0) else buf.copyOf(read)
        }
    } catch (_: Exception) {
        ByteArray(0)
    }
}
