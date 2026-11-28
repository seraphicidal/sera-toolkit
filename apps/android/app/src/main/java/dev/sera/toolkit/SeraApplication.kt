package dev.sera.toolkit

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import dev.sera.toolkit.data.DeviceDownloadManager
import dev.sera.toolkit.data.GitHubUpdateChecker
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.SeraPreferences
import dev.sera.toolkit.worker.DownloadCoordinator

class SeraApplication : Application(), ImageLoaderFactory {
    lateinit var preferences: SeraPreferences
        private set
    lateinit var apiClient: SeraApiClient
        private set
    lateinit var downloadManager: DeviceDownloadManager
        private set
    lateinit var downloadCoordinator: DownloadCoordinator
        private set
    lateinit var updateChecker: GitHubUpdateChecker
        private set

    override fun onCreate() {
        super.onCreate()
        preferences = SeraPreferences(this)
        apiClient = SeraApiClient()
        downloadManager = DeviceDownloadManager(this, apiClient.httpClient)
        downloadCoordinator = DownloadCoordinator(this, preferences, apiClient)
        updateChecker = GitHubUpdateChecker(apiClient.httpClient)
    }

    override fun newImageLoader(): ImageLoader {
        return ImageLoader.Builder(this)
            .okHttpClient(apiClient.httpClient)
            .crossfade(true)
            .build()
    }
}
