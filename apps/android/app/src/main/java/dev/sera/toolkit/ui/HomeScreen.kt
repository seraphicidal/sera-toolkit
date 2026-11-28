package dev.sera.toolkit.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.sera.toolkit.R
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.ServiceInfo
import dev.sera.toolkit.model.SubtitleFormat
import dev.sera.toolkit.ui.components.AdvancedOptionsSection
import dev.sera.toolkit.ui.components.CollectionItemPicker
import dev.sera.toolkit.ui.components.ErrorCard
import dev.sera.toolkit.ui.components.KindSelectorRow
import dev.sera.toolkit.ui.components.MediaPreviewHeader
import dev.sera.toolkit.ui.components.NodeOfflineBanner
import dev.sera.toolkit.ui.components.PrimaryDownloadButton
import dev.sera.toolkit.ui.components.QualityOptionList
import dev.sera.toolkit.ui.components.SubtitleOptionsSection
import dev.sera.toolkit.ui.theme.LocalSeraPalette

@Composable
fun HomeScreen(
    state: HomeUiState,
    serverUrl: String,
    serviceInfo: ServiceInfo?,
    maxItemsPerJob: Int,
    onUrlChange: (String) -> Unit,
    onPasteClick: () -> Unit,
    onAnalyzeClick: () -> Unit,
    onClearClick: () -> Unit,
    onDismissError: () -> Unit,
    onSelectKind: (MediaKind) -> Unit,
    onSelectLabel: (String) -> Unit,
    onToggleItem: (String) -> Unit,
    onSelectItems: (Set<String>) -> Unit,
    onPackagingChange: (PackagingMode) -> Unit,
    onFilenameChange: (String) -> Unit,
    onToggleAdvanced: () -> Unit,
    onTrimStartChange: (String) -> Unit,
    onTrimEndChange: (String) -> Unit,
    onSubtitleTrackChange: (String) -> Unit,
    onSubtitleFormatChange: (SubtitleFormat) -> Unit,
    onSubtitlesOnlyChange: (Boolean) -> Unit,
    onDownloadClick: () -> Unit,
    onQueueBatchClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val nodesOffline = serviceInfo?.nodeAvailability?.enabled == true &&
        serviceInfo.nodeAvailability.healthyNodes == 0

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (nodesOffline) {
            NodeOfflineBanner()
        }

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
                OutlinedTextField(
                    value = state.urlInput,
                    onValueChange = onUrlChange,
                    singleLine = true,
                    enabled = !state.analyzing,
                    label = { Text(text = stringResource(R.string.home_url_label)) },
                    placeholder = { Text(text = stringResource(R.string.home_url_placeholder)) },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Rounded.Link,
                            contentDescription = null,
                            tint = palette.inkFaint,
                        )
                    },
                    trailingIcon = if (state.urlInput.isNotEmpty()) {
                        {
                            IconButton(onClick = onClearClick) {
                                Icon(
                                    imageVector = Icons.Rounded.Close,
                                    contentDescription = stringResource(R.string.action_clear),
                                )
                            }
                        }
                    } else {
                        null
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Go,
                    ),
                    keyboardActions = KeyboardActions(
                        onGo = { if (!state.analyzing) onAnalyzeClick() },
                    ),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(
                        onClick = onPasteClick,
                        enabled = !state.analyzing,
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.ContentPaste,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(text = stringResource(R.string.action_paste))
                    }

                    Button(
                        onClick = onAnalyzeClick,
                        enabled = !state.analyzing && state.urlInput.isNotBlank(),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.accentInk,
                        ),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        if (state.analyzing) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = palette.accentInk,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = stringResource(R.string.home_analyzing))
                        } else {
                            Icon(
                                imageVector = Icons.Rounded.Search,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(text = stringResource(R.string.action_analyze))
                        }
                    }
                }
            }
        }

        if (state.batchUrls.size > 1) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                color = palette.accentWash,
                border = BorderStroke(1.dp, palette.accent.copy(alpha = 0.35f)),
            ) {
                Column(
                    modifier = Modifier.padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = stringResource(R.string.home_batch_detected, state.batchUrls.size),
                        style = MaterialTheme.typography.titleMedium,
                        color = palette.ink,
                    )
                    Text(
                        text = stringResource(R.string.home_batch_subtitle),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                    Button(
                        onClick = onQueueBatchClick,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.accentInk,
                        ),
                    ) {
                        Text(text = stringResource(R.string.action_queue_all, state.batchUrls.size))
                    }
                }
            }
        }

        val error = state.error
        if (error != null) {
            ErrorCard(
                error = error,
                onRetry = if (error.retryable) onAnalyzeClick else null,
                onDismiss = onDismissError,
            )
        }

        val info = state.mediaInfo
        if (info != null && !state.analyzing) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = palette.surface,
                border = BorderStroke(1.dp, palette.line),
            ) {
                Column(
                    modifier = Modifier.padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    MediaPreviewHeader(info = info, serverUrl = serverUrl)

                    CollectionItemPicker(
                        info = info,
                        serverUrl = serverUrl,
                        selectedIds = state.selectedIds,
                        maxItems = maxItemsPerJob,
                        onToggleItem = onToggleItem,
                        onSelectItems = onSelectItems,
                    )

                    KindSelectorRow(
                        info = info,
                        availableKinds = state.activeKinds,
                        selectedKind = state.effectiveKind,
                        enabled = state.selectedIds.isNotEmpty(),
                        onSelectKind = onSelectKind,
                    )

                    QualityOptionList(
                        info = info,
                        kind = state.effectiveKind,
                        selectedIds = state.selectedIds,
                        selectedLabel = state.effectiveLabel,
                        enabled = state.selectedIds.isNotEmpty(),
                        onSelectLabel = onSelectLabel,
                    )

                    val subtitleChoices = state.subtitleChoices
                    if (subtitleChoices != null) {
                        SubtitleOptionsSection(
                            choices = subtitleChoices,
                            selectedTrackValue = state.subtitleTrack,
                            selectedFormat = state.effectiveSubtitlesRequest?.format ?: state.subtitleFormat,
                            onlySubtitles = state.subtitlesOnly,
                            disabledByTrim = state.rawTrimSummary != dev.sera.toolkit.domain.TrimSummary.None,
                            onTrackChange = onSubtitleTrackChange,
                            onFormatChange = onSubtitleFormatChange,
                            onOnlyChange = onSubtitlesOnlyChange,
                        )
                    }

                    AdvancedOptionsSection(
                        expanded = state.showAdvanced,
                        onToggleExpanded = onToggleAdvanced,
                        filename = state.filename,
                        onFilenameChange = onFilenameChange,
                        multipleItems = (state.selection?.fileCount ?: 0) > 1,
                        packaging = state.packaging,
                        onPackagingChange = onPackagingChange,
                        canTrim = state.canTrim,
                        trimStart = state.trimStart,
                        trimEnd = state.trimEnd,
                        trimSummary = state.effectiveTrimSummary,
                        durationSeconds = state.singleItem?.duration,
                        trimDisabledBySubtitles = state.effectiveSubtitlesRequest != null,
                        onTrimStartChange = onTrimStartChange,
                        onTrimEndChange = onTrimEndChange,
                    )

                    PrimaryDownloadButton(
                        selection = state.selection,
                        trimSummary = state.effectiveTrimSummary,
                        subtitlesRequest = state.effectiveSubtitlesRequest,
                        onClick = onDownloadClick,
                    )
                }
            }
        } else if (!state.analyzing && error == null) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = palette.sunken,
                border = BorderStroke(1.dp, palette.line),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = stringResource(R.string.home_empty_title),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                    )
                    Text(
                        text = stringResource(R.string.home_empty_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))
    }
}
