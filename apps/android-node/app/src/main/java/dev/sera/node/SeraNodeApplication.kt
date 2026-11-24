package dev.sera.node

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

class SeraNodeApplication : Application() {
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        ServiceLocator.notificationManager(this).ensureChannels()
        ServiceLocator.connectivityMonitor(this).start()
        ServiceLocator.logStore(this).info(
            "SERVICE",
            "SERA Node v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) initialized",
        )
        appScope.launch {
            runCatching { ServiceLocator.preferences(this@SeraNodeApplication).migratePlaintextSecretsIfNeeded() }
            reapOrphanedWorkDirectories(cacheDir)
        }
    }

    companion object {
        fun reapOrphanedWorkDirectories(cacheRoot: File) {
            for (dirName in listOf("work", "sera-work")) {
                val base = File(cacheRoot, dirName)
                if (!base.isDirectory) continue
                val baseCanonical = runCatching { base.canonicalPath }.getOrNull() ?: continue
                base.listFiles()?.forEach { child ->
                    runCatching {
                        val childCanonical = child.canonicalPath
                        if (childCanonical.startsWith(baseCanonical + File.separator)) {
                            child.deleteRecursively()
                        }
                    }
                }
            }
        }
    }
}
