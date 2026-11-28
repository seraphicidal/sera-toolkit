package dev.sera.toolkit.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Audiotrack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.GifBox
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import dev.sera.toolkit.R
import dev.sera.toolkit.data.SeraApiClient
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.domain.ResolvedSelection
import dev.sera.toolkit.domain.SelectionLogic
import dev.sera.toolkit.domain.SubtitleChoices
import dev.sera.toolkit.domain.TrimSummary
import dev.sera.toolkit.domain.TrimValidator
import dev.sera.toolkit.model.DownloadOption
import dev.sera.toolkit.model.JobError
import dev.sera.toolkit.model.MAX_FILENAME_LENGTH
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.MediaItem
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.PackagingMode
import dev.sera.toolkit.model.SubtitleFormat
import dev.sera.toolkit.model.SubtitleRequest
import dev.sera.toolkit.ui.theme.LocalSeraPalette

fun kindIcon(kind: MediaKind): ImageVector = when (kind) {
    MediaKind.VIDEO -> Icons.Rounded.Movie
    MediaKind.AUDIO -> Icons.Rounded.Audiotrack
    MediaKind.IMAGE -> Icons.Rounded.Image
    MediaKind.GIF -> Icons.Rounded.GifBox
    MediaKind.FILE -> Icons.Rounded.Description
    MediaKind.UNKNOWN -> Icons.Rounded.Movie
}

@Composable
fun NodeOfflineBanner(modifier: Modifier = Modifier) {
    val palette = LocalSeraPalette.current
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = palette.sunken,
        border = BorderStroke(1.dp, palette.warning.copy(alpha = 0.45f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.WarningAmber,
                contentDescription = null,
                tint = palette.warning,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = stringResource(R.string.node_offline_banner),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
        }
    }
}

@Composable
fun ErrorCard(
    error: JobError,
    onRetry: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    Surface(
        modifier = modifier.fillMaxWidth(),
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
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.ErrorOutline,
                    contentDescription = null,
                    tint = palette.danger,
                    modifier = Modifier.size(20.dp),
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = error.message,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                    )
                    if (!error.hint.isNullOrBlank()) {
                        Text(
                            text = error.hint,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.inkMuted,
                        )
                    }
                }
            }
            if ((error.retryable && onRetry != null) || onDismiss != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (error.retryable && onRetry != null) {
                        Button(
                            onClick = onRetry,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = palette.accent,
                                contentColor = palette.accentInk,
                            ),
                        ) {
                            Text(text = stringResource(R.string.action_retry))
                        }
                    }
                    if (onDismiss != null) {
                        OutlinedButton(onClick = onDismiss) {
                            Text(text = stringResource(R.string.action_dismiss))
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun MediaPreviewHeader(
    info: MediaInfo,
    serverUrl: String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val thumbUrl = remember(serverUrl, info.thumbnail) {
        SeraApiClient.resolveApiPath(serverUrl, info.thumbnail)
    }
    val durationText = remember(info.duration) { Formatters.formatDuration(info.duration) }
    val subtitleParts = remember(info.providerLabel, info.author, durationText) {
        listOfNotNull(
            info.providerLabel.takeIf { it.isNotBlank() },
            info.author?.takeIf { it.isNotBlank() },
            durationText.takeIf { it.isNotBlank() },
        ).joinToString(" · ")
    }

    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(palette.sunken)
                .border(1.dp, palette.line, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = kindIcon(info.items.firstOrNull()?.kind ?: MediaKind.VIDEO),
                contentDescription = null,
                tint = palette.inkFaint,
                modifier = Modifier.size(28.dp),
            )
            if (thumbUrl != null) {
                AsyncImage(
                    model = thumbUrl,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = info.title.ifBlank { info.url },
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitleParts.isNotEmpty()) {
                Text(
                    text = subtitleParts,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
fun KindSelectorRow(
    info: MediaInfo,
    availableKinds: List<MediaKind>,
    selectedKind: MediaKind,
    enabled: Boolean = true,
    onSelectKind: (MediaKind) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (availableKinds.size <= 1) return
    val palette = LocalSeraPalette.current
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.picker_format_heading).uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = palette.inkFaint,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            availableKinds.forEach { candidate ->
                val isSelected = candidate == selectedKind
                FilterChip(
                    selected = isSelected,
                    enabled = enabled,
                    onClick = { onSelectKind(candidate) },
                    label = {
                        Text(text = SelectionLogic.kindDisplayLabel(info, candidate))
                    },
                    leadingIcon = {
                        Icon(
                            imageVector = kindIcon(candidate),
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                    },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = palette.accentWash,
                        selectedLabelColor = palette.accent,
                        selectedLeadingIconColor = palette.accent,
                    ),
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QualityOptionList(
    info: MediaInfo,
    kind: MediaKind,
    selectedIds: Set<String>,
    selectedLabel: String?,
    enabled: Boolean = true,
    onSelectLabel: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val effectiveIds = remember(info.items, selectedIds) {
        if (selectedIds.isEmpty()) info.items.map { it.id }.toSet() else selectedIds
    }
    val labels = remember(info, kind, effectiveIds) {
        SelectionLogic.qualityLabels(info, kind, effectiveIds)
    }
    if (labels.isEmpty()) return

    val activeLabel = selectedLabel?.takeIf { it in labels }
        ?: SelectionLogic.preferredLabelForKind(info, kind, effectiveIds)
        ?: labels.first()

    val matchingOptions = remember(info.items, effectiveIds, kind) {
        info.items
            .filter { it.id in effectiveIds }
            .flatMap { SelectionLogic.optionsOfKind(it, kind) }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.picker_quality_heading).uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = palette.inkFaint,
        )
        labels.forEach { candidate ->
            val option = remember(matchingOptions, candidate) {
                matchingOptions.firstOrNull { it.label == candidate }
            }
            val aggregated = remember(info, effectiveIds, kind, candidate) {
                if (effectiveIds.size > 1) {
                    SelectionLogic.resolveSelection(info, effectiveIds, kind, candidate)
                } else {
                    null
                }
            }
            val sizeBytes = aggregated?.totalBytes ?: option?.filesizeBytes
            val approximate = aggregated?.anyApproximate ?: (option?.filesizeIsApproximate == true)
            val badges = remember(option) { option?.let { Formatters.optionBadges(it) }.orEmpty() }
            val isSelected = candidate == activeLabel

            QualityOptionCard(
                label = candidate,
                option = option,
                sizeBytes = sizeBytes,
                approximate = approximate,
                badges = badges,
                selected = isSelected,
                enabled = enabled,
                onClick = { onSelectLabel(candidate) },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QualityOptionCard(
    label: String,
    option: DownloadOption?,
    sizeBytes: Long?,
    approximate: Boolean,
    badges: List<String>,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val sizeText = remember(sizeBytes, approximate) {
        val formatted = Formatters.formatBytes(sizeBytes)
        if (formatted.isEmpty()) "" else if (approximate) "~$formatted" else formatted
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.55f)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        color = if (selected) palette.accentWash else palette.surface,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) palette.accent else palette.line,
        ),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = palette.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (option?.recommended == true) {
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = palette.accent.copy(alpha = 0.14f),
                        ) {
                            Text(
                                text = stringResource(R.string.picker_recommended_badge),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.accent,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
                if (sizeText.isNotEmpty()) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = sizeText,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }

            if (option != null || badges.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (option != null && option.container.isNotBlank()) {
                        BadgeChip(
                            text = option.container.uppercase(),
                            accented = false,
                        )
                    }
                    badges.forEach { badge ->
                        BadgeChip(text = badge, accented = true)
                    }
                }
            }

            if (option != null && (!option.detail.isNullOrBlank() || option.requiresConversion)) {
                val note = listOfNotNull(
                    option.detail?.takeIf { it.isNotBlank() },
                    if (option.requiresConversion) stringResource(R.string.picker_converted_note) else null,
                ).joinToString(" · ")
                if (note.isNotEmpty()) {
                    Text(
                        text = note,
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.inkFaint,
                    )
                }
            }
        }
    }
}

@Composable
private fun BadgeChip(text: String, accented: Boolean) {
    val palette = LocalSeraPalette.current
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = if (accented) palette.surface else palette.sunken,
        border = BorderStroke(
            1.dp,
            if (accented) palette.accent.copy(alpha = 0.3f) else palette.line,
        ),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = if (accented) palette.accent else palette.inkMuted,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
fun CollectionItemPicker(
    info: MediaInfo,
    serverUrl: String,
    selectedIds: Set<String>,
    maxItems: Int,
    onToggleItem: (String) -> Unit,
    onSelectItems: (Set<String>) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (info.items.size <= 1) return
    val palette = LocalSeraPalette.current
    var filterQuery by remember(info.id) { mutableStateOf("") }
    val showFilter = info.items.size > 6
    val visibleItems = remember(info.items, filterQuery, showFilter) {
        if (showFilter) SelectionLogic.filterMediaItems(info.items, filterQuery) else info.items
    }
    val isFiltered = showFilter && visibleItems.size != info.items.size
    val atCap = selectedIds.size >= maxItems
    val cappedPlaylist = info.items.size > maxItems
    val cappedVisible = visibleItems.size > maxItems

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            val foundText = Formatters.pluralize(info.items.size, "item")
            val headerLabel = if (isFiltered) {
                stringResource(
                    R.string.picker_items_matches,
                    foundText,
                    Formatters.pluralize(visibleItems.size, "match", "matches"),
                )
            } else {
                stringResource(R.string.picker_items_found, foundText)
            }
            Text(
                text = headerLabel.uppercase(),
                style = MaterialTheme.typography.labelMedium,
                color = palette.inkFaint,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = {
                        val base = if (isFiltered) selectedIds else emptySet()
                        val next = SelectionLogic.selectItemsUpToMax(visibleItems, maxItems, base)
                        onSelectItems(next)
                    },
                ) {
                    Text(
                        text = when {
                            cappedVisible -> stringResource(R.string.action_select_first, maxItems)
                            isFiltered -> stringResource(R.string.action_select_matches)
                            else -> stringResource(R.string.action_select_all)
                        },
                    )
                }
                TextButton(
                    enabled = selectedIds.isNotEmpty(),
                    onClick = { onSelectItems(emptySet()) },
                ) {
                    Text(text = stringResource(R.string.action_clear))
                }
            }
        }

        if (showFilter) {
            OutlinedTextField(
                value = filterQuery,
                onValueChange = { filterQuery = it },
                singleLine = true,
                placeholder = { Text(text = stringResource(R.string.picker_filter_placeholder)) },
                trailingIcon = if (filterQuery.isNotEmpty()) {
                    {
                        IconButton(onClick = { filterQuery = "" }) {
                            Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.action_clear))
                        }
                    }
                } else {
                    null
                },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (visibleItems.isEmpty()) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                color = palette.sunken,
                border = BorderStroke(1.dp, palette.line),
            ) {
                Text(
                    text = stringResource(R.string.picker_no_matches, filterQuery),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                    modifier = Modifier.padding(14.dp),
                )
            }
        } else {
            val gridHeight = if (visibleItems.size <= 2) 150.dp else if (visibleItems.size <= 4) 260.dp else 280.dp
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = gridHeight),
            ) {
                items(visibleItems, key = { it.id }) { item ->
                    val isSelected = item.id in selectedIds
                    val isDisabled = !isSelected && atCap
                    MediaItemTile(
                        item = item,
                        serverUrl = serverUrl,
                        selected = isSelected,
                        disabled = isDisabled,
                        onClick = { onToggleItem(item.id) },
                    )
                }
            }
        }

        val countLabel = if (selectedIds.isEmpty()) {
            stringResource(R.string.picker_select_at_least_one)
        } else if (cappedPlaylist) {
            stringResource(
                R.string.picker_selected_count_capped,
                Formatters.pluralize(selectedIds.size, "item"),
                maxItems,
            )
        } else {
            stringResource(
                R.string.picker_selected_count,
                Formatters.pluralize(selectedIds.size, "item"),
            )
        }
        Text(
            text = countLabel,
            style = MaterialTheme.typography.bodyMedium,
            color = if (selectedIds.isEmpty()) palette.danger else palette.inkMuted,
        )
        if (atCap && cappedPlaylist) {
            Text(
                text = stringResource(R.string.picker_cap_notice, maxItems),
                style = MaterialTheme.typography.labelSmall,
                color = palette.inkFaint,
            )
        }
    }
}

@Composable
private fun MediaItemTile(
    item: MediaItem,
    serverUrl: String,
    selected: Boolean,
    disabled: Boolean,
    onClick: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val thumbUrl = remember(serverUrl, item.thumbnail) {
        SeraApiClient.resolveApiPath(serverUrl, item.thumbnail)
    }
    val displayTitle = item.title?.takeIf { it.isNotBlank() }
        ?: Formatters.kindLabel(if (item.kind == MediaKind.UNKNOWN) MediaKind.VIDEO else item.kind)
    val duration = remember(item.duration) { Formatters.formatDuration(item.duration) }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (disabled) 0.45f else 1f)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = !disabled, onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        color = if (selected) palette.accentWash else palette.surface,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) palette.accent else palette.line,
        ),
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(4f / 3f)
                    .background(palette.sunken),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = kindIcon(item.kind),
                    contentDescription = null,
                    tint = palette.inkFaint,
                    modifier = Modifier.size(24.dp),
                )
                if (thumbUrl != null) {
                    AsyncImage(
                        model = thumbUrl,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(if (selected) palette.accent else palette.surface.copy(alpha = 0.85f))
                        .border(
                            1.dp,
                            if (selected) palette.accent else palette.lineStrong,
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    if (selected) {
                        Icon(
                            imageVector = Icons.Rounded.Check,
                            contentDescription = null,
                            tint = palette.accentInk,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "${item.index}. $displayTitle",
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.inkMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (duration.isNotEmpty()) {
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = duration,
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.inkFaint,
                    )
                }
            }
        }
    }
}

@Composable
fun PackagingSelector(
    packaging: PackagingMode,
    onPackagingChange: (PackagingMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.picker_packaging_heading).uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = palette.inkFaint,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(palette.sunken)
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            PackagingMode.entries.forEach { mode ->
                val selected = packaging == mode
                val label = when (mode) {
                    PackagingMode.AUTO -> stringResource(R.string.picker_packaging_auto)
                    PackagingMode.ZIP -> stringResource(R.string.picker_packaging_zip)
                    PackagingMode.INDIVIDUAL -> stringResource(R.string.picker_packaging_individual)
                }
                Surface(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onPackagingChange(mode) },
                    shape = RoundedCornerShape(8.dp),
                    color = if (selected) palette.surface else palette.sunken,
                    shadowElevation = if (selected) 1.dp else 0.dp,
                ) {
                    Box(
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = label,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (selected) palette.ink else palette.inkMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubtitleOptionsSection(
    choices: SubtitleChoices,
    selectedTrackValue: String,
    selectedFormat: SubtitleFormat,
    onlySubtitles: Boolean,
    disabledByTrim: Boolean,
    onTrackChange: (String) -> Unit,
    onFormatChange: (SubtitleFormat) -> Unit,
    onOnlyChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    var expanded by remember { mutableStateOf(false) }
    val selectedTrack = choices.tracks.firstOrNull { SelectionLogic.trackValue(it) == selectedTrackValue }
    val displayLabel = if (disabledByTrim || selectedTrack == null) {
        stringResource(R.string.picker_subtitles_none)
    } else {
        selectedTrack.label
    }

    val formats = remember(choices.canEmbed) {
        buildList {
            if (choices.canEmbed) add(SubtitleFormat.EMBED)
            add(SubtitleFormat.SRT)
            add(SubtitleFormat.VTT)
        }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.picker_subtitles_heading).uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = palette.inkFaint,
        )

        ExposedDropdownMenuBox(
            expanded = expanded && !disabledByTrim,
            onExpandedChange = { if (!disabledByTrim) expanded = !expanded },
        ) {
            OutlinedTextField(
                value = displayLabel,
                onValueChange = {},
                readOnly = true,
                enabled = !disabledByTrim,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable),
            )
            ExposedDropdownMenu(
                expanded = expanded && !disabledByTrim,
                onDismissRequest = { expanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text(text = stringResource(R.string.picker_subtitles_none)) },
                    onClick = {
                        onTrackChange("")
                        expanded = false
                    },
                )
                choices.tracks.forEach { track ->
                    val value = SelectionLogic.trackValue(track)
                    DropdownMenuItem(
                        text = { Text(text = track.label) },
                        onClick = {
                            onTrackChange(value)
                            expanded = false
                        },
                    )
                }
            }
        }

        if (disabledByTrim) {
            Text(
                text = stringResource(R.string.picker_subtitles_disabled_trim),
                style = MaterialTheme.typography.labelSmall,
                color = palette.inkFaint,
            )
        } else if (selectedTrack != null) {
            val effectiveFormat = if (selectedFormat == SubtitleFormat.EMBED && !choices.canEmbed) {
                SubtitleFormat.SRT
            } else {
                selectedFormat
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(palette.sunken)
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                formats.forEach { fmt ->
                    val isSelected = effectiveFormat == fmt
                    val fmtLabel = when (fmt) {
                        SubtitleFormat.EMBED -> stringResource(R.string.picker_subtitles_embed)
                        SubtitleFormat.SRT -> stringResource(R.string.picker_subtitles_srt)
                        SubtitleFormat.VTT -> stringResource(R.string.picker_subtitles_vtt)
                    }
                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onFormatChange(fmt) },
                        shape = RoundedCornerShape(8.dp),
                        color = if (isSelected) palette.surface else palette.sunken,
                    ) {
                        Box(
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = fmtLabel,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (isSelected) palette.ink else palette.inkMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }

            if (effectiveFormat != SubtitleFormat.EMBED) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOnlyChange(!onlySubtitles) },
                ) {
                    Checkbox(
                        checked = onlySubtitles,
                        onCheckedChange = onOnlyChange,
                    )
                    Text(
                        text = stringResource(R.string.picker_subtitles_only),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }
        }
    }
}

@Composable
fun AdvancedOptionsSection(
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    filename: String,
    onFilenameChange: (String) -> Unit,
    multipleItems: Boolean,
    packaging: PackagingMode,
    onPackagingChange: (PackagingMode) -> Unit,
    canTrim: Boolean,
    trimStart: String,
    trimEnd: String,
    trimSummary: TrimSummary,
    durationSeconds: Double?,
    trimDisabledBySubtitles: Boolean,
    onTrimStartChange: (String) -> Unit,
    onTrimEndChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val isExpanded = expanded || trimSummary is TrimSummary.Invalid

    Column(modifier = modifier.fillMaxWidth()) {
        HorizontalDivider(color = palette.line)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = trimSummary !is TrimSummary.Invalid, onClick = onToggleExpanded)
                .padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = if (isExpanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                contentDescription = null,
                tint = palette.inkMuted,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = stringResource(R.string.picker_more_options),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = palette.inkMuted,
            )
        }

        if (isExpanded) {
            Column(
                modifier = Modifier.padding(top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = stringResource(R.string.picker_filename_label).uppercase(),
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.inkFaint,
                    )
                    OutlinedTextField(
                        value = filename,
                        onValueChange = { if (it.length <= MAX_FILENAME_LENGTH) onFilenameChange(it) },
                        singleLine = true,
                        placeholder = { Text(text = stringResource(R.string.picker_filename_placeholder)) },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                if (canTrim) {
                    val isInvalid = !trimDisabledBySubtitles && trimSummary is TrimSummary.Invalid
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = stringResource(R.string.picker_trim_heading).uppercase(),
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.inkFaint,
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            OutlinedTextField(
                                value = trimStart,
                                onValueChange = { if (it.length <= 9) onTrimStartChange(it) },
                                enabled = !trimDisabledBySubtitles,
                                isError = isInvalid,
                                singleLine = true,
                                label = { Text(text = stringResource(R.string.picker_trim_start)) },
                                placeholder = { Text(text = "0:00") },
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                value = trimEnd,
                                onValueChange = { if (it.length <= 9) onTrimEndChange(it) },
                                enabled = !trimDisabledBySubtitles,
                                isError = isInvalid,
                                singleLine = true,
                                label = { Text(text = stringResource(R.string.picker_trim_end)) },
                                placeholder = { Text(text = TrimValidator.endPlaceholder(durationSeconds)) },
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.weight(1f),
                            )
                        }
                        val summaryText = when {
                            trimDisabledBySubtitles -> stringResource(R.string.picker_trim_disabled_subtitles)
                            trimSummary is TrimSummary.Invalid -> trimSummary.message
                            trimSummary is TrimSummary.Valid -> {
                                val parts = buildList {
                                    val kept = trimSummary.keptSeconds
                                    if (kept != null) {
                                        add(
                                            stringResource(
                                                R.string.picker_trim_keeps,
                                                Formatters.formatDuration(kept.toDouble()),
                                            ),
                                        )
                                    } else {
                                        add(stringResource(R.string.picker_trim_keeps_range))
                                    }
                                    val est = trimSummary.estimatedBytes
                                    if (est != null && est > 0L) {
                                        add(
                                            stringResource(
                                                R.string.picker_trim_about_size,
                                                Formatters.formatBytes(est),
                                            ),
                                        )
                                    }
                                }
                                parts.joinToString(" · ")
                            }
                            else -> stringResource(R.string.picker_trim_hint)
                        }
                        Text(
                            text = summaryText,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isInvalid) palette.danger else palette.inkFaint,
                        )
                    }
                }

                if (multipleItems) {
                    PackagingSelector(
                        packaging = packaging,
                        onPackagingChange = onPackagingChange,
                    )
                }
            }
        }
    }
}

@Composable
fun PrimaryDownloadButton(
    selection: ResolvedSelection?,
    trimSummary: TrimSummary,
    subtitlesRequest: SubtitleRequest?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalSeraPalette.current
    val enabled = (selection?.optionIds?.isNotEmpty() == true) && trimSummary !is TrimSummary.Invalid

    val baseLabel = when {
        subtitlesRequest?.only == true -> stringResource(R.string.action_download_subtitles)
        selection != null && selection.fileCount > 1 ->
            stringResource(R.string.action_download_files, selection.fileCount)
        else -> stringResource(R.string.action_download)
    }

    val sizeSuffix = when {
        subtitlesRequest?.only == true -> ""
        trimSummary is TrimSummary.Valid && trimSummary.estimatedBytes != null && trimSummary.estimatedBytes > 0L ->
            " · ~${Formatters.formatBytes(trimSummary.estimatedBytes)}"
        selection?.totalBytes != null && selection.totalBytes > 0L ->
            " · ${if (selection.anyApproximate) "~" else ""}${Formatters.formatBytes(selection.totalBytes)}"
        else -> ""
    }

    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = palette.accent,
            contentColor = palette.accentInk,
            disabledContainerColor = palette.sunken,
            disabledContentColor = palette.inkFaint,
        ),
        modifier = modifier
            .fillMaxWidth()
            .height(48.dp),
    ) {
        Icon(
            imageVector = Icons.Rounded.Download,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = baseLabel + sizeSuffix,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
        )
    }
}
