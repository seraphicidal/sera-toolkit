package dev.sera.toolkit.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.sera.toolkit.BuildConfig
import dev.sera.toolkit.domain.HistoryEntry
import dev.sera.toolkit.domain.HistoryModel
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.SeraJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString

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

data class UserSettings(
    val serverUrl: String = DEFAULT_SERVER_URL,
    val themePreference: ThemePreference = ThemePreference.SYSTEM,
    val preferredKind: MediaKind? = null,
    val autoSaveToDevice: Boolean = true,
    val quickDownload: Boolean = false,
    val wifiOnly: Boolean = false,
    val notificationsPrompted: Boolean = false,
)

private val Context.seraDataStore: DataStore<Preferences> by preferencesDataStore(name = "sera_prefs")

val DEFAULT_SERVER_URL: String
    get() = BuildConfig.DEFAULT_SERVER_URL

class SeraPreferences(private val context: Context) {
    private val json = SeraJson

    private object Keys {
        val SERVER_URL = stringPreferencesKey("sera_server_url")
        val THEME = stringPreferencesKey("sera_theme")
        val PREFERRED_KIND = stringPreferencesKey("sera_preferred_kind")
        val AUTO_SAVE = booleanPreferencesKey("sera_auto_save")
        val QUICK_DOWNLOAD = booleanPreferencesKey("sera_quick_download")
        val WIFI_ONLY = booleanPreferencesKey("sera_wifi_only")
        val NOTIFICATIONS_PROMPTED = booleanPreferencesKey("sera_notifications_prompted")
        val HISTORY = stringPreferencesKey("sera_history")
        val DOWNLOAD_TASKS = stringPreferencesKey("sera_download_tasks")
    }

    val settings: Flow<UserSettings> = context.seraDataStore.data.map { prefs ->
        val rawUrl = prefs[Keys.SERVER_URL]?.trim()
        val serverUrl = if (!rawUrl.isNullOrEmpty()) SeraApiClient.normalizeBaseUrl(rawUrl) else DEFAULT_SERVER_URL
        val theme = ThemePreference.fromStorage(prefs[Keys.THEME])
        val kind = when (prefs[Keys.PREFERRED_KIND]) {
            "video" -> MediaKind.VIDEO
            "audio" -> MediaKind.AUDIO
            "image" -> MediaKind.IMAGE
            "gif" -> MediaKind.GIF
            "file" -> MediaKind.FILE
            else -> null
        }
        val autoSave = prefs[Keys.AUTO_SAVE] ?: true
        val quickDownload = prefs[Keys.QUICK_DOWNLOAD] ?: false
        val wifiOnly = prefs[Keys.WIFI_ONLY] ?: false
        val notificationsPrompted = prefs[Keys.NOTIFICATIONS_PROMPTED] ?: false
        UserSettings(
            serverUrl = serverUrl,
            themePreference = theme,
            preferredKind = kind,
            autoSaveToDevice = autoSave,
            quickDownload = quickDownload,
            wifiOnly = wifiOnly,
            notificationsPrompted = notificationsPrompted,
        )
    }

    val history: Flow<List<HistoryEntry>> = context.seraDataStore.data.map { prefs ->
        val raw = prefs[Keys.HISTORY] ?: return@map emptyList()
        try {
            json.decodeFromString<List<HistoryEntry>>(raw).take(HistoryModel.HISTORY_LIMIT)
        } catch (_: Exception) {
            emptyList()
        }
    }

    val downloadTasks: Flow<List<DownloadTaskRecord>> = context.seraDataStore.data.map { prefs ->
        decodeTasks(prefs[Keys.DOWNLOAD_TASKS])
    }

    suspend fun currentSettings(): UserSettings = settings.first()

    suspend fun setServerUrl(url: String) {
        val normalized = SeraApiClient.normalizeBaseUrl(url)
        context.seraDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = normalized
        }
    }

    suspend fun resetServerUrl() {
        context.seraDataStore.edit { prefs ->
            prefs.remove(Keys.SERVER_URL)
        }
    }

    suspend fun setThemePreference(preference: ThemePreference) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.THEME] = preference.storageValue
        }
    }

    suspend fun setPreferredKind(kind: MediaKind?) {
        val value = when (kind) {
            MediaKind.VIDEO -> "video"
            MediaKind.AUDIO -> "audio"
            MediaKind.IMAGE -> "image"
            MediaKind.GIF -> "gif"
            MediaKind.FILE -> "file"
            MediaKind.UNKNOWN, null -> null
        }
        context.seraDataStore.edit { prefs ->
            if (value == null) {
                prefs.remove(Keys.PREFERRED_KIND)
            } else {
                prefs[Keys.PREFERRED_KIND] = value
            }
        }
    }

    suspend fun setAutoSaveToDevice(enabled: Boolean) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.AUTO_SAVE] = enabled
        }
    }

    suspend fun setQuickDownload(enabled: Boolean) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.QUICK_DOWNLOAD] = enabled
        }
    }

    suspend fun setWifiOnly(enabled: Boolean) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.WIFI_ONLY] = enabled
        }
    }

    suspend fun setNotificationsPrompted(prompted: Boolean) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.NOTIFICATIONS_PROMPTED] = prompted
        }
    }

    suspend fun addHistoryEntry(entry: HistoryEntry) {
        context.seraDataStore.edit { prefs ->
            val current = decodeHistory(prefs[Keys.HISTORY])
            val next = HistoryModel.addEntry(current, entry)
            prefs[Keys.HISTORY] = json.encodeToString(next)
        }
    }

    suspend fun removeHistoryEntry(jobId: String) {
        context.seraDataStore.edit { prefs ->
            val current = decodeHistory(prefs[Keys.HISTORY])
            val next = HistoryModel.removeEntry(current, jobId)
            prefs[Keys.HISTORY] = json.encodeToString(next)
        }
    }

    suspend fun attachLocalUri(jobId: String, localUri: String, mimeType: String?) {
        context.seraDataStore.edit { prefs ->
            val current = decodeHistory(prefs[Keys.HISTORY])
            val next = HistoryModel.attachLocalUri(current, jobId, localUri, mimeType)
            prefs[Keys.HISTORY] = json.encodeToString(next)
        }
    }

    suspend fun clearHistory() {
        context.seraDataStore.edit { prefs ->
            prefs.remove(Keys.HISTORY)
        }
    }

    suspend fun updateDownloadTasks(transform: (List<DownloadTaskRecord>) -> List<DownloadTaskRecord>) {
        context.seraDataStore.edit { prefs ->
            val current = decodeTasks(prefs[Keys.DOWNLOAD_TASKS])
            val updated = transform(current).take(MAX_TRACKED_TASKS)
            prefs[Keys.DOWNLOAD_TASKS] = json.encodeToString(updated)
        }
    }

    suspend fun currentDownloadTasks(): List<DownloadTaskRecord> = downloadTasks.first()

    private fun decodeHistory(raw: String?): List<HistoryEntry> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<HistoryEntry>>(raw)
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun decodeTasks(raw: String?): List<DownloadTaskRecord> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<DownloadTaskRecord>>(raw)
        } catch (_: Exception) {
            emptyList()
        }
    }

    companion object {
        private const val MAX_TRACKED_TASKS = 100
    }
}
