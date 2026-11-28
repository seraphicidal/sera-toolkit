package dev.sera.toolkit.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.sera.toolkit.R
import dev.sera.toolkit.data.DEFAULT_SERVER_URL
import dev.sera.toolkit.data.ThemePreference
import dev.sera.toolkit.data.UserSettings
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.ui.components.ErrorCard
import dev.sera.toolkit.ui.theme.LocalSeraPalette

@Composable
fun SettingsScreen(
    settings: UserSettings,
    connectionTestState: ConnectionTestState,
    onSaveServerUrl: (String) -> Unit,
    onResetServerUrl: () -> Unit,
    onTestConnection: (String) -> Unit,
    onThemeChange: (ThemePreference) -> Unit,
    onPreferredKindChange: (MediaKind?) -> Unit,
    onQuickDownloadChange: (Boolean) -> Unit,
    onWifiOnlyChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    var urlDraft by remember(settings.serverUrl) { mutableStateOf(settings.serverUrl) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        SettingsCard(title = stringResource(R.string.settings_server_section)) {
            OutlinedTextField(
                value = urlDraft,
                onValueChange = { urlDraft = it },
                singleLine = true,
                label = { Text(text = stringResource(R.string.settings_server_url_label)) },
                supportingText = {
                    Text(text = stringResource(R.string.settings_server_url_supporting, DEFAULT_SERVER_URL))
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = { onSaveServerUrl(urlDraft) },
                    enabled = urlDraft.isNotBlank(),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = palette.accent,
                        contentColor = palette.accentInk,
                    ),
                ) {
                    Text(text = stringResource(R.string.action_save))
                }
                OutlinedButton(
                    onClick = { onTestConnection(urlDraft) },
                    enabled = connectionTestState !is ConnectionTestState.Testing && urlDraft.isNotBlank(),
                    shape = RoundedCornerShape(10.dp),
                ) {
                    if (connectionTestState is ConnectionTestState.Testing) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(text = stringResource(R.string.settings_testing_connection))
                    } else {
                        Text(text = stringResource(R.string.settings_test_connection))
                    }
                }
                Spacer(modifier = Modifier.weight(1f))
                if (settings.serverUrl != DEFAULT_SERVER_URL) {
                    TextButton(onClick = onResetServerUrl) {
                        Text(text = stringResource(R.string.action_reset))
                    }
                }
            }

            when (connectionTestState) {
                is ConnectionTestState.Success -> {
                    val info = connectionTestState.serviceInfo
                    val limits = info.limits
                    val nodes = info.nodeAvailability
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        color = palette.sunken,
                        border = BorderStroke(1.dp, palette.success.copy(alpha = 0.4f)),
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.CheckCircle,
                                    contentDescription = null,
                                    tint = palette.success,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = stringResource(
                                        R.string.settings_connection_ok,
                                        info.name,
                                        info.version,
                                        info.providers.size,
                                    ),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = palette.ink,
                                )
                            }
                            Text(
                                text = stringResource(
                                    R.string.status_limit_file_size,
                                    Formatters.formatBytes(limits.maxFilesizeBytes),
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.inkMuted,
                            )
                            Text(
                                text = stringResource(
                                    R.string.status_limit_duration,
                                    Formatters.formatLimitDuration(limits.maxDurationSeconds),
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.inkMuted,
                            )
                            Text(
                                text = stringResource(
                                    R.string.status_limit_items,
                                    limits.maxItemsPerJob,
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.inkMuted,
                            )
                            Text(
                                text = stringResource(
                                    R.string.status_limit_retention,
                                    Formatters.formatLimitDuration(limits.retentionSeconds),
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.inkMuted,
                            )
                            if (nodes != null && nodes.enabled) {
                                Text(
                                    text = if (nodes.healthyNodes > 0) {
                                        stringResource(
                                            R.string.settings_connection_nodes_ok,
                                            nodes.healthyNodes,
                                            nodes.totalNodes,
                                        )
                                    } else {
                                        stringResource(
                                            R.string.settings_connection_nodes_offline,
                                            nodes.totalNodes,
                                        )
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (nodes.healthyNodes > 0) palette.success else palette.warning,
                                )
                            }
                        }
                    }
                }
                is ConnectionTestState.Failure -> {
                    ErrorCard(
                        error = connectionTestState.error,
                        onRetry = if (connectionTestState.error.retryable) {
                            { onTestConnection(urlDraft) }
                        } else {
                            null
                        },
                    )
                }
                else -> Unit
            }
        }

        SettingsCard(title = stringResource(R.string.settings_appearance_section)) {
            Text(
                text = stringResource(R.string.settings_theme_label),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(palette.sunken)
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ThemePreference.entries.forEach { pref ->
                    val selected = settings.themePreference == pref
                    val label = when (pref) {
                        ThemePreference.LIGHT -> stringResource(R.string.settings_theme_light)
                        ThemePreference.SYSTEM -> stringResource(R.string.settings_theme_system)
                        ThemePreference.DARK -> stringResource(R.string.settings_theme_dark)
                    }
                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onThemeChange(pref) },
                        shape = RoundedCornerShape(8.dp),
                        color = if (selected) palette.surface else palette.sunken,
                        shadowElevation = if (selected) 1.dp else 0.dp,
                    ) {
                        Box(
                            modifier = Modifier.padding(vertical = 9.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = label,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (selected) palette.ink else palette.inkMuted,
                            )
                        }
                    }
                }
            }
        }

        SettingsCard(title = stringResource(R.string.settings_downloads_section)) {
            Text(
                text = stringResource(R.string.settings_preferred_kind_label),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
            val kindChoices = listOf<MediaKind?>(
                null,
                MediaKind.VIDEO,
                MediaKind.AUDIO,
                MediaKind.IMAGE,
                MediaKind.GIF,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                kindChoices.forEach { kind ->
                    val selected = settings.preferredKind == kind
                    val label = if (kind == null) {
                        stringResource(R.string.settings_preferred_kind_auto)
                    } else {
                        Formatters.kindLabel(kind)
                    }
                    FilterChip(
                        selected = selected,
                        onClick = { onPreferredKindChange(kind) },
                        label = { Text(text = label) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = palette.accentWash,
                            selectedLabelColor = palette.accent,
                        ),
                    )
                }
            }

            HorizontalDivider(color = palette.line)

            SettingsToggleRow(
                title = stringResource(R.string.settings_quick_download_title),
                description = stringResource(R.string.settings_quick_download_desc),
                checked = settings.quickDownload,
                onCheckedChange = onQuickDownloadChange,
            )

            HorizontalDivider(color = palette.line)

            SettingsToggleRow(
                title = stringResource(R.string.settings_wifi_only_title),
                description = stringResource(R.string.settings_wifi_only_desc),
                checked = settings.wifiOnly,
                onCheckedChange = onWifiOnlyChange,
            )
        }

        Spacer(modifier = Modifier.height(12.dp))
    }
}

@Composable
private fun SettingsCard(
    title: String,
    content: @Composable () -> Unit,
) {
    val palette = LocalSeraPalette.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = palette.inkFaint,
        )
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = palette.surface,
            border = BorderStroke(1.dp, palette.line),
        ) {
            Column(
                modifier = Modifier.padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                content()
            }
        }
    }
}

@Composable
private fun SettingsToggleRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val palette = LocalSeraPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                color = palette.ink,
            )
            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}
