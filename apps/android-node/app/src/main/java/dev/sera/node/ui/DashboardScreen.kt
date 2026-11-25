package dev.sera.node.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SecurityUpdate
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material.icons.rounded.Tune
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sera.node.BuildConfig
import dev.sera.node.data.NodeSettings
import dev.sera.node.extractor.ALL_OTHER_PROVIDER_IDS
import dev.sera.node.model.NetworkState
import dev.sera.node.model.NetworkTransport
import dev.sera.node.model.NodeRole
import dev.sera.node.service.NodeRuntimeSnapshot
import dev.sera.node.service.NodeServiceState
import dev.sera.node.ui.theme.LocalSeraPalette
import dev.sera.node.updater.UpdateState
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class ChecklistItem(
    val icon: ImageVector,
    val title: String,
    val subtitle: String,
    val actionLabel: String,
    val accentColor: Color,
    val onClick: () -> Unit,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DashboardScreen(
    settings: NodeSettings,
    snapshot: NodeRuntimeSnapshot,
    networkState: NetworkState,
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
    val effectiveTransport = remember(networkState, snapshot.transport) {
        if (networkState.isConnected) networkState.transport else snapshot.transport
    }

    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(snapshot.isServiceRunning, snapshot.startedAtMs, snapshot.lastPollSuccessAtMs) {
        while (snapshot.isServiceRunning || snapshot.lastPollSuccessAtMs != null) {
            nowMs = System.currentTimeMillis()
            val startedAt = snapshot.startedAtMs
            val interval = if (startedAt != null && nowMs - startedAt < 60_000L) 1_000L else 15_000L
            delay(interval)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (updateState.pendingConfirmIntent != null) {
            StagedUpdateBannerCard(
                versionName = updateState.availableAppUpdate?.versionName,
                onInstall = onInstallPendingUpdate,
            )
        }

        NodeControlCard(
            settings = settings,
            snapshot = snapshot,
            effectiveTransport = effectiveTransport,
            nowMs = nowMs,
            onStartNode = onStartNode,
            onStopNode = onStopNode,
            onPauseNode = onPauseNode,
            onResumeNode = onResumeNode,
            onOpenSettings = onOpenSettings,
        )

        SetupChecklistCard(
            settings = settings,
            permissions = permissions,
            onOpenSettings = onOpenSettings,
            onRequestBatteryOptimization = onRequestBatteryOptimization,
            onRequestNotificationPermission = onRequestNotificationPermission,
            onRequestInstallUnknownApps = onRequestInstallUnknownApps,
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
private fun StagedUpdateBannerCard(
    versionName: String?,
    onInstall: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = palette.successWash),
        border = BorderStroke(1.dp, palette.success.copy(alpha = 0.35f)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.SystemUpdate,
                    contentDescription = null,
                    tint = palette.success,
                    modifier = Modifier.size(22.dp),
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = if (!versionName.isNullOrBlank()) {
                            "SERA Node v$versionName ready"
                        } else {
                            "App update staged"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        color = palette.ink,
                    )
                    Text(
                        text = "Tap below to confirm installation of the verified APK.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }
            Button(
                onClick = onInstall,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                Text(text = "Install Now")
            }
        }
    }
}

@Composable
private fun SetupChecklistCard(
    settings: NodeSettings,
    permissions: SystemPermissionState,
    onOpenSettings: () -> Unit,
    onRequestBatteryOptimization: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
    onRequestInstallUnknownApps: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val pendingItems = buildList {
        if (!settings.isConfigured) {
            add(
                ChecklistItem(
                    icon = Icons.Rounded.Tune,
                    title = "Configure Server & Token",
                    subtitle = "Add your SERA API URL and node token in Settings.",
                    actionLabel = "Configure",
                    accentColor = palette.danger,
                    onClick = onOpenSettings,
                ),
            )
        }
        if (!permissions.ignoringBatteryOptimizations) {
            add(
                ChecklistItem(
                    icon = Icons.Rounded.BatteryChargingFull,
                    title = "Unrestrict Battery",
                    subtitle = "Prevent Doze kills so the node runs 24/7 in background.",
                    actionLabel = "Unrestrict",
                    accentColor = palette.warning,
                    onClick = onRequestBatteryOptimization,
                ),
            )
        }
        if (!permissions.hasNotificationPermission) {
            add(
                ChecklistItem(
                    icon = Icons.Rounded.NotificationsActive,
                    title = "Allow Notifications",
                    subtitle = "Show live extraction progress and update prompts.",
                    actionLabel = "Grant",
                    accentColor = palette.accent,
                    onClick = onRequestNotificationPermission,
                ),
            )
        }
        if (!permissions.canInstallUnknownApps) {
            add(
                ChecklistItem(
                    icon = Icons.Rounded.SecurityUpdate,
                    title = "Allow Self-Updates",
                    subtitle = "Permit 1-tap verified APK upgrades.",
                    actionLabel = "Allow",
                    accentColor = palette.accent,
                    onClick = onRequestInstallUnknownApps,
                ),
            )
        }
    }

    if (pendingItems.isEmpty()) return

    val totalItems = 4
    val completedCount = totalItems - pendingItems.size
    var expanded by rememberSaveable { mutableStateOf(true) }

    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .clickable(
                        role = Role.Button,
                        onClickLabel = if (expanded) "Collapse setup checklist" else "Expand setup checklist",
                    ) { expanded = !expanded }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Setup Checklist",
                        style = MaterialTheme.typography.titleMedium,
                        color = palette.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Surface(
                        shape = RoundedCornerShape(999.dp),
                        color = palette.warningWash,
                        border = BorderStroke(1.dp, palette.warning.copy(alpha = 0.35f)),
                    ) {
                        Text(
                            text = "$completedCount/$totalItems ready",
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.warning,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
                Icon(
                    imageVector = if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                    contentDescription = if (expanded) "Collapse checklist" else "Expand checklist",
                    tint = palette.inkMuted,
                )
            }

            if (expanded) {
                HorizontalDivider(color = palette.line)
                pendingItems.forEachIndexed { index, item ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .clickable(role = Role.Button, onClick = item.onClick)
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = item.icon,
                            contentDescription = null,
                            tint = item.accentColor,
                            modifier = Modifier.size(20.dp),
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = item.title,
                                style = MaterialTheme.typography.bodyLarge,
                                color = palette.ink,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = item.subtitle,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.inkMuted,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            text = item.actionLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.accent,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    if (index < pendingItems.lastIndex) {
                        HorizontalDivider(
                            color = palette.line,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NodeControlCard(
    settings: NodeSettings,
    snapshot: NodeRuntimeSnapshot,
    effectiveTransport: NetworkTransport,
    nowMs: Long,
    onStartNode: () -> Unit,
    onStopNode: () -> Unit,
    onPauseNode: () -> Unit,
    onResumeNode: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val transportLabel = effectiveTransport.displayLabel

    val (pillColor, pillBg, pillText) = when (snapshot.serviceState) {
        NodeServiceState.IDLE_POLLING -> {
            val label = if (effectiveTransport == NetworkTransport.NONE) {
                "Online"
            } else {
                "Online • $transportLabel"
            }
            Triple(palette.success, palette.successWash, label)
        }

        NodeServiceState.RUNNING_TASK -> {
            val label = if (effectiveTransport == NetworkTransport.NONE) {
                "Working"
            } else {
                "Working • $transportLabel"
            }
            Triple(palette.accent, palette.accentWash, label)
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

    val isRunning = snapshot.isServiceRunning
    val isPaused = snapshot.serviceState == NodeServiceState.PAUSED
    val activeProviderCount = remember(
        settings.enableYoutube,
        settings.enableInstagram,
        settings.enableAllProviders,
    ) {
        settings.activeProviders().size
    }

    val uptimeValue = remember(snapshot.isServiceRunning, snapshot.startedAtMs, nowMs) {
        val started = snapshot.startedAtMs
        if (snapshot.isServiceRunning && started != null && nowMs >= started) {
            formatDuration(nowMs - started)
        } else {
            "Offline"
        }
    }

    val lastPollValue = remember(snapshot.lastPollSuccessAtMs, nowMs) {
        val lastPoll = snapshot.lastPollSuccessAtMs
        if (lastPoll == null || lastPoll <= 0L) {
            "Never"
        } else {
            formatRelativeAge(nowMs - lastPoll)
        }
    }

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
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = settings.nodeId.ifBlank { "android-node" },
                        style = MaterialTheme.typography.titleLarge,
                        color = palette.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = if (settings.isConfigured) {
                            settings.apiBaseUrl
                        } else {
                            "Server URL & token not configured"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = pillBg,
                    border = BorderStroke(1.dp, pillColor.copy(alpha = 0.35f)),
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        liveRegion = LiveRegionMode.Polite
                        contentDescription = "Node status: $pillText"
                    },
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
                            maxLines = 1,
                        )
                    }
                }
            }

            val isBackupRole = settings.nodeRole == NodeRole.BACKUP
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = if (isBackupRole) palette.sunken else palette.accentWash,
                border = BorderStroke(
                    1.dp,
                    if (isBackupRole) palette.line else palette.accent.copy(alpha = 0.3f),
                ),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Surface(
                            shape = RoundedCornerShape(999.dp),
                            color = if (isBackupRole) palette.warningWash else palette.accent,
                            border = if (isBackupRole) {
                                BorderStroke(1.dp, palette.warning.copy(alpha = 0.35f))
                            } else {
                                null
                            },
                        ) {
                            Text(
                                text = if (isBackupRole) "Backup Node" else "Primary Node",
                                style = MaterialTheme.typography.labelSmall,
                                color = if (isBackupRole) palette.warning else palette.accentInk,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                            )
                        }
                        Text(
                            text = if (isBackupRole) "Failover Standby" else "Immediate Priority",
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.ink,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = if (isBackupRole) {
                            "Handles tasks automatically when your PC primary node is offline or unavailable."
                        } else {
                            "Claims tasks immediately alongside any other primary nodes."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                MetricTile(
                    label = "Uptime",
                    value = uptimeValue,
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "Network",
                    value = transportLabel,
                    modifier = Modifier.weight(1f),
                )
                MetricTile(
                    label = "Last Poll",
                    value = lastPollValue,
                    modifier = Modifier.weight(1f),
                )
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                CapabilityChip(
                    label = if (activeProviderCount == 1) "1 Provider" else "$activeProviderCount Providers",
                    active = activeProviderCount > 0,
                )
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
                    CapabilityChip(label = "+${ALL_OTHER_PROVIDER_IDS.size} Other Sites", active = true)
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
                    border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.35f)),
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        liveRegion = LiveRegionMode.Polite
                    },
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
                            contentDescription = "Error",
                            tint = palette.danger,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = snapshot.lastError,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.danger,
                            modifier = Modifier.weight(1f),
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
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp),
                    ) {
                        Icon(Icons.Rounded.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Configure Node")
                    }
                } else if (!isRunning) {
                    Button(
                        onClick = onStartNode,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp),
                    ) {
                        Icon(Icons.Rounded.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Start Node")
                    }
                    if (snapshot.serviceState == NodeServiceState.AUTH_ERROR) {
                        OutlinedButton(
                            onClick = onOpenSettings,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Rounded.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Token")
                        }
                    }
                } else {
                    if (isPaused) {
                        Button(
                            onClick = onResumeNode,
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Rounded.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Resume")
                        }
                    } else {
                        FilledTonalButton(
                            onClick = onPauseNode,
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Rounded.Pause, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Pause")
                        }
                    }
                    OutlinedButton(
                        onClick = onStopNode,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp),
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
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Tasks & Throughput",
                    style = MaterialTheme.typography.titleMedium,
                    color = palette.ink,
                )
                val totalFinished = settings.completedTasksCount + settings.failedTasksCount
                if (totalFinished > 0L) {
                    val rate = ((settings.completedTasksCount * 100L) / totalFinished).toInt()
                    Text(
                        text = "$rate% success",
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.inkMuted,
                    )
                }
            }

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
                val emptyTasksLabel = if (
                    settings.nodeRole == NodeRole.BACKUP &&
                    snapshot.serviceState == NodeServiceState.IDLE_POLLING
                ) {
                    "Standing by as backup node — ready if PC node is offline"
                } else {
                    "No active extraction tasks"
                }
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = palette.sunken,
                ) {
                    Text(
                        text = emptyTasksLabel,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                    )
                }
            } else {
                snapshot.activeTasks.forEach { task ->
                    val pct = task.percent.toInt().coerceIn(0, 100)
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
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = "${task.providerId.uppercase()} • ${task.kind}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.accent,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    text = "$pct%",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.ink,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Text(
                                text = task.step,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.ink,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            LinearProgressIndicator(
                                progress = { (task.percent.toFloat() / 100f).coerceIn(0f, 1f) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(6.dp)
                                    .clip(RoundedCornerShape(999.dp))
                                    .semantics {
                                        contentDescription = "${task.providerId} ${task.kind} progress $pct percent"
                                    },
                            )
                            val telemetryLine = buildTaskTelemetryLine(
                                bytesDownloaded = task.bytesDownloaded,
                                bytesTotal = task.bytesTotal,
                                speedBytesPerSecond = task.speedBytesPerSecond,
                                etaSeconds = task.etaSeconds,
                            )
                            if (telemetryLine != null) {
                                Text(
                                    text = telemetryLine,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.inkMuted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
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
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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
    val locale = Locale.getDefault()
    val timestampFormatter = remember(locale) { SimpleDateFormat("MMM d, HH:mm", locale) }
    val lastCheckMs = maxOf(updateState.lastCheckAt, settings.lastUpdateCheckAt)
    val lastCheckLabel = remember(lastCheckMs, timestampFormatter) {
        if (lastCheckMs <= 0L) "Never" else timestampFormatter.format(Date(lastCheckMs))
    }

    val jsRuntimeText = when {
        !tools.jsRuntimeName.isNullOrBlank() -> buildString {
            append(tools.jsRuntimeName)
            if (tools.ejsScriptsReady) append(" • EJS ready")
        }

        !tools.ready && tools.error.isNullOrBlank() -> "Initializing..."
        else -> "Unavailable"
    }
    val jsRuntimeColor = if (tools.jsRuntimeName.isNullOrBlank() && (tools.ready || !tools.error.isNullOrBlank())) {
        palette.warning
    } else {
        palette.ink
    }

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
                when {
                    updateState.isChecking -> {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .size(18.dp)
                                .semantics { contentDescription = "Checking for updates" },
                            strokeWidth = 2.dp,
                        )
                    }

                    !tools.error.isNullOrBlank() -> {
                        Icon(
                            imageVector = Icons.Rounded.ErrorOutline,
                            contentDescription = "Tool initialization error",
                            tint = palette.danger,
                            modifier = Modifier.size(18.dp),
                        )
                    }

                    tools.ready -> {
                        Icon(
                            imageVector = Icons.Rounded.CheckCircle,
                            contentDescription = "Extraction tools ready",
                            tint = palette.success,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }

            VersionRow("App", "v${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})")
            VersionRow(
                "yt-dlp",
                tools.ytdlpVersion ?: if (!tools.error.isNullOrBlank()) "Unavailable" else "Initializing...",
            )
            VersionRow(
                "FFmpeg / ffprobe",
                tools.ffmpegVersion ?: if (tools.ready) "Bundled" else if (!tools.error.isNullOrBlank()) "Unavailable" else "Pending",
            )
            VersionRow("JS Runtime", jsRuntimeText, valueColor = jsRuntimeColor)
            VersionRow(
                "Hot-Config",
                (updateState.manifestHash ?: settings.cachedManifestHash)?.take(12) ?: "Default",
            )
            VersionRow("Last Check", lastCheckLabel)

            if (!tools.error.isNullOrBlank()) {
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = palette.dangerWash,
                    border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.35f)),
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
                            contentDescription = "Runtime error",
                            tint = palette.danger,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = tools.error,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.danger,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            updateState.availableAppUpdate?.let { available ->
                var notesExpanded by rememberSaveable(available.versionCode) { mutableStateOf(false) }
                val notes = available.releaseNotes?.trim()?.takeIf { it.isNotEmpty() }
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = palette.accentWash,
                    border = BorderStroke(1.dp, palette.accent.copy(alpha = 0.3f)),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = "App update available: v${available.versionName} (build ${available.versionCode})",
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.accent,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (notes != null) {
                            Text(
                                text = notes,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.ink,
                                maxLines = if (notesExpanded) Int.MAX_VALUE else 3,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (notes.length > 140 || notes.count { it == '\n' } >= 3) {
                                TextButton(
                                    onClick = { notesExpanded = !notesExpanded },
                                    modifier = Modifier.align(Alignment.End),
                                ) {
                                    Text(if (notesExpanded) "Show less" else "Read release notes")
                                }
                            }
                        }
                    }
                }
            }

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
                        .clip(RoundedCornerShape(999.dp))
                        .semantics {
                            contentDescription = "APK update download $pct percent"
                        },
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
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    Icon(Icons.Rounded.CloudDownload, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Check & Install All Updates")
                }

                OutlinedButton(
                    onClick = onForceRefreshTools,
                    enabled = !updateState.isChecking,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
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
private fun VersionRow(
    label: String,
    value: String,
    valueColor: Color = LocalSeraPalette.current.ink,
) {
    val palette = LocalSeraPalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = palette.inkMuted,
            maxLines = 1,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = valueColor,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.End,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun buildTaskTelemetryLine(
    bytesDownloaded: Long?,
    bytesTotal: Long?,
    speedBytesPerSecond: Double?,
    etaSeconds: Double?,
): String? {
    val parts = buildList {
        if (bytesDownloaded != null && bytesDownloaded >= 0L) {
            val bytesText = if (bytesTotal != null && bytesTotal > 0L) {
                "${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)}"
            } else {
                formatBytes(bytesDownloaded)
            }
            add(bytesText)
        }
        if (speedBytesPerSecond != null && speedBytesPerSecond.isFinite() && speedBytesPerSecond > 0.0) {
            add("${formatBytes(speedBytesPerSecond.toLong())}/s")
        }
        if (etaSeconds != null && etaSeconds.isFinite() && etaSeconds >= 0.0) {
            add("ETA ${formatEta(etaSeconds)}")
        }
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" • ")
}

private fun formatDuration(durationMs: Long): String {
    val totalSeconds = (durationMs / 1000L).coerceAtLeast(0L)
    val days = totalSeconds / 86_400L
    val hours = (totalSeconds % 86_400L) / 3_600L
    val minutes = (totalSeconds % 3_600L) / 60L
    val seconds = totalSeconds % 60L
    return when {
        days > 0L -> "${days}d ${hours}h"
        hours > 0L -> "${hours}h ${minutes}m"
        minutes > 0L -> "${minutes}m ${seconds}s"
        else -> "${seconds}s"
    }
}

private fun formatRelativeAge(ageMs: Long): String {
    val seconds = (ageMs / 1000L).coerceAtLeast(0L)
    return when {
        seconds < 5L -> "Just now"
        seconds < 60L -> "${seconds}s ago"
        seconds < 3_600L -> "${seconds / 60L}m ago"
        seconds < 86_400L -> "${seconds / 3_600L}h ago"
        else -> "${seconds / 86_400L}d ago"
    }
}

private fun formatEta(secondsDouble: Double): String {
    val totalSeconds = secondsDouble.toLong().coerceAtLeast(0L)
    val hours = totalSeconds / 3_600L
    val minutes = (totalSeconds % 3_600L) / 60L
    val seconds = totalSeconds % 60L
    return when {
        hours > 0L -> "${hours}h ${minutes}m"
        minutes > 0L -> "${minutes}m ${seconds}s"
        else -> "${seconds}s"
    }
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
