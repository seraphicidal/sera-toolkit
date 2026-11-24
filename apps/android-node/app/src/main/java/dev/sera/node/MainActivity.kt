package dev.sera.node

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Terminal
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.sera.node.ui.DashboardScreen
import dev.sera.node.ui.LogsScreen
import dev.sera.node.ui.NodeViewModel
import dev.sera.node.ui.SettingsScreen
import dev.sera.node.ui.theme.LocalSeraPalette
import dev.sera.node.ui.theme.SeraNodeTheme
import dev.sera.node.ui.theme.isSeraDarkTheme

private enum class NodeTab(val label: String, val icon: ImageVector) {
    STATUS("Status", Icons.Rounded.Dashboard),
    LOGS("Logs", Icons.Rounded.Terminal),
    SETTINGS("Settings", Icons.Rounded.Settings),
}

class MainActivity : ComponentActivity() {
    private val viewModel: NodeViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val themePreference by viewModel.themePreference.collectAsStateWithLifecycle()
            val useDark = isSeraDarkTheme(themePreference)

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

            SeraNodeTheme(preference = themePreference) {
                NodeAppShell(
                    viewModel = viewModel,
                    onCopyText = { text ->
                        runCatching {
                            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("SERA Node Logs", text))
                        }.onSuccess {
                            viewModel.notifyMessage("Logs copied to clipboard")
                        }.onFailure {
                            viewModel.notifyMessage("Could not access clipboard")
                        }
                    },
                    onReadClipboard = {
                        runCatching {
                            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.primaryClip
                                ?.takeIf { it.itemCount > 0 }
                                ?.getItemAt(0)
                                ?.coerceToText(this)
                                ?.toString()
                        }.getOrNull()
                    },
                    onLaunchIntent = { primary, fallback, failureMessage ->
                        val launched = runCatching { startActivity(primary) }.isSuccess ||
                            (fallback != null && runCatching { startActivity(fallback) }.isSuccess)
                        if (!launched) {
                            viewModel.notifyMessage(failureMessage)
                        }
                    },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshPermissions()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NodeAppShell(
    viewModel: NodeViewModel,
    onCopyText: (String) -> Unit,
    onReadClipboard: () -> String?,
    onLaunchIntent: (primary: Intent, fallback: Intent?, failureMessage: String) -> Unit,
) {
    val palette = LocalSeraPalette.current
    val configuration = LocalConfiguration.current
    val useRail = configuration.screenWidthDp >= 600 ||
        configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    var selectedTabName by rememberSaveable { mutableStateOf(NodeTab.STATUS.name) }
    val currentTab = NodeTab.entries.firstOrNull { it.name == selectedTabName } ?: NodeTab.STATUS
    val snackbarHostState = remember { SnackbarHostState() }

    val notificationLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) {
        viewModel.refreshPermissions()
    }

    LaunchedEffect(viewModel) {
        viewModel.messages.collect { msg ->
            snackbarHostState.currentSnackbarData?.dismiss()
            val result = snackbarHostState.showSnackbar(
                message = msg.text,
                actionLabel = msg.actionLabel,
                duration = if (msg.actionLabel != null) SnackbarDuration.Long else SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed && msg.isUndoClearLogs) {
                viewModel.undoClearLogs()
            }
        }
    }

    val topBarContent: @Composable () -> Unit = {
        Column {
            TopAppBar(
                title = {
                    Text(
                        text = if (currentTab == NodeTab.STATUS) "SERA Node" else "SERA Node • ${currentTab.label}",
                        style = MaterialTheme.typography.titleLarge,
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

    val tabBody: @Composable (Modifier) -> Unit = { contentModifier ->
        Box(modifier = contentModifier.fillMaxSize()) {
            when (currentTab) {
                NodeTab.STATUS -> DashboardTab(
                    viewModel = viewModel,
                    onOpenSettings = { selectedTabName = NodeTab.SETTINGS.name },
                    onRequestBatteryOptimization = {
                        onLaunchIntent(
                            viewModel.batteryOptimizationIntent(),
                            viewModel.fallbackBatteryOptimizationIntent(),
                            "Unable to open battery optimization settings on this device",
                        )
                    },
                    onRequestInstallUnknownApps = {
                        onLaunchIntent(
                            viewModel.installUnknownAppsIntent(),
                            null,
                            "Unable to open Install Unknown Apps settings",
                        )
                    },
                    onRequestNotificationPermission = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    },
                    onLaunchUpdateIntent = { intent ->
                        onLaunchIntent(
                            intent,
                            null,
                            "Unable to launch app update installer",
                        )
                    },
                )

                NodeTab.LOGS -> LogsTab(
                    viewModel = viewModel,
                    onCopyLogs = onCopyText,
                )

                NodeTab.SETTINGS -> SettingsTab(
                    viewModel = viewModel,
                    onReadClipboard = onReadClipboard,
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
                NodeTab.entries.forEach { tab ->
                    NavigationRailItem(
                        selected = currentTab == tab,
                        onClick = { selectedTabName = tab.name },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
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
                tabBody(Modifier.padding(innerPadding))
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
                        NodeTab.entries.forEach { tab ->
                            NavigationBarItem(
                                selected = currentTab == tab,
                                onClick = { selectedTabName = tab.name },
                                icon = { Icon(tab.icon, contentDescription = tab.label) },
                                label = { Text(tab.label) },
                            )
                        }
                    }
                }
            },
        ) { innerPadding ->
            tabBody(Modifier.padding(innerPadding))
        }
    }
}

@Composable
private fun DashboardTab(
    viewModel: NodeViewModel,
    onOpenSettings: () -> Unit,
    onRequestBatteryOptimization: () -> Unit,
    onRequestInstallUnknownApps: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
    onLaunchUpdateIntent: (Intent) -> Unit,
) {
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val snapshot by viewModel.snapshot.collectAsStateWithLifecycle()
    val networkState by viewModel.networkState.collectAsStateWithLifecycle()
    val updateState by viewModel.updateState.collectAsStateWithLifecycle()
    val permissions by viewModel.permissions.collectAsStateWithLifecycle()

    DashboardScreen(
        settings = settings,
        snapshot = snapshot,
        networkState = networkState,
        updateState = updateState,
        permissions = permissions,
        onStartNode = viewModel::startNode,
        onStopNode = viewModel::stopNode,
        onPauseNode = viewModel::pauseNode,
        onResumeNode = viewModel::resumeNode,
        onOpenSettings = onOpenSettings,
        onRequestBatteryOptimization = onRequestBatteryOptimization,
        onRequestInstallUnknownApps = onRequestInstallUnknownApps,
        onRequestNotificationPermission = onRequestNotificationPermission,
        onCheckAllUpdates = viewModel::checkAndInstallAllUpdates,
        onForceRefreshTools = viewModel::forceRefreshTools,
        onInstallPendingUpdate = {
            updateState.pendingConfirmIntent?.let(onLaunchUpdateIntent)
        },
    )
}

@Composable
private fun LogsTab(
    viewModel: NodeViewModel,
    onCopyLogs: (String) -> Unit,
) {
    val logs by viewModel.logs.collectAsStateWithLifecycle()

    LogsScreen(
        logs = logs,
        onCopyLogs = onCopyLogs,
        onClearLogs = viewModel::clearLogsWithUndo,
    )
}

@Composable
private fun SettingsTab(
    viewModel: NodeViewModel,
    onReadClipboard: () -> String?,
) {
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val connectionTestState by viewModel.connectionTestState.collectAsStateWithLifecycle()

    SettingsScreen(
        settings = settings,
        connectionTestState = connectionTestState,
        onTestConnection = viewModel::testConnection,
        onResetConnectionTest = viewModel::resetConnectionTest,
        onThemeChange = viewModel::setThemePreference,
        onReadClipboard = onReadClipboard,
        onParseEnvAsync = viewModel::parseEnvConfigAsync,
        onImportEnv = viewModel::applyImportedEnvConfig,
        onSave = viewModel::saveConfiguration,
    )
}
