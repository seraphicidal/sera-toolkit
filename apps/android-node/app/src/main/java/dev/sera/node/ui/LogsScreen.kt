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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteSweep
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sera.node.data.LogEntry
import dev.sera.node.data.LogLevel
import dev.sera.node.ui.theme.LocalSeraPalette
import kotlinx.coroutines.launch

private enum class LogFilter(val label: String) {
    ALL("All"),
    NODE("Node"),
    YTDLP("yt-dlp"),
    UPDATER("Updater"),
    NET("Network"),
    WARNINGS("Warnings"),
    ERRORS("Errors"),
}

@Composable
fun LogsScreen(
    logs: List<LogEntry>,
    onCopyLogs: (String) -> Unit,
    onClearLogs: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    var selectedFilterName by rememberSaveable { mutableStateOf(LogFilter.ALL.name) }
    val selectedFilter = LogFilter.entries.firstOrNull { it.name == selectedFilterName } ?: LogFilter.ALL
    var autoScroll by rememberSaveable { mutableStateOf(true) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    val trimmedQuery = searchQuery.trim()
    val filtered = remember(logs, selectedFilter, trimmedQuery) {
        val byTag = when (selectedFilter) {
            LogFilter.ALL -> logs
            LogFilter.NODE -> logs.filter {
                it.tag.equals("NODE", ignoreCase = true) || it.tag.equals("SERVICE", ignoreCase = true)
            }

            LogFilter.YTDLP -> logs.filter {
                it.tag.equals("YTDLP", ignoreCase = true) || it.tag.equals("EXTRACTOR", ignoreCase = true)
            }

            LogFilter.UPDATER -> logs.filter { it.tag.equals("UPDATER", ignoreCase = true) }
            LogFilter.NET -> logs.filter { it.tag.equals("NET", ignoreCase = true) }
            LogFilter.WARNINGS -> logs.filter { it.level == LogLevel.WARN }
            LogFilter.ERRORS -> logs.filter { it.level == LogLevel.ERROR }
        }
        if (trimmedQuery.isEmpty()) {
            byTag
        } else {
            byTag.filter { entry ->
                entry.message.contains(trimmedQuery, ignoreCase = true) ||
                    entry.tag.contains(trimmedQuery, ignoreCase = true) ||
                    entry.level.label.contains(trimmedQuery, ignoreCase = true)
            }
        }
    }

    val lastEntryId = filtered.lastOrNull()?.id
    LaunchedEffect(lastEntryId, autoScroll) {
        if (autoScroll && filtered.isNotEmpty()) {
            listState.scrollToItem(filtered.lastIndex)
        }
    }

    val isAtBottom by remember(filtered) {
        derivedStateOf {
            if (filtered.isEmpty()) {
                true
            } else {
                val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                lastVisible >= filtered.lastIndex - 1
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            placeholder = { Text("Search logs by tag, task, or message") },
            leadingIcon = {
                Icon(
                    imageVector = Icons.Rounded.Search,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
            },
            trailingIcon = {
                if (searchQuery.isNotEmpty()) {
                    IconButton(onClick = { searchQuery = "" }) {
                        Icon(
                            imageVector = Icons.Rounded.Close,
                            contentDescription = "Clear search",
                        )
                    }
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                imeAction = ImeAction.Search,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LogFilter.entries.forEach { filter ->
                FilterChip(
                    selected = selectedFilter == filter,
                    onClick = { selectedFilterName = filter.name },
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
            Text(
                text = if (selectedFilter == LogFilter.ALL && trimmedQuery.isEmpty()) {
                    "${logs.size}"
                } else {
                    "${filtered.size}/${logs.size}"
                },
                style = MaterialTheme.typography.labelMedium,
                color = palette.inkMuted,
            )
            Spacer(modifier = Modifier.weight(1f))
            OutlinedButton(
                onClick = {
                    val text = filtered.joinToString("\n") { entry ->
                        "[${entry.formattedTime}] [${entry.level.label}] [${entry.tag}] ${entry.message}"
                    }
                    onCopyLogs(text)
                },
                enabled = filtered.isNotEmpty(),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.Rounded.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("Copy")
            }
            OutlinedButton(
                onClick = onClearLogs,
                enabled = logs.isNotEmpty(),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
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
                        text = if (logs.isEmpty()) "No log entries yet" else "No matching log entries",
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            } else {
                Box(modifier = Modifier.fillMaxSize()) {
                    SelectionContainer {
                        LazyColumn(
                            state = listState,
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            items(filtered, key = { it.id }) { entry ->
                                LogLineRow(entry)
                            }
                        }
                    }

                    if (!isAtBottom) {
                        FilledTonalButton(
                            onClick = {
                                autoScroll = true
                                coroutineScope.launch {
                                    if (filtered.isNotEmpty()) {
                                        listState.animateScrollToItem(filtered.lastIndex)
                                    }
                                }
                            },
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(12.dp)
                                .heightIn(min = 48.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.KeyboardArrowDown,
                                contentDescription = "Jump to latest logs",
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Latest")
                        }
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
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = palette.inkFaint,
        )
        Text(
            text = "[${entry.tag}]",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            fontWeight = FontWeight.SemiBold,
            color = tagColor,
        )
        Text(
            text = entry.message,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = msgColor,
            modifier = Modifier.weight(1f),
        )
    }
}
