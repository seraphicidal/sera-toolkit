package dev.sera.node.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.sera.node.extractor.ALL_OTHER_PROVIDER_IDS
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.SeraJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import java.util.concurrent.ConcurrentHashMap

enum class ThemePreference(val storageValue: String, val label: String) {
    LIGHT("light", "Light"),
    SYSTEM("system", "System"),
    DARK("dark", "Dark");

    companion object {
        fun fromStorage(raw: String?): ThemePreference {
            return entries.firstOrNull { it.storageValue == raw } ?: SYSTEM
        }
    }
}

data class NodeSettings(
    val apiBaseUrl: String = "",
    val nodeToken: String = "",
    val nodeId: String = "android-node",
    val enableYoutube: Boolean = true,
    val enableInstagram: Boolean = true,
    val enableAllProviders: Boolean = true,
    val instagramSessionId: String = "",
    val youtubePlayerClients: String = "",
    val youtubePotProviderUrl: String = "",
    val redditClientId: String = "",
    val redditClientSecret: String = "",
    val allowCellular: Boolean = true,
    val allowWifi: Boolean = true,
    val onlyWhileCharging: Boolean = false,
    val autoStartOnBoot: Boolean = true,
    val autoUpdateApp: Boolean = true,
    val autoUpdateTools: Boolean = true,
    val preferredCapacity: Int = 2,
    val githubReleasesRepo: String = DEFAULT_GITHUB_REPO,
    val cachedProviderHotConfig: ProviderHotConfig? = null,
    val cachedManifestHash: String? = null,
    val lastUpdateCheckAt: Long = 0L,
    val lastAppUpdatePromptVersion: Int = 0,
    val serviceEnabled: Boolean = false,
    val userExplicitlyStopped: Boolean = false,
    val servicePaused: Boolean = false,
    val completedTasksCount: Long = 0L,
    val failedTasksCount: Long = 0L,
    val themePreference: ThemePreference = ThemePreference.SYSTEM,
) {
    val isConfigured: Boolean
        get() = apiBaseUrl.isNotBlank() && nodeToken.isNotBlank()

    fun activeProviders(): List<String> = buildList {
        if (enableYoutube) add("youtube")
        if (enableInstagram) add("instagram")
        if (enableAllProviders) addAll(ALL_OTHER_PROVIDER_IDS)
    }

    fun toRuntimeConfig(workDirPath: String): NodeRuntimeConfig {
        return NodeRuntimeConfig(
            apiBaseUrl = normalizeBaseUrl(apiBaseUrl),
            nodeToken = nodeToken.trim(),
            nodeId = nodeId.trim().ifEmpty { "android-node" }.take(64),
            providers = activeProviders(),
            networkClass = "residential",
            instagramSessionId = instagramSessionId.trim().ifEmpty { null },
            youtubePlayerClients = youtubePlayerClients.trim().ifEmpty { null },
            youtubePotProviderUrl = youtubePotProviderUrl.trim().ifEmpty { null },
            redditClientId = redditClientId.trim().ifEmpty { null },
            redditClientSecret = redditClientSecret.trim().ifEmpty { null },
            preferredCapacity = preferredCapacity.coerceIn(1, 8),
            workDirPath = workDirPath,
        )
    }

    companion object {
        const val DEFAULT_GITHUB_REPO = "seraphicidal/sera-toolkit"

        private fun isLocalHostPrefix(lower: String): Boolean {
            return lower.startsWith("localhost") ||
                lower.startsWith("127.0.0.1") ||
                lower.startsWith("10.0.2.2") ||
                lower.startsWith("[::1]")
        }

        fun normalizeBaseUrl(raw: String): String {
            var cleaned = raw.trim().trimEnd('/')
            if (cleaned.isEmpty()) return ""
            if (!cleaned.startsWith("http://", ignoreCase = true) &&
                !cleaned.startsWith("https://", ignoreCase = true)
            ) {
                val lower = cleaned.lowercase()
                cleaned = if (isLocalHostPrefix(lower)) "http://$cleaned" else "https://$cleaned"
            }
            if (cleaned.endsWith("/api", ignoreCase = true)) {
                cleaned = cleaned.dropLast(4).trimEnd('/')
            }
            return cleaned
        }

        fun normalizePotProviderUrl(raw: String): String {
            var cleaned = raw.trim().trimEnd('/')
            if (cleaned.isEmpty()) return ""
            if (!cleaned.startsWith("http://", ignoreCase = true) &&
                !cleaned.startsWith("https://", ignoreCase = true)
            ) {
                val lower = cleaned.lowercase()
                cleaned = if (isLocalHostPrefix(lower)) "http://$cleaned" else "https://$cleaned"
            }
            return cleaned
        }
    }
}

private val Context.nodeDataStore: DataStore<Preferences> by preferencesDataStore(name = "sera_node_prefs")

class NodePreferences(private val context: Context) {
    private object Keys {
        val API_BASE_URL = stringPreferencesKey("api_base_url")
        val NODE_TOKEN = stringPreferencesKey("node_token")
        val NODE_ID = stringPreferencesKey("node_id")
        val ENABLE_YOUTUBE = booleanPreferencesKey("enable_youtube")
        val ENABLE_INSTAGRAM = booleanPreferencesKey("enable_instagram")
        val ENABLE_ALL_PROVIDERS = booleanPreferencesKey("enable_all_providers")
        val INSTAGRAM_SESSION_ID = stringPreferencesKey("instagram_session_id")
        val YOUTUBE_PLAYER_CLIENTS = stringPreferencesKey("youtube_player_clients")
        val YOUTUBE_POT_PROVIDER_URL = stringPreferencesKey("youtube_pot_provider_url")
        val REDDIT_CLIENT_ID = stringPreferencesKey("reddit_client_id")
        val REDDIT_CLIENT_SECRET = stringPreferencesKey("reddit_client_secret")
        val ALLOW_CELLULAR = booleanPreferencesKey("allow_cellular")
        val ALLOW_WIFI = booleanPreferencesKey("allow_wifi")
        val ONLY_WHILE_CHARGING = booleanPreferencesKey("only_while_charging")
        val AUTO_START_ON_BOOT = booleanPreferencesKey("auto_start_on_boot")
        val AUTO_UPDATE_APP = booleanPreferencesKey("auto_update_app")
        val AUTO_UPDATE_TOOLS = booleanPreferencesKey("auto_update_tools")
        val PREFERRED_CAPACITY = intPreferencesKey("preferred_capacity")
        val GITHUB_RELEASES_REPO = stringPreferencesKey("github_releases_repo")
        val CACHED_PROVIDER_HOT_CONFIG = stringPreferencesKey("cached_provider_hot_config")
        val CACHED_MANIFEST_HASH = stringPreferencesKey("cached_manifest_hash")
        val LAST_UPDATE_CHECK_AT = longPreferencesKey("last_update_check_at")
        val LAST_APP_UPDATE_PROMPT_VERSION = intPreferencesKey("last_app_update_prompt_version")
        val SERVICE_ENABLED = booleanPreferencesKey("service_enabled")
        val USER_EXPLICITLY_STOPPED = booleanPreferencesKey("user_explicitly_stopped")
        val SERVICE_PAUSED = booleanPreferencesKey("service_paused")
        val COMPLETED_TASKS_COUNT = longPreferencesKey("completed_tasks_count")
        val FAILED_TASKS_COUNT = longPreferencesKey("failed_tasks_count")
        val THEME_PREFERENCE = stringPreferencesKey("theme_preference")
    }

    @Volatile
    private var cachedHotConfigEntry: Pair<String, ProviderHotConfig?>? = null

    private val decryptedSecretCache = ConcurrentHashMap<String, String>()

    private fun decodeHotConfig(rawHotConfig: String?): ProviderHotConfig? {
        if (rawHotConfig.isNullOrBlank()) return null
        val cached = cachedHotConfigEntry
        if (cached != null && cached.first == rawHotConfig) {
            return cached.second
        }
        val parsed = runCatching { SeraJson.decodeFromString<ProviderHotConfig>(rawHotConfig) }.getOrNull()
        cachedHotConfigEntry = rawHotConfig to parsed
        return parsed
    }

    private fun decryptSecret(stored: String?): String {
        if (stored.isNullOrEmpty()) return ""
        decryptedSecretCache[stored]?.let { return it }
        val decrypted = SecretCipher.decrypt(stored).trim()
        if (decryptedSecretCache.size > 32) {
            decryptedSecretCache.clear()
        }
        decryptedSecretCache[stored] = decrypted
        return decrypted
    }

    private fun encryptSecret(plaintext: String): String {
        val trimmed = plaintext.trim()
        if (trimmed.isEmpty()) return ""
        return SecretCipher.encrypt(trimmed)
    }

    val settings: Flow<NodeSettings> = context.nodeDataStore.data.map { prefs ->
        val parsedHotConfig = decodeHotConfig(prefs[Keys.CACHED_PROVIDER_HOT_CONFIG])
        NodeSettings(
            apiBaseUrl = NodeSettings.normalizeBaseUrl(prefs[Keys.API_BASE_URL].orEmpty()),
            nodeToken = decryptSecret(prefs[Keys.NODE_TOKEN]),
            nodeId = prefs[Keys.NODE_ID]?.trim()?.ifEmpty { "android-node" }?.take(64) ?: "android-node",
            enableYoutube = prefs[Keys.ENABLE_YOUTUBE] ?: true,
            enableInstagram = prefs[Keys.ENABLE_INSTAGRAM] ?: true,
            enableAllProviders = prefs[Keys.ENABLE_ALL_PROVIDERS] ?: true,
            instagramSessionId = decryptSecret(prefs[Keys.INSTAGRAM_SESSION_ID]),
            youtubePlayerClients = prefs[Keys.YOUTUBE_PLAYER_CLIENTS].orEmpty().trim(),
            youtubePotProviderUrl = NodeSettings.normalizePotProviderUrl(
                prefs[Keys.YOUTUBE_POT_PROVIDER_URL].orEmpty(),
            ),
            redditClientId = prefs[Keys.REDDIT_CLIENT_ID].orEmpty().trim(),
            redditClientSecret = decryptSecret(prefs[Keys.REDDIT_CLIENT_SECRET]),
            allowCellular = prefs[Keys.ALLOW_CELLULAR] ?: true,
            allowWifi = prefs[Keys.ALLOW_WIFI] ?: true,
            onlyWhileCharging = prefs[Keys.ONLY_WHILE_CHARGING] ?: false,
            autoStartOnBoot = prefs[Keys.AUTO_START_ON_BOOT] ?: true,
            autoUpdateApp = prefs[Keys.AUTO_UPDATE_APP] ?: true,
            autoUpdateTools = prefs[Keys.AUTO_UPDATE_TOOLS] ?: true,
            preferredCapacity = (prefs[Keys.PREFERRED_CAPACITY] ?: 2).coerceIn(1, 8),
            githubReleasesRepo = prefs[Keys.GITHUB_RELEASES_REPO]?.trim()?.ifEmpty { NodeSettings.DEFAULT_GITHUB_REPO }
                ?: NodeSettings.DEFAULT_GITHUB_REPO,
            cachedProviderHotConfig = parsedHotConfig,
            cachedManifestHash = prefs[Keys.CACHED_MANIFEST_HASH]?.trim()?.ifEmpty { null },
            lastUpdateCheckAt = prefs[Keys.LAST_UPDATE_CHECK_AT] ?: 0L,
            lastAppUpdatePromptVersion = prefs[Keys.LAST_APP_UPDATE_PROMPT_VERSION] ?: 0,
            serviceEnabled = prefs[Keys.SERVICE_ENABLED] ?: false,
            userExplicitlyStopped = prefs[Keys.USER_EXPLICITLY_STOPPED] ?: false,
            servicePaused = prefs[Keys.SERVICE_PAUSED] ?: false,
            completedTasksCount = prefs[Keys.COMPLETED_TASKS_COUNT] ?: 0L,
            failedTasksCount = prefs[Keys.FAILED_TASKS_COUNT] ?: 0L,
            themePreference = ThemePreference.fromStorage(prefs[Keys.THEME_PREFERENCE]),
        )
    }

    suspend fun current(): NodeSettings = settings.first()

    suspend fun migratePlaintextSecretsIfNeeded() {
        context.nodeDataStore.edit { prefs ->
            for (key in listOf(Keys.NODE_TOKEN, Keys.INSTAGRAM_SESSION_ID, Keys.REDDIT_CLIENT_SECRET)) {
                val raw = prefs[key]
                if (!raw.isNullOrBlank() && !SecretCipher.isEncrypted(raw)) {
                    prefs[key] = SecretCipher.encrypt(raw.trim())
                }
            }
        }
    }

    suspend fun setThemePreference(preference: ThemePreference) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.THEME_PREFERENCE] = preference.storageValue
        }
    }

    suspend fun setServicePaused(paused: Boolean) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.SERVICE_PAUSED] = paused
        }
    }

    suspend fun saveConfiguration(
        apiBaseUrl: String,
        nodeToken: String,
        nodeId: String,
        enableYoutube: Boolean,
        enableInstagram: Boolean,
        enableAllProviders: Boolean = true,
        instagramSessionId: String,
        youtubePlayerClients: String,
        youtubePotProviderUrl: String,
        redditClientId: String = "",
        redditClientSecret: String = "",
        allowCellular: Boolean,
        allowWifi: Boolean,
        onlyWhileCharging: Boolean,
        autoStartOnBoot: Boolean,
        autoUpdateApp: Boolean,
        autoUpdateTools: Boolean,
        preferredCapacity: Int,
        githubReleasesRepo: String,
        themePreference: ThemePreference,
    ) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.API_BASE_URL] = NodeSettings.normalizeBaseUrl(apiBaseUrl)
            prefs[Keys.NODE_TOKEN] = encryptSecret(nodeToken)
            prefs[Keys.NODE_ID] = nodeId.trim().ifEmpty { "android-node" }.take(64)
            prefs[Keys.ENABLE_YOUTUBE] = enableYoutube
            prefs[Keys.ENABLE_INSTAGRAM] = enableInstagram
            prefs[Keys.ENABLE_ALL_PROVIDERS] = enableAllProviders
            prefs[Keys.INSTAGRAM_SESSION_ID] = encryptSecret(instagramSessionId)
            prefs[Keys.YOUTUBE_PLAYER_CLIENTS] = youtubePlayerClients.trim()
            prefs[Keys.YOUTUBE_POT_PROVIDER_URL] = NodeSettings.normalizePotProviderUrl(youtubePotProviderUrl)
            prefs[Keys.REDDIT_CLIENT_ID] = redditClientId.trim()
            prefs[Keys.REDDIT_CLIENT_SECRET] = encryptSecret(redditClientSecret)
            prefs[Keys.ALLOW_CELLULAR] = allowCellular
            prefs[Keys.ALLOW_WIFI] = allowWifi
            prefs[Keys.ONLY_WHILE_CHARGING] = onlyWhileCharging
            prefs[Keys.AUTO_START_ON_BOOT] = autoStartOnBoot
            prefs[Keys.AUTO_UPDATE_APP] = autoUpdateApp
            prefs[Keys.AUTO_UPDATE_TOOLS] = autoUpdateTools
            prefs[Keys.PREFERRED_CAPACITY] = preferredCapacity.coerceIn(1, 8)
            prefs[Keys.GITHUB_RELEASES_REPO] = githubReleasesRepo.trim().ifEmpty { NodeSettings.DEFAULT_GITHUB_REPO }
            prefs[Keys.THEME_PREFERENCE] = themePreference.storageValue
        }
    }

    suspend fun applyImportedEnv(parsed: ParsedEnvConfig) {
        context.nodeDataStore.edit { prefs ->
            parsed.apiBaseUrl?.let { prefs[Keys.API_BASE_URL] = NodeSettings.normalizeBaseUrl(it) }
            parsed.nodeToken?.takeIf { it.isNotBlank() }?.let { prefs[Keys.NODE_TOKEN] = encryptSecret(it) }
            parsed.nodeId?.let { prefs[Keys.NODE_ID] = it.trim().ifEmpty { "android-node" }.take(64) }
            parsed.enableYoutube?.let { prefs[Keys.ENABLE_YOUTUBE] = it }
            parsed.enableInstagram?.let { prefs[Keys.ENABLE_INSTAGRAM] = it }
            parsed.enableAllProviders?.let { prefs[Keys.ENABLE_ALL_PROVIDERS] = it }
            parsed.instagramSessionId?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.INSTAGRAM_SESSION_ID] = encryptSecret(it)
            }
            parsed.youtubePlayerClients?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.YOUTUBE_PLAYER_CLIENTS] = it.trim()
            }
            parsed.youtubePotProviderUrl?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.YOUTUBE_POT_PROVIDER_URL] = NodeSettings.normalizePotProviderUrl(it)
            }
            parsed.redditClientId?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.REDDIT_CLIENT_ID] = it.trim()
            }
            parsed.redditClientSecret?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.REDDIT_CLIENT_SECRET] = encryptSecret(it)
            }
            parsed.preferredCapacity?.let { prefs[Keys.PREFERRED_CAPACITY] = it.coerceIn(1, 8) }
            parsed.allowCellular?.let { prefs[Keys.ALLOW_CELLULAR] = it }
            parsed.allowWifi?.let { prefs[Keys.ALLOW_WIFI] = it }
            parsed.onlyWhileCharging?.let { prefs[Keys.ONLY_WHILE_CHARGING] = it }
            parsed.githubReleasesRepo?.takeIf { it.isNotBlank() }?.let {
                prefs[Keys.GITHUB_RELEASES_REPO] = it.trim()
            }
        }
    }

    suspend fun saveManifestCache(hash: String, hotConfig: ProviderHotConfig) {
        val serialized = SeraJson.encodeToString(hotConfig)
        cachedHotConfigEntry = serialized to hotConfig
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.CACHED_MANIFEST_HASH] = hash
            prefs[Keys.CACHED_PROVIDER_HOT_CONFIG] = serialized
        }
    }

    suspend fun setLastUpdateCheckAt(timestampMs: Long) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.LAST_UPDATE_CHECK_AT] = timestampMs
        }
    }

    suspend fun setLastAppUpdatePromptVersion(versionCode: Int) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.LAST_APP_UPDATE_PROMPT_VERSION] = versionCode
        }
    }

    suspend fun setServiceEnabled(enabled: Boolean, explicitStop: Boolean = false) {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.SERVICE_ENABLED] = enabled
            prefs[Keys.USER_EXPLICITLY_STOPPED] = explicitStop
            if (!enabled) {
                prefs[Keys.SERVICE_PAUSED] = false
            }
        }
    }

    suspend fun recordTaskCompleted() {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.COMPLETED_TASKS_COUNT] = (prefs[Keys.COMPLETED_TASKS_COUNT] ?: 0L) + 1L
        }
    }

    suspend fun recordTaskFailed() {
        context.nodeDataStore.edit { prefs ->
            prefs[Keys.FAILED_TASKS_COUNT] = (prefs[Keys.FAILED_TASKS_COUNT] ?: 0L) + 1L
        }
    }
}
