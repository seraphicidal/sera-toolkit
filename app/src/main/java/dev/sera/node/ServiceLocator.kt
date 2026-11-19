package dev.sera.node

import android.content.Context
import dev.sera.node.data.NodeLogStore
import dev.sera.node.data.NodePreferences
import dev.sera.node.data.SeraNodeApiClient
import dev.sera.node.extractor.SeraExtractorFactory
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.NodeTaskRunner
import dev.sera.node.net.ConnectivityMonitor
import dev.sera.node.service.NodeNotificationManager
import dev.sera.node.service.NodeRuntimeTracker
import dev.sera.node.updater.AppSelfUpdater
import dev.sera.node.updater.UpdateCoordinator
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object ServiceLocator {
    private val lock = Any()

    @Volatile
    private var sharedHttpClient: OkHttpClient? = null

    @Volatile
    private var sharedLogStore: NodeLogStore? = null

    @Volatile
    private var sharedPreferences: NodePreferences? = null

    @Volatile
    private var sharedConnectivityMonitor: ConnectivityMonitor? = null

    @Volatile
    private var sharedApiClient: SeraNodeApiClient? = null

    @Volatile
    private var sharedToolsManager: ExtractionToolsManager? = null

    @Volatile
    private var sharedTaskRunner: NodeTaskRunner? = null

    @Volatile
    private var sharedAppSelfUpdater: AppSelfUpdater? = null

    @Volatile
    private var sharedUpdateCoordinator: UpdateCoordinator? = null

    @Volatile
    private var sharedNotificationManager: NodeNotificationManager? = null

    private val sharedRuntimeTracker = NodeRuntimeTracker()

    fun runtimeTracker(): NodeRuntimeTracker = sharedRuntimeTracker

    fun httpClient(): OkHttpClient {
        return sharedHttpClient ?: synchronized(lock) {
            sharedHttpClient ?: OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
                .also { sharedHttpClient = it }
        }
    }

    fun logStore(context: Context): NodeLogStore {
        return sharedLogStore ?: synchronized(lock) {
            sharedLogStore ?: NodeLogStore().also { sharedLogStore = it }
        }
    }

    fun preferences(context: Context): NodePreferences {
        val app = context.applicationContext
        return sharedPreferences ?: synchronized(lock) {
            sharedPreferences ?: NodePreferences(app).also { sharedPreferences = it }
        }
    }

    fun connectivityMonitor(context: Context): ConnectivityMonitor {
        val app = context.applicationContext
        return sharedConnectivityMonitor ?: synchronized(lock) {
            sharedConnectivityMonitor ?: ConnectivityMonitor(app).also { sharedConnectivityMonitor = it }
        }
    }

    fun apiClient(context: Context): SeraNodeApiClient {
        return sharedApiClient ?: synchronized(lock) {
            sharedApiClient ?: SeraNodeApiClient(httpClient()).also { sharedApiClient = it }
        }
    }

    fun toolsManager(context: Context): ExtractionToolsManager {
        val app = context.applicationContext
        return sharedToolsManager ?: synchronized(lock) {
            sharedToolsManager ?: SeraExtractorFactory.createToolsManager(app).also {
                sharedToolsManager = it
            }
        }
    }

    fun taskRunner(context: Context): NodeTaskRunner {
        val app = context.applicationContext
        return sharedTaskRunner ?: synchronized(lock) {
            sharedTaskRunner ?: SeraExtractorFactory.createTaskRunner(
                app,
                toolsManager(app),
                httpClient(),
            ).also { sharedTaskRunner = it }
        }
    }

    fun appSelfUpdater(context: Context): AppSelfUpdater {
        val app = context.applicationContext
        return sharedAppSelfUpdater ?: synchronized(lock) {
            sharedAppSelfUpdater ?: AppSelfUpdater(httpClient(), logStore(app)).also {
                sharedAppSelfUpdater = it
            }
        }
    }

    fun updateCoordinator(context: Context): UpdateCoordinator {
        val app = context.applicationContext
        return sharedUpdateCoordinator ?: synchronized(lock) {
            sharedUpdateCoordinator ?: UpdateCoordinator(
                context = app,
                preferences = preferences(app),
                apiClient = apiClient(app),
                toolsManager = toolsManager(app),
                appSelfUpdater = appSelfUpdater(app),
                connectivityMonitor = connectivityMonitor(app),
                logStore = logStore(app),
            ).also { sharedUpdateCoordinator = it }
        }
    }

    fun notificationManager(context: Context): NodeNotificationManager {
        val app = context.applicationContext
        return sharedNotificationManager ?: synchronized(lock) {
            sharedNotificationManager ?: NodeNotificationManager(app).also {
                sharedNotificationManager = it
            }
        }
    }
}
