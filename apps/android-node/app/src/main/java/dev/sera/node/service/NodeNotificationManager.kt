package dev.sera.node.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import dev.sera.node.MainActivity
import dev.sera.node.R
import dev.sera.node.model.NetworkTransport

class NodeNotificationManager(private val context: Context) {
    private val appContext = context.applicationContext
    private val manager =
        appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    @Volatile
    private var channelsReady = false

    fun ensureChannels() {
        if (channelsReady) return
        val statusChannel = NotificationChannel(
            CHANNEL_NODE_STATUS,
            "Extraction Node Status",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Persistent status for the background SERA extraction node"
            setShowBadge(false)
        }

        val updatesChannel = NotificationChannel(
            CHANNEL_APP_UPDATES,
            "Node & App Updates",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Notifications when SERA Node app updates require 1-tap install confirmation"
        }

        manager.createNotificationChannel(statusChannel)
        manager.createNotificationChannel(updatesChannel)
        channelsReady = true
    }

    fun buildStatusNotification(
        snapshot: NodeRuntimeSnapshot,
        totalCompleted: Long,
        isPaused: Boolean,
    ): Notification {
        ensureChannels()

        val openAppIntent = PendingIntent.getActivity(
            appContext,
            100,
            Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val transportLabel = when (snapshot.transport) {
            NetworkTransport.CELLULAR -> "5G/LTE"
            NetworkTransport.WIFI -> "Wi-Fi"
            NetworkTransport.OTHER -> "Online"
            NetworkTransport.NONE -> "Offline"
        }

        val title = when (snapshot.serviceState) {
            NodeServiceState.RUNNING_TASK -> "SERA Node • $transportLabel • Working"
            NodeServiceState.PAUSED -> "SERA Node • Paused"
            NodeServiceState.AUTH_ERROR -> "SERA Node • Auth Error"
            NodeServiceState.WAITING_CHARGING -> "SERA Node • Waiting for Charger"
            NodeServiceState.WAITING_NETWORK -> "SERA Node • Waiting for Network"
            else -> "SERA Node • $transportLabel"
        }

        val active = snapshot.activeTasks.firstOrNull()
        val text = when {
            active != null -> {
                val pct = active.percent.toInt().coerceIn(0, 100)
                val extra = if (snapshot.activeTasks.size > 1) " (+${snapshot.activeTasks.size - 1})" else ""
                "${active.providerId.uppercase()} ${active.kind}: ${active.step} ($pct%)$extra • $totalCompleted done"
            }
            snapshot.serviceState == NodeServiceState.AUTH_ERROR ->
                snapshot.lastError ?: "Check node token in Settings"
            snapshot.serviceState == NodeServiceState.RECONNECTING ->
                "Reconnecting... • $totalCompleted done"
            snapshot.serviceState == NodeServiceState.UPDATING ->
                "Checking or applying updates • $totalCompleted done"
            snapshot.serviceState == NodeServiceState.PAUSED ->
                "Node paused • $totalCompleted done"
            snapshot.serviceState == NodeServiceState.WAITING_CHARGING ->
                "Paused until device is charging • $totalCompleted done"
            snapshot.serviceState == NodeServiceState.WAITING_NETWORK ->
                "Waiting for allowed connection • $totalCompleted done"
            snapshot.serviceState == NodeServiceState.UNCONFIGURED ->
                "Open app to configure Server URL and Token"
            else -> "Idle polling • $totalCompleted completed"
        }

        val toggleActionIntent = Intent(appContext, NodeForegroundService::class.java).apply {
            action = if (isPaused) NodeForegroundService.ACTION_RESUME else NodeForegroundService.ACTION_PAUSE
        }
        val togglePending = PendingIntent.getForegroundService(
            appContext,
            101,
            toggleActionIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = Intent(appContext, NodeForegroundService::class.java).apply {
            action = NodeForegroundService.ACTION_STOP
        }
        val stopPending = PendingIntent.getForegroundService(
            appContext,
            102,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val updateIntent = Intent(appContext, NodeForegroundService::class.java).apply {
            action = NodeForegroundService.ACTION_CHECK_UPDATES
        }
        val updatePending = PendingIntent.getForegroundService(
            appContext,
            103,
            updateIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(appContext, CHANNEL_NODE_STATUS)
            .setSmallIcon(R.drawable.ic_node_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent)
            .addAction(0, if (isPaused) "Resume" else "Pause", togglePending)
            .addAction(0, "Stop", stopPending)
            .addAction(0, "Updates", updatePending)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun updateStatusNotification(
        snapshot: NodeRuntimeSnapshot,
        totalCompleted: Long,
        isPaused: Boolean,
    ) {
        val notification = buildStatusNotification(snapshot, totalCompleted, isPaused)
        runCatching { manager.notify(STATUS_NOTIFICATION_ID, notification) }
    }

    fun showAppUpdateReadyNotification(confirmIntent: Intent, versionCode: Int) {
        ensureChannels()
        val pending = PendingIntent.getActivity(
            appContext,
            201,
            confirmIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(appContext, CHANNEL_APP_UPDATES)
            .setSmallIcon(R.drawable.ic_node_notification)
            .setContentTitle("SERA Node update ready")
            .setContentText("Tap to install build $versionCode")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        runCatching { manager.notify(UPDATE_NOTIFICATION_ID, notification) }
    }

    fun cancelAppUpdateNotification() {
        runCatching { manager.cancel(UPDATE_NOTIFICATION_ID) }
    }

    fun showBootStartFallbackNotification() {
        ensureChannels()
        val openAppIntent = PendingIntent.getActivity(
            appContext,
            202,
            Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(appContext, CHANNEL_APP_UPDATES)
            .setSmallIcon(R.drawable.ic_node_notification)
            .setContentTitle("Tap to start SERA Node")
            .setContentText("Android background restrictions paused auto-start on boot.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent)
            .build()
        runCatching { manager.notify(BOOT_FALLBACK_NOTIFICATION_ID, notification) }
    }

    companion object {
        const val CHANNEL_NODE_STATUS = "sera_node_status"
        const val CHANNEL_APP_UPDATES = "sera_node_updates"
        const val STATUS_NOTIFICATION_ID = 1001
        const val UPDATE_NOTIFICATION_ID = 1002
        const val BOOT_FALLBACK_NOTIFICATION_ID = 1003
    }
}
