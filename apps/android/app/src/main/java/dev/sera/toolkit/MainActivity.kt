package dev.sera.toolkit

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.sera.toolkit.data.DeviceDownloadManager
import dev.sera.toolkit.data.DownloadTaskStatus
import dev.sera.toolkit.domain.Formatters
import dev.sera.toolkit.domain.HealthLight
import dev.sera.toolkit.domain.HealthModel
import dev.sera.toolkit.domain.HealthState
import dev.sera.toolkit.model.ServiceInfo
import dev.sera.toolkit.ui.AboutScreen
import dev.sera.toolkit.ui.DownloadsScreen
import dev.sera.toolkit.ui.HomeScreen
import dev.sera.toolkit.ui.MainViewModel
import dev.sera.toolkit.ui.SettingsScreen
import dev.sera.toolkit.ui.theme.LocalSeraPalette
import dev.sera.toolkit.ui.theme.SeraTheme
import dev.sera.toolkit.ui.theme.isSeraDarkTheme
import kotlinx.coroutines.flow.MutableStateFlow

private enum class AppDestination(
    val route: String,
    val labelRes: Int,
    val icon: ImageVector,
) {
    HOME(MainActivity.TAB_HOME, R.string.tab_home, Icons.Rounded.Home),
    DOWNLOADS(MainActivity.TAB_DOWNLOADS, R.string.tab_downloads, Icons.Rounded.Download),
    SETTINGS(MainActivity.TAB_SETTINGS, R.string.tab_settings, Icons.Rounded.Settings),
    ABOUT(MainActivity.TAB_ABOUT, R.string.tab_about, Icons.Rounded.Info),
}

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()
    private val pendingTabRoute = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        consumeIntentTab(intent)

        setContent {
            val settings by viewModel.settings.collectAsStateWithLifecycle()
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
                MainAppShell(
                    viewModel = viewModel,
                    pendingTabRoute = pendingTabRoute,
                    onReadClipboard = ::readClipboardText,
                    onOpenExternalUrl = ::openExternalUrl,
                    onOpenLocalFile = { uri, mime -> DeviceDownloadManager.openFile(this, uri, mime) },
                    onShareLocalFile = { uri, mime -> DeviceDownloadManager.shareFile(this, uri, mime) },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeIntentTab(intent)
    }

    private fun consumeIntentTab(intent: Intent?) {
        val tab = intent?.getStringExtra(EXTRA_INITIAL_TAB)
        if (!tab.isNullOrBlank()) {
            pendingTabRoute.value = tab
        }
    }

    private fun readClipboardText(): String? {
        return runCatching {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.primaryClip
                ?.takeIf { it.itemCount > 0 }
                ?.getItemAt(0)
                ?.coerceToText(this)
                ?.toString()
        }.getOrNull()
    }

    private fun openExternalUrl(rawUrl: String) {
        val parsed = runCatching { Uri.parse(rawUrl) }.getOrNull()
        val scheme = parsed?.scheme?.lowercase()
        if (parsed == null || (scheme != "http" && scheme != "https")) {
            viewModel.emitSnackbar(getString(R.string.about_open_link_failed))
            return
        }
        val viewIntent = Intent(Intent.ACTION_VIEW, parsed).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { startActivity(viewIntent) }.onFailure {
            viewModel.emitSnackbar(getString(R.string.about_open_link_failed))
        }
    }

    companion object {
        const val EXTRA_INITIAL_TAB = "extra_initial_tab"
        const val TAB_HOME = "home"
        const val TAB_DOWNLOADS = "downloads"
        const val TAB_SETTINGS = "settings"
        const val TAB_ABOUT = "about"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainAppShell(
    viewModel: MainViewModel,
    pendingTabRoute: MutableStateFlow<String?>,
    onReadClipboard: () -> String?,
    onOpenExternalUrl: (String) -> Unit,
    onOpenLocalFile: (Uri, String?) -> Unit,
    onShareLocalFile: (Uri, String?) -> Unit,
) {
    val context = LocalContext.current
    val palette = LocalSeraPalette.current
    val configuration = LocalConfiguration.current
    val useRail = configuration.screenWidthDp >= 600 ||
        configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route ?: AppDestination.HOME.route

    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val tasks by viewModel.tasks.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val healthState by viewModel.healthState.collectAsStateWithLifecycle()
    val serviceInfo by viewModel.serviceInfo.collectAsStateWithLifecycle()
    val homeState by viewModel.homeState.collectAsStateWithLifecycle()
    val connectionTestState by viewModel.connectionTestState.collectAsStateWithLifecycle()
    val updateCheckState by viewModel.updateCheckState.collectAsStateWithLifecycle()

    val activeDownloadCount = remember(tasks) {
        tasks.count { it.status == DownloadTaskStatus.RUNNING || it.status == DownloadTaskStatus.QUEUED }
    }

    val snackbarHostState = remember { SnackbarHostState() }
    var showHealthDialog by remember { mutableStateOf(false) }
    var pendingDownloadAction by remember { mutableStateOf<(() -> Unit)?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        val action = pendingDownloadAction
        pendingDownloadAction = null
        action?.invoke()
    }

    fun runWithDownloadPermissions(action: () -> Unit) {
        val needed = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !settings.notificationsPrompted &&
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
                viewModel.markNotificationsPrompted()
            }
            pendingDownloadAction = action
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    fun navigateToTab(route: String) {
        navController.navigate(route) {
            popUpTo(navController.graph.findStartDestination().id) {
                saveState = true
            }
            launchSingleTop = true
            restoreState = true
        }
    }

    val requestedTab by pendingTabRoute.collectAsStateWithLifecycle()
    LaunchedEffect(requestedTab) {
        val route = requestedTab
        if (route != null && AppDestination.entries.any { it.route == route }) {
            pendingTabRoute.value = null
            navigateToTab(route)
        }
    }

    val viewDownloadsLabel = stringResource(R.string.home_view_downloads)
    LaunchedEffect(viewModel) {
        viewModel.snackbarEvents.collect { event ->
            snackbarHostState.currentSnackbarData?.dismiss()
            val result = snackbarHostState.showSnackbar(
                message = event.message,
                actionLabel = if (event.openDownloadsAction) viewDownloadsLabel else null,
                duration = SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed && event.openDownloadsAction) {
                navigateToTab(AppDestination.DOWNLOADS.route)
            }
        }
    }

    if (showHealthDialog) {
        ServerStatusDialog(
            healthState = healthState,
            serviceInfo = serviceInfo,
            onRefresh = { viewModel.refreshServerStatus() },
            onDismiss = { showHealthDialog = false },
        )
    }

    val currentDestination = AppDestination.entries.firstOrNull { it.route == currentRoute } ?: AppDestination.HOME
    val topBarContent: @Composable () -> Unit = {
        Column {
            TopAppBar(
                title = {
                    val label = stringResource(currentDestination.labelRes)
                    Text(
                        text = if (currentDestination == AppDestination.HOME) {
                            stringResource(R.string.app_name)
                        } else {
                            label
                        },
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                actions = {
                    ServerStatusPill(
                        healthState = healthState,
                        onClick = { showHealthDialog = true },
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.ink,
                ),
            )
            HorizontalDivider(color = palette.line)
        }
    }

    val navContent: @Composable (Modifier) -> Unit = { contentModifier ->
        NavHost(
            navController = navController,
            startDestination = AppDestination.HOME.route,
            modifier = contentModifier.fillMaxSize(),
        ) {
            composable(AppDestination.HOME.route) {
                HomeScreen(
                    state = homeState,
                    serverUrl = settings.serverUrl,
                    serviceInfo = serviceInfo,
                    maxItemsPerJob = viewModel.maxItemsPerJob,
                    onUrlChange = viewModel::updateUrlInput,
                    onPasteClick = { viewModel.pasteUrl(onReadClipboard()) },
                    onAnalyzeClick = viewModel::analyzeCurrentUrl,
                    onClearClick = viewModel::clearHome,
                    onDismissError = viewModel::dismissError,
                    onSelectKind = viewModel::selectKind,
                    onSelectLabel = viewModel::selectLabel,
                    onToggleItem = viewModel::toggleItem,
                    onSelectItems = viewModel::selectItems,
                    onPackagingChange = viewModel::updatePackaging,
                    onFilenameChange = viewModel::updateFilename,
                    onToggleAdvanced = viewModel::toggleAdvanced,
                    onTrimStartChange = viewModel::updateTrimStart,
                    onTrimEndChange = viewModel::updateTrimEnd,
                    onSubtitleTrackChange = viewModel::updateSubtitleTrack,
                    onSubtitleFormatChange = viewModel::updateSubtitleFormat,
                    onSubtitlesOnlyChange = viewModel::updateSubtitlesOnly,
                    onDownloadClick = {
                        runWithDownloadPermissions { viewModel.enqueueCurrentSelection() }
                    },
                    onQueueBatchClick = {
                        runWithDownloadPermissions { viewModel.enqueueBatchUrls() }
                    },
                )
            }
            composable(AppDestination.DOWNLOADS.route) {
                DownloadsScreen(
                    tasks = tasks,
                    history = history,
                    onCancelTask = viewModel::cancelDownload,
                    onRetryTask = { taskId ->
                        runWithDownloadPermissions { viewModel.retryDownload(taskId) }
                    },
                    onRemoveFailedTask = viewModel::removeFailedTask,
                    onOpenFile = onOpenLocalFile,
                    onShareFile = onShareLocalFile,
                    onRemoveHistoryEntry = viewModel::removeHistoryEntry,
                    onClearHistory = viewModel::clearHistory,
                )
            }
            composable(AppDestination.SETTINGS.route) {
                SettingsScreen(
                    settings = settings,
                    connectionTestState = connectionTestState,
                    onSaveServerUrl = viewModel::saveServerUrl,
                    onResetServerUrl = viewModel::resetServerUrl,
                    onTestConnection = viewModel::testConnection,
                    onThemeChange = viewModel::setThemePreference,
                    onPreferredKindChange = viewModel::setPreferredKind,
                    onQuickDownloadChange = viewModel::setQuickDownload,
                    onWifiOnlyChange = viewModel::setWifiOnly,
                )
            }
            composable(AppDestination.ABOUT.route) {
                AboutScreen(
                    serverUrl = settings.serverUrl,
                    updateCheckState = updateCheckState,
                    onCheckForUpdates = viewModel::checkForUpdates,
                    onOpenExternalUrl = onOpenExternalUrl,
                )
            }
        }
    }

    if (useRail) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .background(palette.canvas),
        ) {
            NavigationRail(
                containerColor = palette.surface,
                contentColor = palette.ink,
                modifier = Modifier
                    .fillMaxHeight()
                    .windowInsetsPadding(
                        WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical + WindowInsetsSides.Start),
                    ),
            ) {
                Spacer(modifier = Modifier.weight(1f))
                AppDestination.entries.forEach { dest ->
                    NavigationRailItem(
                        selected = currentRoute == dest.route,
                        onClick = { navigateToTab(dest.route) },
                        icon = {
                            DestinationIcon(dest = dest, activeCount = activeDownloadCount)
                        },
                        label = { Text(text = stringResource(dest.labelRes)) },
                    )
                }
                Spacer(modifier = Modifier.weight(1f))
            }
            VerticalDivider(color = palette.line)
            Scaffold(
                modifier = Modifier.weight(1f),
                containerColor = palette.canvas,
                contentWindowInsets = WindowInsets.safeDrawing.only(
                    WindowInsetsSides.Vertical + WindowInsetsSides.End,
                ),
                snackbarHost = { SnackbarHost(snackbarHostState) },
                topBar = topBarContent,
            ) { innerPadding ->
                navContent(Modifier.padding(innerPadding))
            }
        }
    } else {
        Scaffold(
            containerColor = palette.canvas,
            contentWindowInsets = WindowInsets.safeDrawing,
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = topBarContent,
            bottomBar = {
                Column {
                    HorizontalDivider(color = palette.line)
                    NavigationBar(containerColor = palette.surface) {
                        AppDestination.entries.forEach { dest ->
                            NavigationBarItem(
                                selected = currentRoute == dest.route,
                                onClick = { navigateToTab(dest.route) },
                                icon = {
                                    DestinationIcon(dest = dest, activeCount = activeDownloadCount)
                                },
                                label = { Text(text = stringResource(dest.labelRes)) },
                            )
                        }
                    }
                }
            },
        ) { innerPadding ->
            navContent(Modifier.padding(innerPadding))
        }
    }
}

@Composable
private fun DestinationIcon(dest: AppDestination, activeCount: Int) {
    val label = stringResource(dest.labelRes)
    if (dest == AppDestination.DOWNLOADS && activeCount > 0) {
        BadgedBox(
            badge = {
                Badge { Text(text = activeCount.toString()) }
            },
        ) {
            Icon(imageVector = dest.icon, contentDescription = label)
        }
    } else {
        Icon(imageVector = dest.icon, contentDescription = label)
    }
}

@Composable
private fun ServerStatusPill(
    healthState: HealthState,
    onClick: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val dotColor = when (healthState.light) {
        HealthLight.GREEN -> palette.success
        HealthLight.AMBER -> palette.warning
        HealthLight.RED -> palette.danger
        HealthLight.UNKNOWN -> palette.inkFaint
    }

    Row(
        modifier = Modifier
            .padding(end = 12.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(palette.sunken)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
        Text(
            text = HealthModel.headlineHealth(healthState),
            style = MaterialTheme.typography.labelSmall,
            color = palette.inkMuted,
        )
    }
}

@Composable
private fun ServerStatusDialog(
    healthState: HealthState,
    serviceInfo: ServiceInfo?,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = LocalSeraPalette.current
    val lines = remember(healthState) { HealthModel.describeHealth(healthState) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(text = stringResource(R.string.status_dialog_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                lines.forEach { line ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(if (line.ok) palette.success else palette.danger),
                        )
                        Column {
                            Text(
                                text = line.label,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.ink,
                            )
                            Text(
                                text = line.note,
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.inkMuted,
                            )
                        }
                    }
                }

                val limits = serviceInfo?.limits
                if (limits != null) {
                    HorizontalDivider(color = palette.line)
                    Text(
                        text = stringResource(R.string.status_server_limits_heading).uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.inkFaint,
                    )
                    Text(
                        text = stringResource(
                            R.string.status_limit_file_size,
                            Formatters.formatBytes(limits.maxFilesizeBytes),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                    Text(
                        text = stringResource(
                            R.string.status_limit_duration,
                            Formatters.formatLimitDuration(limits.maxDurationSeconds),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                    Text(
                        text = stringResource(
                            R.string.status_limit_items,
                            limits.maxItemsPerJob,
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                    Text(
                        text = stringResource(
                            R.string.status_limit_retention,
                            Formatters.formatLimitDuration(limits.retentionSeconds),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.inkMuted,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(text = stringResource(R.string.action_close))
            }
        },
        dismissButton = {
            TextButton(onClick = onRefresh) {
                Text(text = stringResource(R.string.status_refresh))
            }
        },
    )
}
