package dev.sera.node.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.core.os.UserManagerCompat
import dev.sera.node.ServiceLocator
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class BootAndUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val supported = action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (!supported) return

        if (!UserManagerCompat.isUserUnlocked(context)) {
            return
        }

        val pendingResult = goAsync()
        val appContext = context.applicationContext
        val exceptionHandler = CoroutineExceptionHandler { _, error ->
            runCatching {
                ServiceLocator.logStore(appContext)
                    .warn("SERVICE", "Boot receiver failed on $action: ${error.message}")
            }
        }
        CoroutineScope(SupervisorJob() + Dispatchers.IO + exceptionHandler).launch {
            try {
                withTimeoutOrNull(8_000L) {
                    val settings = ServiceLocator.preferences(appContext).current()
                    val shouldStart = when (action) {
                        Intent.ACTION_MY_PACKAGE_REPLACED ->
                            settings.serviceEnabled ||
                                (settings.autoStartOnBoot && settings.isConfigured && !settings.userExplicitlyStopped)
                        else ->
                            settings.autoStartOnBoot && settings.isConfigured && !settings.userExplicitlyStopped
                    }
                    if (!shouldStart) return@withTimeoutOrNull

                    ServiceLocator.logStore(appContext)
                        .info("SERVICE", "Auto-starting extraction node on $action")
                    val serviceIntent = Intent(appContext, NodeForegroundService::class.java).apply {
                        this.action = NodeForegroundService.ACTION_START
                    }
                    try {
                        ContextCompat.startForegroundService(appContext, serviceIntent)
                    } catch (error: Exception) {
                        ServiceLocator.logStore(appContext)
                            .warn("SERVICE", "Background FGS start blocked on $action: ${error.message}")
                        ServiceLocator.notificationManager(appContext).showBootStartFallbackNotification()
                    }
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}
