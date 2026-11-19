package dev.sera.toolkit.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.sera.toolkit.domain.HistoryEntry
import dev.sera.toolkit.domain.HistoryModel
import dev.sera.toolkit.model.MediaKind
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

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
)

private val Context.seraDataStore: DataStore<Preferences> by preferencesDataStore(name = "sera_prefs")

const val DEFAULT_SERVER_URL = "http://10.0.2.2:4000"

class SeraPreferences(private val context: Context) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private object Keys {
        val SERVER_URL = stringPreferencesKey("sera_server_url")
        val THEME = stringPreferencesKey("sera_theme")
        val PREFERRED_KIND = stringPreferencesKey("sera_preferred_kind")
        val AUTO_SAVE = booleanPreferencesKey("sera_auto_save")
        val HISTORY = stringPreferencesKey("sera_history")
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
            else -> null
        }
        val autoSave = prefs[Keys.AUTO_SAVE] ?: true
        UserSettings(
            serverUrl = serverUrl,
            themePreference = theme,
            preferredKind = kind,
            autoSaveToDevice = autoSave,
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

    suspend fun setServerUrl(url: String) {
        val normalized = SeraApiClient.normalizeBaseUrl(url)
        context.seraDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = normalized
        }
    }

    suspend fun setThemePreference(preference: ThemePreference) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.THEME] = preference.storageValue
        }
    }

    suspend fun setPreferredKind(kind: MediaKind) {
        val value = when (kind) {
            MediaKind.VIDEO -> "video"
            MediaKind.AUDIO -> "audio"
            MediaKind.IMAGE -> "image"
            MediaKind.GIF -> "gif"
            MediaKind.UNKNOWN -> return
        }
        context.seraDataStore.edit { prefs ->
            prefs[Keys.PREFERRED_KIND] = value
        }
    }

    suspend fun setAutoSaveToDevice(enabled: Boolean) {
        context.seraDataStore.edit { prefs ->
            prefs[Keys.AUTO_SAVE] = enabled
        }
    }

    suspend fun addHistoryEntry(entry: HistoryEntry) {
        context.seraDataStore.edit { prefs ->
            val current = decodeHistory(prefs[Keys.HISTORY])
            val next = HistoryModel.addEntry(current, entry)
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

    private fun decodeHistory(raw: String?): List<HistoryEntry> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<HistoryEntry>>(raw)
        } catch (_: Exception) {
            emptyList()
        }
    }
}
