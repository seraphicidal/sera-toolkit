package dev.sera.node.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteSweep
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sera.node.data.LogEntry
import dev.sera.node.data.LogLevel
import dev.sera.node.ui.theme.LocalSeraPalette

private enum class LogFilter(val label: String) {
    ALL("All"),
    NODE("Node"),
    YTDLP("yt-dlp"),
    UPDATER("Updater"),
    NET("Network"),
    ERRORS("Errors"),
}

@Composable
fun LogsScreen(
    logs: List<LogEntry>,
    onCopyLogs: (String) -> Unit,
    onClearLogs: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    var selectedFilter by remember { mutableStateOf(LogFilter.ALL) }
    var autoScroll by remember { mutableStateOf(true) }
    val listState = rememberLazyListState()

    val filtered = remember(logs, selectedFilter) {
        when (selectedFilter) {
            LogFilter.ALL -> logs
            LogFilter.NODE -> logs.filter { it.tag.equals("NODE", ignoreCase = true) || it.tag.equals("SERVICE", ignoreCase = true) }
            LogFilter.YTDLP -> logs.filter { it.tag.equals("YTDLP", ignoreCase = true) || it.tag.equals("EXTRACTOR", ignoreCase = true) }
            LogFilter.UPDATER -> logs.filter { it.tag.equals("UPDATER", ignoreCase = true) }
            LogFilter.NET -> logs.filter { it.tag.equals("NET", ignoreCase = true) }
            LogFilter.ERRORS -> logs.filter { it.level == LogLevel.ERROR || it.level == LogLevel.WARN }
        }
    }

    LaunchedEffect(filtered.size, autoScroll) {
        if (autoScroll && filtered.isNotEmpty()) {
            listState.scrollToItem(filtered.size - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LogFilter.entries.forEach { filter ->
                FilterChip(
                    selected = selectedFilter == filter,
                    onClick = { selectedFilter = filter },
                    label = { Text(filter.label) },
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilterChip(
                selected = autoScroll,
                onClick = { autoScroll = !autoScroll },
                label = { Text("Auto-scroll") },
            )
            Spacer(modifier = Modifier.weight(1f))
            OutlinedButton(
                onClick = {
                    val text = filtered.joinToString("\n") { entry ->
                        "[${entry.formattedTime}] [${entry.level.label}] [${entry.tag}] ${entry.message}"
                    }
                    onCopyLogs(text)
                },
            ) {
                Icon(Icons.Rounded.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("Copy")
            }
            OutlinedButton(onClick = onClearLogs) {
                Icon(Icons.Rounded.DeleteSweep, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("Clear")
            }
        }

        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            shape = RoundedCornerShape(14.dp),
            color = palette.surface,
            border = BorderStroke(1.dp, palette.line),
        ) {
            if (filtered.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "No log entries yet",
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(filtered, key = { it.id }) { entry ->
                        LogLineRow(entry)
                    }
                }
            }
        }
    }
}

@Composable
private fun LogLineRow(entry: LogEntry) {
    val palette = LocalSeraPalette.current
    val msgColor = when (entry.level) {
        LogLevel.ERROR -> palette.danger
        LogLevel.WARN -> palette.warning
        LogLevel.INFO -> palette.ink
        LogLevel.DEBUG -> palette.inkMuted
    }
    val tagColor = when (entry.tag.uppercase()) {
        "UPDATER" -> palette.accent
        "NET" -> palette.success
        "YTDLP", "EXTRACTOR" -> palette.warning
        else -> palette.inkMuted
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = entry.formattedTime,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = palette.inkFaint,
        )
        Text(
            text = "[${entry.tag}]",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = tagColor,
        )
        Text(
            text = entry.message,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.5.sp,
            color = msgColor,
            modifier = Modifier.weight(1f),
        )
    }
}
