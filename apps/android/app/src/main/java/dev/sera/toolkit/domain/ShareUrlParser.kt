package dev.sera.toolkit.domain

import java.net.URI

object ShareUrlParser {
    private const val MAX_URL_LENGTH = 8_192
    private val trailingPunctuation = Regex("[.,;:!?'\"\\)\\]\\}>]+$")
    private val linkPattern = Regex("https?://[^\\s<>\"'`]+", RegexOption.IGNORE_CASE)

    fun firstHttpUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val match = linkPattern.find(text) ?: return null
        var candidate = match.value
        while (trailingPunctuation.containsMatchIn(candidate)) {
            val last = candidate.last()
            if (last == ')' && candidate.count { it == '(' } >= candidate.count { it == ')' }) {
                break
            }
            candidate = candidate.dropLast(1)
        }
        return validateHttpUrl(candidate)
    }

    fun parseBatchUrls(text: String?): List<String> {
        if (text.isNullOrBlank()) return emptyList()
        val seen = LinkedHashSet<String>()
        for (rawLine in text.split(Regex("\\r?\\n"))) {
            val trimmed = rawLine.trim()
            if (trimmed.isEmpty()) continue
            val extracted = firstHttpUrl(trimmed)
            if (extracted != null) {
                seen.add(extracted)
            }
        }
        return seen.toList()
    }

    fun extractFromIntentTexts(texts: List<String?>): List<String> {
        val seen = LinkedHashSet<String>()
        for (text in texts) {
            if (text.isNullOrBlank()) continue
            val batch = parseBatchUrls(text)
            if (batch.isNotEmpty()) {
                seen.addAll(batch)
            } else {
                firstHttpUrl(text)?.let { seen.add(it) }
            }
        }
        return seen.toList()
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
