package dev.sera.toolkit

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.sera.toolkit.data.DeviceDownloadManager
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.domain.TrimSummary
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.ui.ShareUiState
import dev.sera.toolkit.ui.ShareViewModel
import dev.sera.toolkit.ui.components.CollectionItemPicker
import dev.sera.toolkit.ui.components.ErrorCard
import dev.sera.toolkit.ui.components.KindSelectorRow
import dev.sera.toolkit.ui.components.MediaPreviewHeader
import dev.sera.toolkit.ui.components.NodeOfflineBanner
import dev.sera.toolkit.ui.components.PackagingSelector
import dev.sera.toolkit.ui.components.PrimaryDownloadButton
import dev.sera.toolkit.ui.components.QualityOptionList
import dev.sera.toolkit.ui.theme.LocalSeraPalette
import dev.sera.toolkit.ui.theme.SeraTheme
import dev.sera.toolkit.ui.theme.isSeraDarkTheme
import kotlinx.coroutines.launch

class ShareActivity : ComponentActivity() {
    private val viewModel: ShareViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        viewModel.handleIncomingTexts(extractIntentTexts(intent))

        setContent {
            val settings by viewModel.settings.collectAsStateWithLifecycle()
            val uiState by viewModel.uiState.collectAsStateWithLifecycle()
            val useDark = isSeraDarkTheme(settings.themePreference)

            DisposableEffect(useDark) {
                val barStyle = if (useDark) {
                    SystemBarStyle.dark(Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                }
                enableEdgeToEdge(
                    statusBarStyle = barStyle,
                    navigationBarStyle = barStyle,
                )
                onDispose {}
            }

            SeraTheme(preference = settings.themePreference) {
                ShareSheetHost(
                    uiState = uiState,
                    notificationsPrompted = settings.notificationsPrompted,
                    onMarkNotificationsPrompted = viewModel::markNotificationsPrompted,
                    viewModel = viewModel,
                    onFinish = { finish() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        viewModel.handleIncomingTexts(extractIntentTexts(intent))
    }

    companion object {
        fun extractIntentTexts(intent: Intent?): List<String?> {
            if (intent == null) return emptyList()
            val texts = mutableListOf<String?>()
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { texts.add(it.toString()) }
            intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.let { texts.add(it.toString()) }
            intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.let { texts.add(it.toString()) }
            if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.forEach {
                    texts.add(it?.toString())
                }
                intent.getStringArrayListExtra(Intent.EXTRA_TEXT)?.forEach {
                    texts.add(it)
                }
            }
            return texts
        }
    }
}

@Composable
private fun ShareSheetHost(
    uiState: ShareUiState,
    notificationsPrompted: Boolean,
    onMarkNotificationsPrompted: () -> Unit,
    viewModel: ShareViewModel,
    onFinish: () -> Unit,
) {
    val context = LocalContext.current
    val palette = LocalSeraPalette.current
    val scope = rememberCoroutineScope()
    var pendingAction by remember { mutableStateOf<(() -> Unit)?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        val action = pendingAction
        pendingAction = null
        action?.invoke()
    }

    fun runWithPermissions(action: () -> Unit) {
        val needed = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !notificationsPrompted &&
                !DeviceDownloadManager.canPostNotifications(context)
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (DeviceDownloadManager.needsLegacyStoragePermission(context)) {
                add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
        if (needed.isEmpty()) {
            action()
        } else {
            if (Manifest.permission.POST_NOTIFICATIONS in needed) {
                onMarkNotificationsPrompted()
            }
            pendingAction = action
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    LaunchedEffect(uiState) {
        if (uiState is ShareUiState.QuickPending) {
            val urls = uiState.urls
            runWithPermissions {
                scope.launch {
                    viewModel.enqueueQuick(urls)
                    val toastText = if (urls.size > 1) {
                        context.getString(R.string.share_quick_toast_multiple, urls.size)
                    } else {
                        context.getString(R.string.share_quick_toast_single)
                    }
                    Toast.makeText(context, toastText, Toast.LENGTH_SHORT).show()
                    onFinish()
                }
            }
        }
    }

    if (uiState is ShareUiState.Initializing || uiState is ShareUiState.QuickPending) {
        Box(modifier = Modifier.fillMaxSize())
        return
    }

    val maxSheetHeight = (LocalConfiguration.current.screenHeightDp * 0.85f).dp

    Box(
        modifier = Modifier
            .fillMaxSize()
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() },
                onClick = onFinish,
            ),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = maxSheetHeight)
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick = {},
                ),
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            color = palette.surface,
            tonalElevation = 4.dp,
            shadowElevation = 12.dp,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .size(width = 36.dp, height = 4.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(palette.lineStrong),
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.share_sheet_title),
                        style = MaterialTheme.typography.titleMedium,
                        color = palette.ink,
                    )
                    IconButton(onClick = onFinish) {
                        Icon(
                            imageVector = Icons.Rounded.Close,
                            contentDescription = stringResource(R.string.action_close),
                            tint = palette.inkMuted,
                        )
                    }
                }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    when (uiState) {
                        is ShareUiState.NoUrlFound -> {
                            Text(
                                text = stringResource(R.string.share_no_url_title),
                                style = MaterialTheme.typography.titleMedium,
                                color = palette.danger,
                            )
                            Text(
                                text = if (uiState.receivedPreview.isNotBlank()) {
                                    stringResource(R.string.share_no_url_received, uiState.receivedPreview)
                                } else {
                                    stringResource(R.string.share_no_url_empty)
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.inkMuted,
                            )
                            OutlinedButton(
                                onClick = onFinish,
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(text = stringResource(R.string.action_close))
                            }
                        }

                        is ShareUiState.MultipleUrls -> {
                            if (uiState.nodesOffline) {
                                NodeOfflineBanner()
                            }
                            Text(
                                text = stringResource(R.string.share_multi_title, uiState.urls.size),
                                style = MaterialTheme.typography.titleMedium,
                                color = palette.ink,
                            )
                            Text(
                                text = stringResource(R.string.share_multi_body),
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
                                    val selected = uiState.preferredKind == kind
                                    val label = if (kind == null) {
                                        stringResource(R.string.settings_preferred_kind_auto)
                                    } else {
                                        Formatters.kindLabel(kind)
                                    }
                                    FilterChip(
                                        selected = selected,
                                        onClick = { viewModel.selectMultiKind(kind) },
                                        label = { Text(text = label) },
                                        colors = FilterChipDefaults.filterChipColors(
                                            selectedContainerColor = palette.accentWash,
                                            selectedLabelColor = palette.accent,
                                        ),
                                    )
                                }
                            }
                            Button(
                                onClick = {
                                    runWithPermissions {
                                        scope.launch {
                                            viewModel.enqueueMultiple(uiState.urls, uiState.preferredKind)
                                            Toast.makeText(
                                                context,
                                                context.getString(R.string.share_quick_toast_multiple, uiState.urls.size),
                                                Toast.LENGTH_SHORT,
                                            ).show()
                                            onFinish()
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(12.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = palette.accent,
                                    contentColor = palette.accentInk,
                                ),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(48.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Download,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(text = stringResource(R.string.action_queue_all, uiState.urls.size))
                            }
                        }

                        is ShareUiState.SingleResolving -> {
                            if (uiState.nodesOffline) {
                                NodeOfflineBanner()
                            }
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 20.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.Center,
                            ) {
                                CircularProgressIndicator(
                                    color = palette.accent,
                                    strokeWidth = 2.5.dp,
                                    modifier = Modifier.size(22.dp),
                                )
                                Spacer(modifier = Modifier.width(12.dp))
                                Text(
                                    text = stringResource(R.string.home_analyzing),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = palette.inkMuted,
                                )
                            }
                        }

                        is ShareUiState.SingleError -> {
                            if (uiState.nodesOffline) {
                                NodeOfflineBanner()
                            }
                            ErrorCard(
                                error = uiState.error,
                                onRetry = if (uiState.error.retryable) viewModel::retrySingle else null,
                                onDismiss = onFinish,
                            )
                        }

                        is ShareUiState.SingleReady -> {
                            if (uiState.nodesOffline) {
                                NodeOfflineBanner()
                            }
                            MediaPreviewHeader(
                                info = uiState.info,
                                serverUrl = uiState.serverUrl,
                            )
                            CollectionItemPicker(
                                info = uiState.info,
                                serverUrl = uiState.serverUrl,
                                selectedIds = uiState.selectedIds,
                                maxItems = uiState.maxItems,
                                onToggleItem = viewModel::toggleSingleItem,
                                onSelectItems = viewModel::selectSingleItems,
                            )
                            KindSelectorRow(
                                info = uiState.info,
                                availableKinds = uiState.activeKinds,
                                selectedKind = uiState.effectiveKind,
                                enabled = uiState.selectedIds.isNotEmpty(),
                                onSelectKind = viewModel::selectSingleKind,
                            )
                            QualityOptionList(
                                info = uiState.info,
                                kind = uiState.effectiveKind,
                                selectedIds = uiState.selectedIds,
                                selectedLabel = uiState.effectiveLabel,
                                enabled = uiState.selectedIds.isNotEmpty(),
                                onSelectLabel = viewModel::selectSingleLabel,
                            )
                            if (uiState.selection.fileCount > 1) {
                                PackagingSelector(
                                    packaging = uiState.packaging,
                                    onPackagingChange = viewModel::selectSinglePackaging,
                                )
                            }
                            PrimaryDownloadButton(
                                selection = uiState.selection,
                                trimSummary = TrimSummary.None,
                                subtitlesRequest = null,
                                onClick = {
                                    runWithPermissions {
                                        scope.launch {
                                            val queued = viewModel.enqueueSingleReady(uiState)
                                            if (queued) {
                                                Toast.makeText(
                                                    context,
                                                    context.getString(R.string.share_started_toast),
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                                onFinish()
                                            }
                                        }
                                    }
                                },
                            )
                        }

                        else -> Unit
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                }
            }
        }
    }
}
