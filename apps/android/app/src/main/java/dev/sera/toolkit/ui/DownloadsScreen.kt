package dev.sera.toolkit.ui

import android.net.Uri
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.CheckCircleOutline
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.DownloadDone
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sera.toolkit.R
import dev.sera.toolkit.data.DownloadTaskRecord
import dev.sera.toolkit.data.DownloadTaskStatus
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.domain.HistoryEntry
import dev.sera.toolkit.domain.HistoryModel
import dev.sera.toolkit.ui.theme.LocalSeraPalette

@Composable
fun DownloadsScreen(
    tasks: List<DownloadTaskRecord>,
    history: List<HistoryEntry>,
    onCancelTask: (String) -> Unit,
    onRetryTask: (String) -> Unit,
    onRemoveFailedTask: (String) -> Unit,
    onOpenFile: (Uri, String?) -> Unit,
    onShareFile: (Uri, String?) -> Unit,
    onRemoveHistoryEntry: (String) -> Unit,
    onClearHistory: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    var showClearDialog by remember { mutableStateOf(false) }

    val activeTasks = remember(tasks) {
        tasks.filter {
            it.status == DownloadTaskStatus.RUNNING || it.status == DownloadTaskStatus.QUEUED
        }
    }
    val failedTasks = remember(tasks) {
        tasks.filter { it.status == DownloadTaskStatus.FAILED }
    }

    val isEmpty = activeTasks.isEmpty() && failedTasks.isEmpty() && history.isEmpty()

    if (showClearDialog) {
        AlertDialog(
            onDismissRequest = { showClearDialog = false },
            title = { Text(text = stringResource(R.string.downloads_clear_history_title)) },
            text = { Text(text = stringResource(R.string.downloads_clear_history_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showClearDialog = false
                        onClearHistory()
                    },
                ) {
                    Text(
                        text = stringResource(R.string.downloads_clear_history),
                        color = palette.danger,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearDialog = false }) {
                    Text(text = stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (isEmpty) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Rounded.DownloadDone,
                contentDescription = null,
                tint = palette.inkFaint,
                modifier = Modifier.size(44.dp),
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.downloads_empty_title),
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = stringResource(R.string.downloads_empty_body),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
        }
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (activeTasks.isNotEmpty()) {
            item(key = "header_active") {
                SectionHeading(text = stringResource(R.string.downloads_section_active))
            }
            items(activeTasks, key = { "active_${it.id}" }) { task ->
                ActiveDownloadCard(
                    task = task,
                    onCancel = { onCancelTask(task.id) },
                )
            }
        }

        if (failedTasks.isNotEmpty()) {
            item(key = "header_failed") {
                SectionHeading(text = stringResource(R.string.downloads_section_failed))
            }
            items(failedTasks, key = { "failed_${it.id}" }) { task ->
                FailedDownloadCard(
                    task = task,
                    onRetry = { onRetryTask(task.id) },
                    onRemove = { onRemoveFailedTask(task.id) },
                )
            }
        }

        if (history.isNotEmpty()) {
            item(key = "header_history") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    SectionHeading(text = stringResource(R.string.downloads_section_finished))
                    TextButton(onClick = { showClearDialog = true }) {
                        Text(
                            text = stringResource(R.string.downloads_clear_history),
                            color = palette.inkMuted,
                        )
                    }
                }
            }
            items(history, key = { "history_${it.jobId}" }) { entry ->
                HistoryDownloadCard(
                    entry = entry,
                    onOpen = {
                        entry.localUri?.let { uriStr ->
                            onOpenFile(Uri.parse(uriStr), entry.mimeType)
                        }
                    },
                    onShare = {
                        entry.localUri?.let { uriStr ->
                            onShareFile(Uri.parse(uriStr), entry.mimeType)
                        }
                    },
                    onRemove = { onRemoveHistoryEntry(entry.jobId) },
                )
            }
        }
    }
}

@Composable
private fun SectionHeading(text: String) {
    val palette = LocalSeraPalette.current
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = palette.inkFaint,
        modifier = Modifier.padding(top = 4.dp),
    )
}

@Composable
private fun ActiveDownloadCard(
    task: DownloadTaskRecord,
    onCancel: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val speed = Formatters.formatSpeed(task.speedBytesPerSecond)
    val eta = Formatters.formatEta(task.etaSeconds)
    val fileInfo = if (task.currentFile != null && task.totalFiles != null && task.totalFiles > 1) {
        stringResource(R.string.downloads_file_progress, task.currentFile, task.totalFiles)
    } else {
        ""
    }
    val metaLine = listOfNotNull(
        task.step.takeIf { it.isNotBlank() },
        if (!task.indeterminate && task.percent in 1..100) "${task.percent}%" else null,
        speed.takeIf { it.isNotEmpty() },
        eta.takeIf { it.isNotEmpty() },
        fileInfo.takeIf { it.isNotEmpty() },
    ).joinToString(" · ")

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = palette.surface,
        border = BorderStroke(1.dp, palette.accent.copy(alpha = 0.35f)),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = task.title.ifBlank { task.sourceUrl },
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (task.providerLabel.isNotBlank()) {
                        Text(
                            text = task.providerLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.inkFaint,
                        )
                    }
                }
                IconButton(onClick = onCancel) {
                    Icon(
                        imageVector = Icons.Rounded.Cancel,
                        contentDescription = stringResource(R.string.action_cancel),
                        tint = palette.inkMuted,
                    )
                }
            }

            if (task.indeterminate) {
                LinearProgressIndicator(
                    color = palette.accent,
                    trackColor = palette.sunken,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                LinearProgressIndicator(
                    progress = { (task.percent / 100f).coerceIn(0f, 1f) },
                    color = palette.accent,
                    trackColor = palette.sunken,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = metaLine,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onCancel) {
                    Text(text = stringResource(R.string.action_cancel), color = palette.danger)
                }
            }
        }
    }
}

@Composable
private fun FailedDownloadCard(
    task: DownloadTaskRecord,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val error = task.error

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = palette.dangerWash,
        border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.35f)),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.ErrorOutline,
                    contentDescription = null,
                    tint = palette.danger,
                    modifier = Modifier.size(20.dp),
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        text = task.title.ifBlank { task.sourceUrl },
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = error?.message ?: stringResource(R.string.download_failed_title),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.danger,
                    )
                    if (!error?.hint.isNullOrBlank()) {
                        Text(
                            text = error?.hint.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.inkMuted,
                        )
                    }
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (error?.retryable == true) {
                    Button(
                        onClick = onRetry,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.accentInk,
                        ),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(text = stringResource(R.string.action_retry))
                    }
                }
                OutlinedButton(
                    onClick = onRemove,
                    shape = RoundedCornerShape(10.dp),
                ) {
                    Text(text = stringResource(R.string.action_remove))
                }
            }
        }
    }
}

@Composable
private fun HistoryDownloadCard(
    entry: HistoryEntry,
    onOpen: () -> Unit,
    onShare: () -> Unit,
    onRemove: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val sizeText = Formatters.formatBytes(entry.sizeBytes)
    val timeAgo = HistoryModel.timeAgo(entry.savedAt)
    val filesLabel = if (entry.fileCount != null && entry.fileCount > 1) {
        stringResource(R.string.downloads_files_saved, entry.fileCount)
    } else {
        ""
    }
    val metaParts = listOfNotNull(
        entry.source.takeIf { it.isNotBlank() },
        filesLabel.takeIf { it.isNotEmpty() },
        sizeText.takeIf { it.isNotEmpty() },
        timeAgo.takeIf { it.isNotEmpty() },
    ).joinToString(" · ")
    val hasLocalFile = !entry.localUri.isNullOrBlank()

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = palette.surface,
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.CheckCircleOutline,
                    contentDescription = null,
                    tint = palette.success,
                    modifier = Modifier.size(20.dp),
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = entry.title.ifBlank { entry.filename },
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = entry.filename,
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.inkMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (metaParts.isNotEmpty()) {
                        Text(
                            text = metaParts,
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.inkFaint,
                        )
                    }
                }
                IconButton(onClick = onRemove) {
                    Icon(
                        imageVector = Icons.Rounded.DeleteOutline,
                        contentDescription = stringResource(R.string.action_remove),
                        tint = palette.inkFaint,
                    )
                }
            }

            if (hasLocalFile) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = onOpen,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.accentInk,
                        ),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.OpenInNew,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(text = stringResource(R.string.action_open))
                    }
                    OutlinedButton(
                        onClick = onShare,
                        shape = RoundedCornerShape(10.dp),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Share,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(text = stringResource(R.string.action_share))
                    }
                }
            }
        }
    }
}
