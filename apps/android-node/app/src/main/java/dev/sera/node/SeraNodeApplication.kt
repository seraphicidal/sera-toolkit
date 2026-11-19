package dev.sera.node

import android.app.Application

class SeraNodeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ServiceLocator.notificationManager(this).ensureChannels()
        ServiceLocator.connectivityMonitor(this).start()
        ServiceLocator.logStore(this).info(
            "SERVICE",
            "SERA Node v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) initialized",
        )
    }
}
