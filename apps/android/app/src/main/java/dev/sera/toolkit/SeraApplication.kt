package dev.sera.toolkit

import android.app.Application
import dev.sera.toolkit.data.DeviceDownloadManager
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.SeraPreferences

class SeraApplication : Application() {
    lateinit var preferences: SeraPreferences
        private set
    lateinit var apiClient: SeraApiClient
        private set
    lateinit var downloadManager: DeviceDownloadManager
        private set

    override fun onCreate() {
        super.onCreate()
        preferences = SeraPreferences(this)
        apiClient = SeraApiClient()
        downloadManager = DeviceDownloadManager(this, apiClient.httpClient)
    }
}
