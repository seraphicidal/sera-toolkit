package dev.sera.node.extractor

import dev.sera.node.model.RemoteTrimRange
import java.text.Normalizer
import kotlin.math.roundToLong

private val ILLEGAL_CHARS = Regex("""[\u0000-\u001f\u007f<>:"/\\|?*]""")
private val RESERVED_WINDOWS = Regex(
    """^(con|prn|aux|nul|com[0-9\u00b2\u00b3\u00b9]|lpt[0-9\u00b2\u00b3\u00b9])$""",
    RegexOption.IGNORE_CASE,
)
private val DECEPTIVE_CHARS = Regex("""[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]""")
private const val MAX_STEM_LENGTH = 120

fun sliceUtf16Safe(text: String, max: Int): String {
    if (max <= 0) return ""
    if (text.length <= max) return text
    var end = max
    val last = text[end - 1]
    if (last.isHighSurrogate()) end -= 1
    return text.substring(0, end)
}

fun truncateText(text: String, max: Int): String {
    if (text.length <= max) return text
    val cut = sliceUtf16Safe(text, max)
    val lastSpace = cut.lastIndexOf(' ')
    val sliced = if (lastSpace > max * 0.6) cut.substring(0, lastSpace) else cut
    return "${sliced.trimEnd()}\u2026"
}

fun nonEmpty(value: String?): String? {
    val trimmed = value?.trim()
    return if (trimmed.isNullOrEmpty()) null else trimmed
}

fun sanitizeStem(input: String, fallback: String = "media"): String {
    var out = Normalizer.normalize(input, Normalizer.Form.NFC)
        .replace(DECEPTIVE_CHARS, "")
        .replace(ILLEGAL_CHARS, " ")
    out = out.replace(Regex("""\s+"""), " ").trim()
    out = out.trimStart('.', '-', ' ').trimEnd('.', ' ')

    if (out.length > MAX_STEM_LENGTH) {
        val safe = sliceUtf16Safe(out, MAX_STEM_LENGTH)
        val wordTrimmed = safe.replace(Regex("""\s+\S*$"""), "").trim()
        out = wordTrimmed.ifEmpty { safe }
    }
    out = out.trimEnd('.', '-', ' ').trim()

    val primaryStem = out.substringBefore('.')
    if (out.isEmpty() || RESERVED_WINDOWS.matches(out) || RESERVED_WINDOWS.matches(primaryStem)) {
        return fallback
    }
    return out
}

fun sanitizeExtension(ext: String, fallback: String = "bin"): String {
    val cleaned = ext.trimStart('.').lowercase().replace(Regex("""[^a-z0-9]"""), "")
    return if (cleaned.isEmpty() || cleaned.length > 8) fallback else cleaned
}

fun buildFilename(stem: String, ext: String, fallbackStem: String = "media"): String =
    "${sanitizeStem(stem, fallbackStem)}.${sanitizeExtension(ext)}"

fun mediaFilename(
    author: String? = null,
    title: String? = null,
    container: String,
    index: Int? = null,
): String {
    val safeAuthor = if (author != null) sanitizeStem(author, "") else ""
    val safeTitle = if (title != null) sanitizeStem(title, "") else ""
    var stem = listOf(safeAuthor, safeTitle).filter { it.isNotEmpty() }.joinToString(" - ")
    if (index != null && index > 0) {
        stem = if (stem.isNotEmpty()) "$stem ($index)" else "media ($index)"
    }
    return buildFilename(stem, container)
}

fun dedupeFilename(name: String, taken: MutableSet<String>): String {
    val key = name.lowercase()
    if (taken.add(key)) return name
    val dot = name.lastIndexOf('.')
    val ext = if (dot > 0) name.substring(dot) else ""
    val stem = if (dot > 0) name.substring(0, dot) else name
    for (n in 2 until 10_000) {
        val candidate = "$stem ($n)$ext"
        if (taken.add(candidate.lowercase())) return candidate
    }
    val unique = "$stem (${System.currentTimeMillis()})$ext"
    taken.add(unique.lowercase())
    return unique
}

fun assertSafeFilename(name: String): String {
    val hasWindowsDrive = Regex("""^[a-zA-Z]:""").containsMatchIn(name)
    if (
        name.isEmpty() ||
        name.length > 255 ||
        name.contains('\u0000') ||
        name.contains('/') ||
        name.contains('\\') ||
        name == "." ||
        name == ".." ||
        hasWindowsDrive
    ) {
        throw IllegalArgumentException("unsafe filename: ${name.take(64)}")
    }
    return name
}

fun trimSuffix(range: RemoteTrimRange, durationSeconds: Double? = null): String {
    fun part(seconds: Double): String {
        val whole = seconds.roundToLong()
        val h = whole / 3600L
        val m = (whole % 3600L) / 60L
        val s = whole % 60L
        return if (h > 0L) {
            "${h}h${m.toString().padStart(2, '0')}m${s.toString().padStart(2, '0')}s"
        } else {
            "${m}m${s.toString().padStart(2, '0')}s"
        }
    }
    val end = range.end ?: durationSeconds
    return "-trim-${part(range.start)}${if (end != null) "-${part(end)}" else "-end"}"
}

fun subtitleName(name: String, lang: String): String {
    val dot = name.lastIndexOf('.')
    val safe = lang.removeSuffix("-orig").replace(Regex("""[^A-Za-z0-9_-]"""), "").ifEmpty { "subtitles" }
    if (dot <= 0) return "$name.$safe"
    return "${name.substring(0, dot)}.$safe${name.substring(dot)}"
}
