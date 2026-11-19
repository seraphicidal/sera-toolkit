package dev.sera.node.updater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import dev.sera.node.ServiceLocator
import java.io.File

class AppUpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val statusMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val apkPath = intent.getStringExtra(EXTRA_APK_PATH)
        val versionCode = intent.getIntExtra(EXTRA_VERSION_CODE, 0)

        val logStore = ServiceLocator.logStore(context)
        val coordinator = ServiceLocator.updateCoordinator(context)
        val notifications = ServiceLocator.notificationManager(context)

        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmIntent = IntentCompat.getParcelableExtra(
                    intent,
                    Intent.EXTRA_INTENT,
                    Intent::class.java,
                )
                if (confirmIntent != null) {
                    confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    logStore.info("UPDATER", "App update v$versionCode awaiting 1-tap user confirmation")
                    coordinator.onPendingUserConfirmation(versionCode, confirmIntent)
                    notifications.showAppUpdateReadyNotification(confirmIntent, versionCode)
                    runCatching { context.startActivity(confirmIntent) }
                } else if (!apkPath.isNullOrBlank()) {
                    logStore.info("UPDATER", "No intent, falling back to manual install via FileProvider")
                    val apkFile = File(apkPath)
                    val uri = androidx.core.content.FileProvider.getUriForFile(
                        context,
                        "${context.packageName}.fileprovider",
                        apkFile,
                    )
                    val installIntent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(installIntent)
                } else {
                    logStore.warn("UPDATER", "Install confirmation requested without launch intent or APK path")
                }
            }

            PackageInstaller.STATUS_SUCCESS -> {
                logStore.info("UPDATER", "App update v$versionCode installed successfully")
                if (!apkPath.isNullOrBlank()) {
                    runCatching { File(apkPath).delete() }
                }
                notifications.cancelAppUpdateNotification()
                coordinator.onInstallFinished(success = true, message = "App updated to build $versionCode")
            }

            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                logStore.warn("UPDATER", "App update v$versionCode aborted by user")
                coordinator.onInstallFinished(success = false, message = "Update installation cancelled")
            }

            else -> {
                val msg = statusMessage?.ifBlank { null } ?: "Install failed (status $status)"
                logStore.error("UPDATER", "App update v$versionCode failed: $msg")
                if (!apkPath.isNullOrBlank()) {
                    runCatching { File(apkPath).delete() }
                }
                coordinator.onInstallFinished(success = false, message = msg)
            }
        }
    }

    companion object {
        const val EXTRA_APK_PATH = "dev.sera.node.extra.APK_PATH"
        const val EXTRA_VERSION_CODE = "dev.sera.node.extra.VERSION_CODE"
    }
}
