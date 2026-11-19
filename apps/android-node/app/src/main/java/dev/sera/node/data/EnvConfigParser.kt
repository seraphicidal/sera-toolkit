package dev.sera.node.data

data class ParsedEnvConfig(
    val apiBaseUrl: String? = null,
    val nodeToken: String? = null,
    val nodeId: String? = null,
    val enableYoutube: Boolean? = null,
    val enableInstagram: Boolean? = null,
    val instagramSessionId: String? = null,
    val youtubePlayerClients: String? = null,
    val youtubePotProviderUrl: String? = null,
    val preferredCapacity: Int? = null,
    val allowCellular: Boolean? = null,
    val allowWifi: Boolean? = null,
    val onlyWhileCharging: Boolean? = null,
    val githubReleasesRepo: String? = null,
    val importedFields: List<String> = emptyList(),
)

object EnvConfigParser {
    fun parse(rawText: String): ParsedEnvConfig {
        val values = linkedMapOf<String, String>()
        for (rawLine in rawText.lineSequence()) {
            val trimmed = rawLine.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
            val line = if (trimmed.startsWith("export ")) {
                trimmed.removePrefix("export ").trimStart()
            } else {
                trimmed
            }
            val eqIndex = line.indexOf('=')
            if (eqIndex <= 0) continue
            val key = line.substring(0, eqIndex).trim()
            if (key.isEmpty()) continue
            val rawVal = line.substring(eqIndex + 1).trim()
            values[key] = unquoteValue(rawVal)
        }

        val imported = mutableListOf<String>()

        val rawApiUrl = values["SERA_API_URL"]?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        val rawDomain = values["SERA_DOMAIN"]?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        val isInternalApiUrl = rawApiUrl != null && (
            rawApiUrl.equals("http://127.0.0.1:4000", ignoreCase = true) ||
                rawApiUrl.equals("http://localhost:4000", ignoreCase = true) ||
                rawApiUrl.equals("http://api:4000", ignoreCase = true)
            )
        val apiBaseUrl = when {
            rawDomain != null && (rawApiUrl == null || isInternalApiUrl) ->
                NodeSettings.normalizeBaseUrl(rawDomain).also { imported += "Server URL" }
            rawApiUrl != null ->
                NodeSettings.normalizeBaseUrl(rawApiUrl).also { imported += "Server URL" }
            else -> null
        }

        val explicitNodeId = values["SERA_NODE_ID"]?.trim()?.takeIf { it.isNotEmpty() }
        val explicitToken = values["SERA_EXTRACTION_NODE_TOKEN"]?.trim()?.takeIf { it.isNotEmpty() }
        val multiTokens = values["SERA_EXTRACTION_NODE_TOKENS"]?.trim()?.takeIf { it.isNotEmpty() }
            ?.split(',')
            ?.mapNotNull { entry ->
                val colon = entry.indexOf(':')
                if (colon > 0) {
                    val id = entry.substring(0, colon).trim()
                    val tok = entry.substring(colon + 1).trim()
                    if (id.isNotEmpty() && tok.isNotEmpty()) id to tok else null
                } else {
                    null
                }
            }
            .orEmpty()

        val matchedPair = if (explicitNodeId != null) {
            multiTokens.firstOrNull { it.first == explicitNodeId } ?: multiTokens.firstOrNull()
        } else {
            multiTokens.firstOrNull()
        }

        val nodeToken = (explicitToken ?: matchedPair?.second)
            ?.also { imported += "Node Token" }
        val nodeId = (explicitNodeId ?: matchedPair?.first)
            ?.also { imported += "Node ID" }

        var enableYoutube: Boolean? = null
        var enableInstagram: Boolean? = null
        if (values.containsKey("SERA_NODE_PROVIDERS")) {
            val rawProviders = values["SERA_NODE_PROVIDERS"].orEmpty()
                .split(',')
                .map { it.trim().lowercase() }
                .filter { it.isNotEmpty() }
            if (rawProviders.isNotEmpty()) {
                enableYoutube = rawProviders.contains("youtube")
                enableInstagram = rawProviders.contains("instagram")
                imported += "Providers"
            }
        }

        val instagramSessionId = if (values.containsKey("SERA_INSTAGRAM_SESSION_ID")) {
            val v = values["SERA_INSTAGRAM_SESSION_ID"].orEmpty().trim()
            if (v.isNotEmpty()) imported += "Instagram Session ID"
            v
        } else {
            null
        }

        val youtubePlayerClients = if (values.containsKey("SERA_YOUTUBE_PLAYER_CLIENTS")) {
            val v = values["SERA_YOUTUBE_PLAYER_CLIENTS"].orEmpty().trim()
            if (v.isNotEmpty()) imported += "YouTube Player Clients"
            v
        } else {
            null
        }

        val youtubePotProviderUrl = if (values.containsKey("SERA_YOUTUBE_POT_PROVIDER_URL")) {
            val v = values["SERA_YOUTUBE_POT_PROVIDER_URL"].orEmpty().trim().trimEnd('/')
            if (v.isNotEmpty()) imported += "YouTube PO Token URL"
            v
        } else {
            null
        }

        val preferredCapacity = values["SERA_NODE_CAPACITY"]?.trim()?.toIntOrNull()?.coerceIn(1, 8)
            ?.also { imported += "Capacity" }

        val allowCellular = parseBool(values["SERA_ALLOW_CELLULAR"])
            ?.also { imported += "Mobile Data" }
        val allowWifi = parseBool(values["SERA_ALLOW_WIFI"])
            ?.also { imported += "Wi-Fi" }
        val onlyWhileCharging = parseBool(values["SERA_ONLY_WHILE_CHARGING"])
            ?.also { imported += "Charging Only" }
        val githubReleasesRepo = values["SERA_GITHUB_REPO"]?.trim()?.takeIf { it.isNotEmpty() }
            ?.also { imported += "GitHub Repo" }

        return ParsedEnvConfig(
            apiBaseUrl = apiBaseUrl,
            nodeToken = nodeToken,
            nodeId = nodeId,
            enableYoutube = enableYoutube,
            enableInstagram = enableInstagram,
            instagramSessionId = instagramSessionId,
            youtubePlayerClients = youtubePlayerClients,
            youtubePotProviderUrl = youtubePotProviderUrl,
            preferredCapacity = preferredCapacity,
            allowCellular = allowCellular,
            allowWifi = allowWifi,
            onlyWhileCharging = onlyWhileCharging,
            githubReleasesRepo = githubReleasesRepo,
            importedFields = imported,
        )
    }

    private fun unquoteValue(raw: String): String {
        if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\'')))) {
            val inner = raw.substring(1, raw.length - 1)
            return if (raw.startsWith('"')) {
                inner
                    .replace("\\n", "\n")
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            } else {
                inner
            }
        }
        val inlineCommentIdx = raw.indexOf(" #")
        val cleaned = if (inlineCommentIdx >= 0) raw.substring(0, inlineCommentIdx) else raw
        return cleaned.trim()
    }

    private fun parseBool(raw: String?): Boolean? {
        return when (raw?.trim()?.lowercase()) {
            "1", "true", "yes", "on" -> true
            "0", "false", "no", "off" -> false
            else -> null
        }
    }
}
