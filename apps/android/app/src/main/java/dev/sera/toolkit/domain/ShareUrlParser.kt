package dev.sera.toolkit.domain

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

object ShareUrlParser {
    private const val MAX_URL_LENGTH = 8_192
    private val trailingPunctuation = Regex("[.,;:!?'\"\\)\\]\\}>]+$")
    private val linkPattern = Regex("https?://[^\\s<>\"'`]+", RegexOption.IGNORE_CASE)
    private val trackingParamDenylist = setOf(
        "si",
        "igsh",
        "igshid",
        "fbclid",
        "feature",
    )

    fun firstHttpUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        for (match in linkPattern.findAll(text)) {
            val cleaned = cleanCandidate(match.value)
            if (cleaned != null) return cleaned
        }
        return null
    }

    fun parseBatchUrls(text: String?): List<String> {
        if (text.isNullOrBlank()) return emptyList()
        val seen = LinkedHashSet<String>()
        for (match in linkPattern.findAll(text)) {
            val cleaned = cleanCandidate(match.value)
            if (cleaned != null) {
                seen.add(cleaned)
            }
        }
        return seen.toList()
    }

    fun extractFromIntentTexts(texts: List<String?>): List<String> {
        val seen = LinkedHashSet<String>()
        for (text in texts) {
            if (text.isNullOrBlank()) continue
            seen.addAll(parseBatchUrls(text))
        }
        return seen.toList()
    }

    fun stripTrackingParams(url: String): String {
        val trimmed = url.trim()
        val queryStart = trimmed.indexOf('?')
        if (queryStart < 0) return trimmed

        val fragmentStart = trimmed.indexOf('#', startIndex = queryStart)
        val base = trimmed.substring(0, queryStart)
        val rawQuery = if (fragmentStart >= 0) {
            trimmed.substring(queryStart + 1, fragmentStart)
        } else {
            trimmed.substring(queryStart + 1)
        }
        val fragment = if (fragmentStart >= 0) trimmed.substring(fragmentStart) else ""

        if (rawQuery.isEmpty()) return "$base$fragment"

        val kept = rawQuery.split('&').filter { segment ->
            if (segment.isEmpty()) return@filter false
            val eq = segment.indexOf('=')
            val rawKey = if (eq >= 0) segment.substring(0, eq) else segment
            val decodedKey = runCatching {
                URLDecoder.decode(rawKey, StandardCharsets.UTF_8.name())
            }.getOrDefault(rawKey)
            val normalizedKey = decodedKey.trim().lowercase()
            !isTrackingParam(normalizedKey)
        }

        return if (kept.isEmpty()) {
            "$base$fragment"
        } else {
            "$base?${kept.joinToString("&")}$fragment"
        }
    }

    fun extractCleanUrls(texts: List<String?>): List<String> {
        val seen = LinkedHashSet<String>()
        for (url in extractFromIntentTexts(texts)) {
            seen.add(stripTrackingParams(url))
        }
        return seen.toList()
    }

    private fun isTrackingParam(nameLower: String): Boolean {
        return nameLower in trackingParamDenylist || nameLower.startsWith("utm_")
    }

    private fun cleanCandidate(raw: String): String? {
        var candidate = raw
        while (trailingPunctuation.containsMatchIn(candidate)) {
            val last = candidate.last()
            if (last == ')' && candidate.count { it == '(' } >= candidate.count { it == ')' }) {
                break
            }
            candidate = candidate.dropLast(1)
        }
        return validateHttpUrl(candidate)
    }

    private fun validateHttpUrl(candidate: String): String? {
        if (candidate.length > MAX_URL_LENGTH) return null
        return try {
            val uri = URI(candidate)
            val scheme = uri.scheme?.lowercase()
            if (
                (scheme == "http" || scheme == "https") &&
                !uri.host.isNullOrBlank() &&
                uri.userInfo.isNullOrEmpty()
            ) {
                uri.toASCIIString()
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }
}
