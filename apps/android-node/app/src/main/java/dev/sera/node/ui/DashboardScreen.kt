package dev.sera.node.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudDownload
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SecurityUpdate
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.sera.node.BuildConfig
import dev.sera.node.data.NodeSettings
import dev.sera.node.model.NetworkTransport
import dev.sera.node.service.NodeRuntimeSnapshot
import dev.sera.node.service.NodeServiceState
import dev.sera.node.ui.theme.LocalSeraPalette
import dev.sera.node.updater.UpdateState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DashboardScreen(
    settings: NodeSettings,
    snapshot: NodeRuntimeSnapshot,
    updateState: UpdateState,
    permissions: SystemPermissionState,
    onStartNode: () -> Unit,
    onStopNode: () -> Unit,
    onPauseNode: () -> Unit,
    onResumeNode: () -> Unit,
    onOpenSettings: () -> Unit,
    onRequestBatteryOptimization: () -> Unit,
    onRequestInstallUnknownApps: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
    onCheckAllUpdates: () -> Unit,
    onForceRefreshTools: () -> Unit,
    onInstallPendingUpdate: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!permissions.ignoringBatteryOptimizations) {
            PermissionBannerCard(
                icon = Icons.Rounded.BatteryChargingFull,
                title = "Battery optimization active",
                message = "Disable optimization so the node runs 24/7 in the background over cellular & Wi-Fi.",
                actionLabel = "Unrestrict",
                containerColor = palette.warningWash,
                accentColor = palette.warning,
                onAction = onRequestBatteryOptimization,
            )
        }

        if (!permissions.canInstallUnknownApps) {
            PermissionBannerCard(
                icon = Icons.Rounded.SecurityUpdate,
                title = "Allow app self-updates",
                message = "Grant Install Unknown Apps so SERA Node can stage 1-tap APK updates automatically.",
                actionLabel = "Allow",
                containerColor = palette.accentWash,
                accentColor = palette.accent,
                onAction = onRequestInstallUnknownApps,
            )
        }

        if (!permissions.hasNotificationPermission) {
            PermissionBannerCard(
                icon = Icons.Rounded.NotificationsActive,
                title = "Notification permission missing",
                message = "Allow notifications to display live extraction progress and update prompts.",
                actionLabel = "Grant",
                containerColor = palette.accentWash,
                accentColor = palette.accent,
                onAction = onRequestNotificationPermission,
            )
        }

        if (updateState.pendingConfirmIntent != null) {
            PermissionBannerCard(
                icon = Icons.Rounded.SystemUpdate,
                title = "App update staged",
                message = "Tap to confirm installation of the verified SERA Node APK.",
                actionLabel = "Install Now",
                containerColor = palette.successWash,
                accentColor = palette.success,
                onAction = onInstallPendingUpdate,
            )
        }

        NodeControlCard(
            settings = settings,
            snapshot = snapshot,
            onStartNode = onStartNode,
            onStopNode = onStopNode,
            onPauseNode = onPauseNode,
            onResumeNode = onResumeNode,
            onOpenSettings = onOpenSettings,
        )

        ActiveTasksCard(
            settings = settings,
            snapshot = snapshot,
        )

        VersionsAndUpdatesCard(
            settings = settings,
            updateState = updateState,
            onCheckAllUpdates = onCheckAllUpdates,
            onForceRefreshTools = onForceRefreshTools,
        )
    }
}

@Composable
private fun PermissionBannerCard(
    icon: ImageVector,
    title: String,
    message: String,
    actionLabel: String,
    containerColor: Color,
    accentColor: Color,
    onAction: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        border = BorderStroke(1.dp, accentColor.copy(alpha = 0.3f)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = accentColor,
                modifier = Modifier.size(24.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    color = palette.ink,
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
            }
            FilledTonalButton(onClick = onAction) {
                Text(text = actionLabel)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NodeControlCard(
    settings: NodeSettings,
    snapshot: NodeRuntimeSnapshot,
    onStartNode: () -> Unit,
    onStopNode: () -> Unit,
    onPauseNode: () -> Unit,
    onResumeNode: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val palette = LocalSeraPalette.current

    val (pillColor, pillBg, pillText) = when (snapshot.serviceState) {
        NodeServiceState.IDLE_POLLING -> {
            val via = when (snapshot.transport) {
                NetworkTransport.CELLULAR -> "Online • Cellular"
                NetworkTransport.WIFI -> "Online • Wi-Fi"
                NetworkTransport.OTHER -> "Online"
                NetworkTransport.NONE -> "Online"
            }
            Triple(palette.success, palette.successWash, via)
        }
        NodeServiceState.RUNNING_TASK -> {
            val via = if (snapshot.transport == NetworkTransport.CELLULAR) "Cellular" else "Wi-Fi"
            Triple(palette.accent, palette.accentWash, "Working • $via")
        }
        NodeServiceState.UPDATING -> Triple(palette.accent, palette.accentWash, "Updating")
        NodeServiceState.PAUSED -> Triple(palette.warning, palette.warningWash, "Paused")
        NodeServiceState.WAITING_CHARGING,
        NodeServiceState.WAITING_NETWORK,
        NodeServiceState.RECONNECTING,
        NodeServiceState.STARTING,
        -> Triple(palette.warning, palette.warningWash, snapshot.serviceState.label)
        NodeServiceState.AUTH_ERROR,
        NodeServiceState.UNCONFIGURED,
        -> Triple(palette.danger, palette.dangerWash, snapshot.serviceState.label)
        NodeServiceState.STOPPED -> Triple(palette.inkMuted, palette.sunken, "Stopped")
    }

    val isRunning = snapshot.serviceState != NodeServiceState.STOPPED
    val isPaused = snapshot.serviceState == NodeServiceState.PAUSED

    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = settings.nodeId.ifBlank { "android-node" },
                        style = MaterialTheme.typography.titleLarge,
                        color = palette.ink,
                    )
                    Text(
                        text = if (settings.isConfigured) {
                            settings.apiBaseUrl
                        } else {
                            "Server URL & token not configured"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }

                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = pillBg,
                    border = BorderStroke(1.dp, pillColor.copy(alpha = 0.35f)),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(pillColor),
                        )
                        Text(
                            text = pillText,
                            style = MaterialTheme.typography.labelMedium,
                            color = pillColor,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (settings.enableYoutube) {
                    CapabilityChip(label = "YouTube", active = true)
                }
                if (settings.enableInstagram) {
                    val igLabel = if (settings.instagramSessionId.isNotBlank()) {
                        "Instagram + Session"
                    } else {
                        "Instagram"
                    }
                    CapabilityChip(label = igLabel, active = true)
                }
                if (settings.enableAllProviders) {
                    CapabilityChip(label = "All Websites (23 Providers)", active = true)
                }
                CapabilityChip(
                    label = "Capacity ${settings.preferredCapacity}",
                    active = false,
                )
                if (snapshot.isCharging) {
                    CapabilityChip(label = "Charging", active = true)
                }
            }

            if (snapshot.lastError != null) {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = palette.dangerWash,
                    border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.3f)),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.ErrorOutline,
                            contentDescription = null,
                            tint = palette.danger,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = snapshot.lastError,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.danger,
                        )
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (!settings.isConfigured) {
                    Button(
                        onClick = onOpenSettings,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text("Configure Node")
                    }
                } else if (!isRunning) {
                    Button(
                        onClick = onStartNode,
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(Icons.Rounded.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Start Node")
                    }
                } else {
                    if (isPaused) {
                        Button(
                            onClick = onResumeNode,
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Rounded.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Resume")
                        }
                    } else {
                        FilledTonalButton(
                            onClick = onPauseNode,
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Rounded.Pause, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Pause")
                        }
                    }
                    OutlinedButton(
                        onClick = onStopNode,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = palette.danger),
                        border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.5f)),
                    ) {
                        Icon(Icons.Rounded.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Stop")
                    }
                }
            }
        }
    }
}

@Composable
private fun CapabilityChip(label: String, active: Boolean) {
    val palette = LocalSeraPalette.current
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (active) palette.accentWash else palette.sunken,
        border = BorderStroke(1.dp, if (active) palette.accent.copy(alpha = 0.3f) else palette.line),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = if (active) palette.accent else palette.inkMuted,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun ActiveTasksCard(
    settings: NodeSettings,
    snapshot: NodeRuntimeSnapshot,
) {
    val palette = LocalSeraPalette.current
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Tasks & Throughput",
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MetricTile(
                    label = "Session",
                    value = snapshot.completedTasksSession.toString(),
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "Completed",
                    value = settings.completedTasksCount.toString(),
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "Failed",
                    value = settings.failedTasksCount.toString(),
                    modifier = Modifier.weight(1f),
                )
            }

            if (snapshot.activeTasks.isEmpty()) {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = palette.sunken,
                ) {
                    Text(
                        text = "No active extraction tasks",
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                    )
                }
            } else {
                snapshot.activeTasks.forEach { task ->
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = palette.sunken,
                        border = BorderStroke(1.dp, palette.line),
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = "${task.providerId.uppercase()} • ${task.kind}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.accent,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Text(
                                    text = "${task.percent.toInt().coerceIn(0, 100)}%",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.ink,
                                )
                            }
                            Text(
                                text = task.step,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.ink,
                            )
                            LinearProgressIndicator(
                                progress = { (task.percent.toFloat() / 100f).coerceIn(0f, 1f) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(6.dp)
                                    .clip(RoundedCornerShape(999.dp)),
                            )
                            if (task.bytesDownloaded != null) {
                                val bytesText = if (task.bytesTotal != null && task.bytesTotal > 0L) {
                                    "${formatBytes(task.bytesDownloaded)} / ${formatBytes(task.bytesTotal)}"
                                } else {
                                    formatBytes(task.bytesDownloaded)
                                }
                                Text(
                                    text = bytesText,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.inkMuted,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MetricTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        color = palette.sunken,
    ) {
        Column(
            modifier = Modifier.padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = palette.inkMuted,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun VersionsAndUpdatesCard(
    settings: NodeSettings,
    updateState: UpdateState,
    onCheckAllUpdates: () -> Unit,
    onForceRefreshTools: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val tools = updateState.toolsVersionInfo

    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Versions & Auto-Updater",
                    style = MaterialTheme.typography.titleMedium,
                    color = palette.ink,
                )
                if (updateState.isChecking) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else if (tools.ready) {
                    Icon(
                        imageVector = Icons.Rounded.CheckCircle,
                        contentDescription = null,
                        tint = palette.success,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            VersionRow("App", "v${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})")
            VersionRow("yt-dlp", tools.ytdlpVersion ?: "Initializing...")
            VersionRow("FFmpeg / ffprobe", tools.ffmpegVersion ?: if (tools.ready) "Bundled" else "Pending")
            VersionRow(
                "JS Runtime",
                buildString {
                    append(tools.jsRuntimeName ?: "QuickJS")
                    if (tools.ejsScriptsReady) append(" • EJS ready")
                },
            )
            VersionRow(
                "Hot-Config",
                (updateState.manifestHash ?: settings.cachedManifestHash)?.take(12) ?: "Default",
            )
            VersionRow(
                "Last Check",
                formatTimestamp(maxOf(updateState.lastCheckAt, settings.lastUpdateCheckAt)),
            )

            updateState.apkDownloadProgressPercent?.let { pct ->
                HorizontalDivider(color = palette.line)
                Text(
                    text = "Downloading APK update ($pct%)",
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.accent,
                )
                LinearProgressIndicator(
                    progress = { (pct / 100f).coerceIn(0f, 1f) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(999.dp)),
                )
            }

            updateState.lastResultMessage?.let { msg ->
                Text(
                    text = msg,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
            }

            updateState.lastError?.let { err ->
                Text(
                    text = err,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.danger,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onCheckAllUpdates,
                    enabled = !updateState.isChecking,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Rounded.CloudDownload, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Check & Install All Updates")
                }

                OutlinedButton(
                    onClick = onForceRefreshTools,
                    enabled = !updateState.isChecking,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Force Refresh yt-dlp & EJS")
                }
            }
        }
    }
}

@Composable
private fun VersionRow(label: String, value: String) {
    val palette = LocalSeraPalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = palette.inkMuted,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = palette.ink,
            fontWeight = FontWeight.Medium,
        )
    }
}

private fun formatTimestamp(epochMs: Long): String {
    if (epochMs <= 0L) return "Never"
    val formatter = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
    return formatter.format(Date(epochMs))
}

private fun formatBytes(bytes: Long): String {
    if (bytes < 1024L) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024.0) return String.format(Locale.US, "%.1f KB", kb)
    val mb = kb / 1024.0
    if (mb < 1024.0) return String.format(Locale.US, "%.1f MB", mb)
    val gb = mb / 1024.0
    return String.format(Locale.US, "%.2f GB", gb)
}
