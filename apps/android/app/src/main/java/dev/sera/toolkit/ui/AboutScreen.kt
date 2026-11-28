package dev.sera.toolkit.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.sera.toolkit.BuildConfig
import dev.sera.toolkit.R
import dev.sera.toolkit.data.GitHubUpdateChecker
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.data.UpdateCheckResult
import dev.sera.toolkit.ui.theme.LocalSeraPalette

@Composable
fun AboutScreen(
    serverUrl: String,
    updateCheckState: UpdateCheckState,
    onCheckForUpdates: () -> Unit,
    onOpenExternalUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val baseServer = SeraApiClient.normalizeBaseUrl(serverUrl)

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = palette.surface,
            border = BorderStroke(1.dp, palette.line),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.app_name),
                    style = MaterialTheme.typography.titleLarge,
                    color = palette.ink,
                )
                Text(
                    text = stringResource(
                        R.string.about_version_label,
                        BuildConfig.VERSION_NAME,
                        BuildConfig.VERSION_CODE,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                Text(
                    text = stringResource(R.string.about_rights_notice),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.ink,
                )
                Spacer(modifier = Modifier.height(4.dp))
                OutlinedButton(
                    onClick = { onOpenExternalUrl(GitHubUpdateChecker.SOURCE_REPO_URL) },
                    shape = RoundedCornerShape(10.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Code,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(text = stringResource(R.string.about_source_code))
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.about_updates_section).uppercase(),
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
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Button(
                        onClick = onCheckForUpdates,
                        enabled = updateCheckState !is UpdateCheckState.Checking,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.accentInk,
                        ),
                    ) {
                        if (updateCheckState is UpdateCheckState.Checking) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = palette.accentInk,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = stringResource(R.string.about_checking_updates))
                        } else {
                            Icon(
                                imageVector = Icons.Rounded.SystemUpdate,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = stringResource(R.string.about_check_updates))
                        }
                    }

                    if (updateCheckState is UpdateCheckState.Completed) {
                        when (val result = updateCheckState.result) {
                            is UpdateCheckResult.UpToDate -> {
                                Text(
                                    text = stringResource(R.string.about_up_to_date, result.currentVersionName),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.success,
                                )
                            }
                            is UpdateCheckResult.UpdateAvailable -> {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(
                                        text = stringResource(R.string.about_update_available, result.tagName),
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium,
                                        color = palette.accent,
                                    )
                                    OutlinedButton(
                                        onClick = { onOpenExternalUrl(result.htmlUrl) },
                                        shape = RoundedCornerShape(10.dp),
                                    ) {
                                        Icon(
                                            imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                                            contentDescription = null,
                                            modifier = Modifier.size(16.dp),
                                        )
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text(text = stringResource(R.string.about_open_release))
                                    }
                                }
                            }
                            is UpdateCheckResult.Error -> {
                                Text(
                                    text = result.message,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.danger,
                                )
                            }
                        }
                    }
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.about_legal_section).uppercase(),
                style = MaterialTheme.typography.labelMedium,
                color = palette.inkFaint,
            )
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = palette.surface,
                border = BorderStroke(1.dp, palette.line),
            ) {
                Column {
                    LegalLinkRow(
                        label = stringResource(R.string.about_legal_terms),
                        onClick = { onOpenExternalUrl("$baseServer/legal/terms") },
                    )
                    HorizontalDivider(color = palette.line)
                    LegalLinkRow(
                        label = stringResource(R.string.about_legal_privacy),
                        onClick = { onOpenExternalUrl("$baseServer/legal/privacy") },
                    )
                    HorizontalDivider(color = palette.line)
                    LegalLinkRow(
                        label = stringResource(R.string.about_legal_notice),
                        onClick = { onOpenExternalUrl("$baseServer/legal/notice") },
                    )
                    HorizontalDivider(color = palette.line)
                    LegalLinkRow(
                        label = stringResource(R.string.about_legal_report),
                        onClick = { onOpenExternalUrl("$baseServer/legal/report") },
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))
    }
}

@Composable
private fun LegalLinkRow(
    label: String,
    onClick: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = palette.ink,
        )
        Icon(
            imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
            contentDescription = null,
            tint = palette.inkFaint,
            modifier = Modifier.size(18.dp),
        )
    }
}
