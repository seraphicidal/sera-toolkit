package dev.sera.node

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.sera.node.ui.DashboardScreen
import dev.sera.node.ui.LogsScreen
import dev.sera.node.ui.NodeViewModel
import dev.sera.node.ui.SettingsScreen
import dev.sera.node.ui.theme.SeraNodeTheme
import kotlinx.coroutines.launch

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
            val settings by viewModel.settings.collectAsStateWithLifecycle()
            SeraNodeTheme(preference = settings.themePreference) {
                NodeAppShell(
                    viewModel = viewModel,
                    onCopyText = { text ->
                        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("SERA Node Logs", text))
                    },
                    onLaunchIntent = { intent ->
                        runCatching { startActivity(intent) }
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
    onLaunchIntent: (android.content.Intent) -> Unit,
) {
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val snapshot by viewModel.snapshot.collectAsStateWithLifecycle()
    val updateState by viewModel.updateState.collectAsStateWithLifecycle()
    val logs by viewModel.logs.collectAsStateWithLifecycle()
    val permissions by viewModel.permissions.collectAsStateWithLifecycle()

    var currentTab by remember { mutableStateOf(NodeTab.STATUS) }
    val snackbarHostState = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()

    val notificationLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) {
        viewModel.refreshPermissions()
    }

    LaunchedEffect(Unit) {
        viewModel.messages.collect { msg ->
            snackbarHostState.showSnackbar(msg)
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("SERA Node") },
            )
        },
        bottomBar = {
            NavigationBar {
                NodeTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = currentTab == tab,
                        onClick = { currentTab = tab },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when (currentTab) {
                NodeTab.STATUS -> DashboardScreen(
                    settings = settings,
                    snapshot = snapshot,
                    updateState = updateState,
                    permissions = permissions,
                    onStartNode = viewModel::startNode,
                    onStopNode = viewModel::stopNode,
                    onPauseNode = viewModel::pauseNode,
                    onResumeNode = viewModel::resumeNode,
                    onOpenSettings = { currentTab = NodeTab.SETTINGS },
                    onRequestBatteryOptimization = {
                        onLaunchIntent(viewModel.batteryOptimizationIntent())
                    },
                    onRequestInstallUnknownApps = {
                        onLaunchIntent(viewModel.installUnknownAppsIntent())
                    },
                    onRequestNotificationPermission = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    },
                    onCheckAllUpdates = viewModel::checkAndInstallAllUpdates,
                    onForceRefreshTools = viewModel::forceRefreshTools,
                    onInstallPendingUpdate = {
                        updateState.pendingConfirmIntent?.let(onLaunchIntent)
                    },
                )

                NodeTab.LOGS -> LogsScreen(
                    logs = logs,
                    onCopyLogs = { text ->
                        onCopyText(text)
                        coroutineScope.launch {
                            snackbarHostState.showSnackbar("Logs copied to clipboard")
                        }
                    },
                    onClearLogs = viewModel::clearLogs,
                )

                NodeTab.SETTINGS -> SettingsScreen(
                    settings = settings,
                    onSave = viewModel::saveConfiguration,
                    onImportEnv = viewModel::importEnvConfig,
                )
            }
        }
    }
}
