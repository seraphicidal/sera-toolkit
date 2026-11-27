package dev.sera.node.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.NetworkCheck
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.ParsedEnvConfig
import dev.sera.node.data.ThemePreference
import dev.sera.node.model.NodeRole
import dev.sera.node.ui.theme.LocalSeraPalette
import kotlinx.coroutines.delay
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val GITHUB_REPO_PATTERN = Regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")

@Immutable
internal data class EditableSettingsSnapshot(
    val apiBaseUrl: String,
    val nodeToken: String,
    val nodeId: String,
    val nodeRole: NodeRole,
    val enableYoutube: Boolean,
    val enableInstagram: Boolean,
    val enableAllProviders: Boolean,
    val instagramSessionId: String,
    val youtubePlayerClients: String,
    val youtubePotProviderUrl: String,
    val redditClientId: String,
    val redditClientSecret: String,
    val allowCellular: Boolean,
    val allowWifi: Boolean,
    val onlyWhileCharging: Boolean,
    val autoStartOnBoot: Boolean,
    val autoUpdateApp: Boolean,
    val autoUpdateTools: Boolean,
    val preferredCapacity: Int,
    val githubReleasesRepo: String,
    val themePreference: ThemePreference,
) {
    fun normalized(): EditableSettingsSnapshot = copy(
        apiBaseUrl = NodeSettings.normalizeBaseUrl(apiBaseUrl),
        nodeToken = nodeToken.trim(),
        nodeId = nodeId.trim().ifEmpty { "android-node" }.take(64),
        instagramSessionId = instagramSessionId.trim(),
        youtubePlayerClients = youtubePlayerClients.trim(),
        youtubePotProviderUrl = NodeSettings.normalizePotProviderUrl(youtubePotProviderUrl),
        redditClientId = redditClientId.trim(),
        redditClientSecret = redditClientSecret.trim(),
        preferredCapacity = preferredCapacity.coerceIn(1, 8),
        githubReleasesRepo = githubReleasesRepo.trim().ifEmpty { NodeSettings.DEFAULT_GITHUB_REPO },
    )

    companion object {
        fun from(settings: NodeSettings): EditableSettingsSnapshot = EditableSettingsSnapshot(
            apiBaseUrl = settings.apiBaseUrl,
            nodeToken = settings.nodeToken,
            nodeId = settings.nodeId,
            nodeRole = settings.nodeRole,
            enableYoutube = settings.enableYoutube,
            enableInstagram = settings.enableInstagram,
            enableAllProviders = settings.enableAllProviders,
            instagramSessionId = settings.instagramSessionId,
            youtubePlayerClients = settings.youtubePlayerClients,
            youtubePotProviderUrl = settings.youtubePotProviderUrl,
            redditClientId = settings.redditClientId,
            redditClientSecret = settings.redditClientSecret,
            allowCellular = settings.allowCellular,
            allowWifi = settings.allowWifi,
            onlyWhileCharging = settings.onlyWhileCharging,
            autoStartOnBoot = settings.autoStartOnBoot,
            autoUpdateApp = settings.autoUpdateApp,
            autoUpdateTools = settings.autoUpdateTools,
            preferredCapacity = settings.preferredCapacity,
            githubReleasesRepo = settings.githubReleasesRepo,
            themePreference = settings.themePreference,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    settings: NodeSettings,
    connectionTestState: ConnectionTestUiState,
    onTestConnection: (apiBaseUrl: String, nodeToken: String, nodeId: String) -> Unit,
    onResetConnectionTest: () -> Unit,
    onThemeChange: (ThemePreference) -> Unit,
    onReadClipboard: () -> String?,
    onParseEnvAsync: suspend (String) -> ParsedEnvConfig,
    onImportEnv: (ParsedEnvConfig) -> Unit,
    onSave: (
        apiBaseUrl: String,
        nodeToken: String,
        nodeId: String,
        nodeRole: NodeRole,
        enableYoutube: Boolean,
        enableInstagram: Boolean,
        enableAllProviders: Boolean,
        instagramSessionId: String,
        youtubePlayerClients: String,
        youtubePotProviderUrl: String,
        redditClientId: String,
        redditClientSecret: String,
        allowCellular: Boolean,
        allowWifi: Boolean,
        onlyWhileCharging: Boolean,
        autoStartOnBoot: Boolean,
        autoUpdateApp: Boolean,
        autoUpdateTools: Boolean,
        preferredCapacity: Int,
        githubReleasesRepo: String,
        themePreference: ThemePreference,
    ) -> Unit,
) {
    val palette = LocalSeraPalette.current
    val persistedSnapshot = remember(
        settings.apiBaseUrl,
        settings.nodeToken,
        settings.nodeId,
        settings.nodeRole,
        settings.enableYoutube,
        settings.enableInstagram,
        settings.enableAllProviders,
        settings.instagramSessionId,
        settings.youtubePlayerClients,
        settings.youtubePotProviderUrl,
        settings.redditClientId,
        settings.redditClientSecret,
        settings.allowCellular,
        settings.allowWifi,
        settings.onlyWhileCharging,
        settings.autoStartOnBoot,
        settings.autoUpdateApp,
        settings.autoUpdateTools,
        settings.preferredCapacity,
        settings.githubReleasesRepo,
        settings.themePreference,
    ) {
        EditableSettingsSnapshot.from(settings)
    }

    var apiBaseUrl by rememberSaveable { mutableStateOf(persistedSnapshot.apiBaseUrl) }
    var nodeToken by rememberSaveable { mutableStateOf(persistedSnapshot.nodeToken) }
    var nodeId by rememberSaveable { mutableStateOf(persistedSnapshot.nodeId) }
    var nodeRoleName by rememberSaveable { mutableStateOf(persistedSnapshot.nodeRole.name) }
    val nodeRole = NodeRole.entries.firstOrNull { it.name == nodeRoleName }
        ?: NodeRole.BACKUP
    var enableYoutube by rememberSaveable { mutableStateOf(persistedSnapshot.enableYoutube) }
    var enableInstagram by rememberSaveable { mutableStateOf(persistedSnapshot.enableInstagram) }
    var enableAllProviders by rememberSaveable { mutableStateOf(persistedSnapshot.enableAllProviders) }
    var instagramSessionId by rememberSaveable { mutableStateOf(persistedSnapshot.instagramSessionId) }
    var youtubePlayerClients by rememberSaveable { mutableStateOf(persistedSnapshot.youtubePlayerClients) }
    var youtubePotProviderUrl by rememberSaveable { mutableStateOf(persistedSnapshot.youtubePotProviderUrl) }
    var redditClientId by rememberSaveable { mutableStateOf(persistedSnapshot.redditClientId) }
    var redditClientSecret by rememberSaveable { mutableStateOf(persistedSnapshot.redditClientSecret) }
    var allowCellular by rememberSaveable { mutableStateOf(persistedSnapshot.allowCellular) }
    var allowWifi by rememberSaveable { mutableStateOf(persistedSnapshot.allowWifi) }
    var onlyWhileCharging by rememberSaveable { mutableStateOf(persistedSnapshot.onlyWhileCharging) }
    var autoStartOnBoot by rememberSaveable { mutableStateOf(persistedSnapshot.autoStartOnBoot) }
    var autoUpdateApp by rememberSaveable { mutableStateOf(persistedSnapshot.autoUpdateApp) }
    var autoUpdateTools by rememberSaveable { mutableStateOf(persistedSnapshot.autoUpdateTools) }
    var preferredCapacity by rememberSaveable { mutableIntStateOf(persistedSnapshot.preferredCapacity) }
    var githubReleasesRepo by rememberSaveable { mutableStateOf(persistedSnapshot.githubReleasesRepo) }
    var themePreferenceName by rememberSaveable { mutableStateOf(persistedSnapshot.themePreference.name) }
    val themePreference = ThemePreference.entries.firstOrNull { it.name == themePreferenceName }
        ?: ThemePreference.SYSTEM

    var showToken by rememberSaveable { mutableStateOf(false) }
    var showSessionId by rememberSaveable { mutableStateOf(false) }
    var showRedditSecret by rememberSaveable { mutableStateOf(false) }
    var showImportDialog by rememberSaveable { mutableStateOf(false) }

    var hasInitialized by rememberSaveable { mutableStateOf(false) }
    var syncedBaseline by remember { mutableStateOf(persistedSnapshot) }
    var pendingSaveSync by remember { mutableStateOf(false) }

    val currentDraft = EditableSettingsSnapshot(
        apiBaseUrl = apiBaseUrl,
        nodeToken = nodeToken,
        nodeId = nodeId,
        nodeRole = nodeRole,
        enableYoutube = enableYoutube,
        enableInstagram = enableInstagram,
        enableAllProviders = enableAllProviders,
        instagramSessionId = instagramSessionId,
        youtubePlayerClients = youtubePlayerClients,
        youtubePotProviderUrl = youtubePotProviderUrl,
        redditClientId = redditClientId,
        redditClientSecret = redditClientSecret,
        allowCellular = allowCellular,
        allowWifi = allowWifi,
        onlyWhileCharging = onlyWhileCharging,
        autoStartOnBoot = autoStartOnBoot,
        autoUpdateApp = autoUpdateApp,
        autoUpdateTools = autoUpdateTools,
        preferredCapacity = preferredCapacity,
        githubReleasesRepo = githubReleasesRepo,
        themePreference = themePreference,
    )

    fun applySnapshotToForm(target: EditableSettingsSnapshot) {
        apiBaseUrl = target.apiBaseUrl
        nodeToken = target.nodeToken
        nodeId = target.nodeId
        nodeRoleName = target.nodeRole.name
        enableYoutube = target.enableYoutube
        enableInstagram = target.enableInstagram
        enableAllProviders = target.enableAllProviders
        instagramSessionId = target.instagramSessionId
        youtubePlayerClients = target.youtubePlayerClients
        youtubePotProviderUrl = target.youtubePotProviderUrl
        redditClientId = target.redditClientId
        redditClientSecret = target.redditClientSecret
        allowCellular = target.allowCellular
        allowWifi = target.allowWifi
        onlyWhileCharging = target.onlyWhileCharging
        autoStartOnBoot = target.autoStartOnBoot
        autoUpdateApp = target.autoUpdateApp
        autoUpdateTools = target.autoUpdateTools
        preferredCapacity = target.preferredCapacity
        githubReleasesRepo = target.githubReleasesRepo
        themePreferenceName = target.themePreference.name
    }

    LaunchedEffect(persistedSnapshot) {
        val wasClean = currentDraft == syncedBaseline
        if (!hasInitialized || wasClean || pendingSaveSync) {
            applySnapshotToForm(persistedSnapshot)
            hasInitialized = true
            pendingSaveSync = false
        }
        syncedBaseline = persistedSnapshot
    }

    val isDirty = currentDraft != persistedSnapshot

    val apiBaseUrlError = remember(apiBaseUrl) {
        val trimmed = apiBaseUrl.trim()
        when {
            trimmed.isEmpty() -> null
            trimmed.any { it.isWhitespace() || it.isISOControl() } -> "Server URL cannot contain spaces"
            NodeSettings.normalizeBaseUrl(trimmed).toHttpUrlOrNull() == null -> "Enter a valid http:// or https:// URL"
            else -> null
        }
    }
    val nodeTokenError = remember(nodeToken) {
        val trimmed = nodeToken.trim()
        if (trimmed.any { it.isWhitespace() || it.isISOControl() }) {
            "Token cannot contain spaces or line breaks"
        } else {
            null
        }
    }
    val nodeIdError = remember(nodeId) {
        if (nodeId.trim().length > 64) "Node ID must be 64 characters or fewer" else null
    }
    val potProviderUrlError = remember(youtubePotProviderUrl) {
        val trimmed = youtubePotProviderUrl.trim()
        when {
            trimmed.isEmpty() -> null
            trimmed.any { it.isWhitespace() || it.isISOControl() } -> "PO Token URL cannot contain spaces"
            !isValidHttpUrl(trimmed) -> "Enter a valid http:// or https:// URL"
            else -> null
        }
    }
    val githubRepoError = remember(githubReleasesRepo) {
        val trimmed = githubReleasesRepo.trim()
        if (trimmed.isNotEmpty() && !GITHUB_REPO_PATTERN.matches(trimmed)) {
            "Use owner/repo format (e.g. seraphicidal/sera-toolkit)"
        } else {
            null
        }
    }
    val noProvidersEnabled = !enableYoutube && !enableInstagram && !enableAllProviders
    val noNetworkEnabled = !allowWifi && !allowCellular
    val hasBlockingErrors = apiBaseUrlError != null ||
        nodeTokenError != null ||
        nodeIdError != null ||
        potProviderUrlError != null ||
        githubRepoError != null

    if (showImportDialog) {
        EnvImportDialog(
            onDismiss = { showImportDialog = false },
            onReadClipboard = onReadClipboard,
            onParseEnvAsync = onParseEnvAsync,
            onApply = { parsed ->
                onImportEnv(parsed)
                parsed.apiBaseUrl?.let { apiBaseUrl = it }
                parsed.nodeToken?.let { nodeToken = it }
                parsed.nodeId?.let { nodeId = it }
                parsed.nodeRole?.let { nodeRoleName = it.name }
                parsed.enableYoutube?.let { enableYoutube = it }
                parsed.enableInstagram?.let { enableInstagram = it }
                parsed.enableAllProviders?.let { enableAllProviders = it }
                parsed.instagramSessionId?.let { instagramSessionId = it }
                parsed.youtubePlayerClients?.let { youtubePlayerClients = it }
                parsed.youtubePotProviderUrl?.let { youtubePotProviderUrl = it }
                parsed.redditClientId?.let { redditClientId = it }
                parsed.redditClientSecret?.let { redditClientSecret = it }
                parsed.preferredCapacity?.let { preferredCapacity = it }
                parsed.allowCellular?.let { allowCellular = it }
                parsed.allowWifi?.let { allowWifi = it }
                parsed.onlyWhileCharging?.let { onlyWhileCharging = it }
                parsed.githubReleasesRepo?.let { githubReleasesRepo = it }
                pendingSaveSync = parsed.importedFields.isNotEmpty()
                onResetConnectionTest()
                showImportDialog = false
            },
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = { showImportDialog = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) {
                Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("Paste .env.node.local to Auto-Fill")
            }

            SettingsSectionCard(title = "Server & Credentials") {
                OutlinedTextField(
                    value = apiBaseUrl,
                    onValueChange = {
                        apiBaseUrl = it
                        onResetConnectionTest()
                    },
                    label = { Text("Server URL (SERA_API_URL)") },
                    placeholder = { Text("https://api.example.com") },
                    singleLine = true,
                    isError = apiBaseUrlError != null,
                    supportingText = apiBaseUrlError?.let { err -> { Text(err) } },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value = nodeToken,
                    onValueChange = {
                        nodeToken = it
                        onResetConnectionTest()
                    },
                    label = { Text("Node Token (SERA_EXTRACTION_NODE_TOKEN)") },
                    singleLine = true,
                    isError = nodeTokenError != null,
                    supportingText = nodeTokenError?.let { err -> { Text(err) } },
                    visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    trailingIcon = {
                        IconButton(onClick = { showToken = !showToken }) {
                            Icon(
                                imageVector = if (showToken) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showToken) "Hide node token" else "Show node token",
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value = nodeId,
                    onValueChange = {
                        nodeId = it
                        onResetConnectionTest()
                    },
                    label = { Text("Node ID (SERA_NODE_ID)") },
                    placeholder = { Text("android-node") },
                    singleLine = true,
                    isError = nodeIdError != null,
                    supportingText = nodeIdError?.let { err -> { Text(err) } },
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                FilledTonalButton(
                    onClick = { onTestConnection(apiBaseUrl, nodeToken, nodeId) },
                    enabled = apiBaseUrl.isNotBlank() &&
                        nodeToken.isNotBlank() &&
                        apiBaseUrlError == null &&
                        nodeTokenError == null &&
                        connectionTestState !is ConnectionTestUiState.Testing,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    if (connectionTestState is ConnectionTestUiState.Testing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Testing Connection...")
                    } else {
                        Icon(Icons.Rounded.NetworkCheck, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Test Connection")
                    }
                }

                ConnectionTestBanner(state = connectionTestState)

                Text(
                    text = "Node Role (SERA_EXTRACTION_NODE_ROLE)",
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    NodeRole.entries.forEach { candidate ->
                        val chipLabel = if (candidate == NodeRole.BACKUP) {
                            "${candidate.label} (Default)"
                        } else {
                            candidate.label
                        }
                        FilterChip(
                            selected = nodeRole == candidate,
                            onClick = { nodeRoleName = candidate.name },
                            label = { Text(chipLabel) },
                        )
                    }
                }
                Text(
                    text = if (nodeRole == NodeRole.BACKUP) {
                        "Recommended for phones. Stays on standby and handles tasks when your PC primary node is offline or unavailable."
                    } else {
                        "Claims tasks immediately alongside any other primary nodes."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )

                Text(
                    text = "Concurrent Task Capacity",
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(1, 2, 3, 4, 6, 8).forEach { cap ->
                        FilterChip(
                            selected = preferredCapacity == cap,
                            onClick = { preferredCapacity = cap },
                            label = { Text(cap.toString()) },
                        )
                    }
                }
            }

            SettingsSectionCard(title = "Providers") {
                ToggleRow(
                    title = "YouTube",
                    subtitle = "Serve YouTube resolve and download tasks",
                    checked = enableYoutube,
                    onCheckedChange = { enableYoutube = it },
                )
                ToggleRow(
                    title = "Instagram",
                    subtitle = "Serve Reels, videos, posts, and carousels",
                    checked = enableInstagram,
                    onCheckedChange = { enableInstagram = it },
                )
                ToggleRow(
                    title = "All Other Websites & Providers",
                    subtitle = "Serve TikTok, X, Reddit, Twitch, SoundCloud, Vimeo, cloud links, and 1,000+ yt-dlp sites",
                    checked = enableAllProviders,
                    onCheckedChange = { enableAllProviders = it },
                )
                if (noProvidersEnabled) {
                    InlineWarningCallout("Enable at least one provider so this node can accept tasks.")
                }
                OutlinedTextField(
                    value = instagramSessionId,
                    onValueChange = { instagramSessionId = it },
                    label = { Text("Instagram Session ID (optional)") },
                    placeholder = { Text("sessionid cookie value") },
                    singleLine = true,
                    visualTransformation = if (showSessionId) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    trailingIcon = {
                        IconButton(onClick = { showSessionId = !showSessionId }) {
                            Icon(
                                imageVector = if (showSessionId) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showSessionId) {
                                    "Hide Instagram session ID"
                                } else {
                                    "Show Instagram session ID"
                                },
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = youtubePlayerClients,
                    onValueChange = { youtubePlayerClients = it },
                    label = { Text("YouTube Player Clients (optional)") },
                    placeholder = { Text("web_safari,android") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = youtubePotProviderUrl,
                    onValueChange = { youtubePotProviderUrl = it },
                    label = { Text("YouTube PO Token URL (optional)") },
                    placeholder = { Text("http://127.0.0.1:4416") },
                    singleLine = true,
                    isError = potProviderUrlError != null,
                    supportingText = potProviderUrlError?.let { err -> { Text(err) } },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = redditClientId,
                    onValueChange = { redditClientId = it },
                    label = { Text("Reddit Client ID (optional)") },
                    placeholder = { Text("SERA_REDDIT_CLIENT_ID") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = redditClientSecret,
                    onValueChange = { redditClientSecret = it },
                    label = { Text("Reddit Client Secret (optional)") },
                    placeholder = { Text("SERA_REDDIT_CLIENT_SECRET") },
                    singleLine = true,
                    visualTransformation = if (showRedditSecret) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                    trailingIcon = {
                        IconButton(onClick = { showRedditSecret = !showRedditSecret }) {
                            Icon(
                                imageVector = if (showRedditSecret) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showRedditSecret) {
                                    "Hide Reddit client secret"
                                } else {
                                    "Show Reddit client secret"
                                },
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            SettingsSectionCard(title = "Network & Power") {
                ToggleRow(
                    title = "Mobile Data (Cellular)",
                    subtitle = "Allow claiming and uploading tasks over 5G/LTE",
                    checked = allowCellular,
                    onCheckedChange = { allowCellular = it },
                )
                ToggleRow(
                    title = "Wi-Fi",
                    subtitle = "Allow claiming and uploading tasks over Wi-Fi",
                    checked = allowWifi,
                    onCheckedChange = { allowWifi = it },
                )
                if (noNetworkEnabled) {
                    InlineWarningCallout("Enable Wi-Fi or Mobile Data so this node can connect.")
                }
                ToggleRow(
                    title = "Only While Charging",
                    subtitle = "Pause extraction tasks when unplugged from power",
                    checked = onlyWhileCharging,
                    onCheckedChange = { onlyWhileCharging = it },
                )
                ToggleRow(
                    title = "Auto-Start on Boot",
                    subtitle = "Automatically restart node after reboot or self-update",
                    checked = autoStartOnBoot,
                    onCheckedChange = { autoStartOnBoot = it },
                )
            }

            SettingsSectionCard(title = "Auto-Updates & Appearance") {
                ToggleRow(
                    title = "Auto-Update yt-dlp & EJS",
                    subtitle = "Silently verify SHA-256 and refresh extractor tools",
                    checked = autoUpdateTools,
                    onCheckedChange = { autoUpdateTools = it },
                )
                ToggleRow(
                    title = "Auto-Update App (APK)",
                    subtitle = "Download SHA-256 verified APK updates in the background",
                    checked = autoUpdateApp,
                    onCheckedChange = { autoUpdateApp = it },
                )
                OutlinedTextField(
                    value = githubReleasesRepo,
                    onValueChange = { githubReleasesRepo = it },
                    label = { Text("GitHub Releases Fallback Repo") },
                    placeholder = { Text("seraphicidal/sera-toolkit") },
                    singleLine = true,
                    isError = githubRepoError != null,
                    supportingText = githubRepoError?.let { err -> { Text(err) } },
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = "Theme (applies immediately)",
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ThemePreference.entries.forEach { pref ->
                        FilterChip(
                            selected = themePreference == pref,
                            onClick = {
                                themePreferenceName = pref.name
                                syncedBaseline = syncedBaseline.copy(themePreference = pref)
                                onThemeChange(pref)
                            },
                            label = { Text(pref.label) },
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
        }

        HorizontalDivider(color = palette.line)
        Surface(
            color = palette.surface,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (isDirty) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = if (hasBlockingErrors) {
                                "Fix highlighted fields before saving"
                            } else {
                                "Unsaved changes"
                            },
                            style = MaterialTheme.typography.labelMedium,
                            color = if (hasBlockingErrors) palette.danger else palette.warning,
                            fontWeight = FontWeight.SemiBold,
                        )
                        TextButton(
                            onClick = {
                                applySnapshotToForm(persistedSnapshot)
                                syncedBaseline = persistedSnapshot
                                onResetConnectionTest()
                            },
                        ) {
                            Text("Discard")
                        }
                    }
                }
                Button(
                    onClick = {
                        val normalizedDraft = currentDraft.normalized()
                        applySnapshotToForm(normalizedDraft)
                        syncedBaseline = normalizedDraft
                        pendingSaveSync = normalizedDraft != persistedSnapshot
                        onSave(
                            normalizedDraft.apiBaseUrl,
                            normalizedDraft.nodeToken,
                            normalizedDraft.nodeId,
                            normalizedDraft.nodeRole,
                            normalizedDraft.enableYoutube,
                            normalizedDraft.enableInstagram,
                            normalizedDraft.enableAllProviders,
                            normalizedDraft.instagramSessionId,
                            normalizedDraft.youtubePlayerClients,
                            normalizedDraft.youtubePotProviderUrl,
                            normalizedDraft.redditClientId,
                            normalizedDraft.redditClientSecret,
                            normalizedDraft.allowCellular,
                            normalizedDraft.allowWifi,
                            normalizedDraft.onlyWhileCharging,
                            normalizedDraft.autoStartOnBoot,
                            normalizedDraft.autoUpdateApp,
                            normalizedDraft.autoUpdateTools,
                            normalizedDraft.preferredCapacity,
                            normalizedDraft.githubReleasesRepo,
                            normalizedDraft.themePreference,
                        )
                    },
                    enabled = !hasBlockingErrors,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    Icon(Icons.Rounded.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(if (isDirty) "Save Changes" else "Save Settings")
                }
            }
        }
    }
}

@Composable
private fun ConnectionTestBanner(state: ConnectionTestUiState) {
    val palette = LocalSeraPalette.current
    when (state) {
        ConnectionTestUiState.Idle,
        ConnectionTestUiState.Testing,
        -> Unit

        is ConnectionTestUiState.Success -> {
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = palette.successWash,
                border = BorderStroke(1.dp, palette.success.copy(alpha = 0.35f)),
                modifier = Modifier.semantics(mergeDescendants = true) {
                    liveRegion = LiveRegionMode.Polite
                },
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Rounded.CheckCircle,
                        contentDescription = "Connection verified",
                        tint = palette.success,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        text = state.message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.success,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        is ConnectionTestUiState.Error -> {
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = palette.dangerWash,
                border = BorderStroke(1.dp, palette.danger.copy(alpha = 0.35f)),
                modifier = Modifier.semantics(mergeDescendants = true) {
                    liveRegion = LiveRegionMode.Polite
                },
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Rounded.ErrorOutline,
                        contentDescription = "Connection test failed",
                        tint = palette.danger,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        text = state.message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.danger,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun InlineWarningCallout(message: String) {
    val palette = LocalSeraPalette.current
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = palette.warningWash,
        border = BorderStroke(1.dp, palette.warning.copy(alpha = 0.35f)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Rounded.Warning,
                contentDescription = "Warning",
                tint = palette.warning,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.warning,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun SettingsSectionCard(
    title: String,
    content: @Composable () -> Unit,
) {
    val palette = LocalSeraPalette.current
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = BorderStroke(1.dp, palette.line),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = palette.ink,
            )
            content()
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val palette = LocalSeraPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(10.dp))
            .toggleable(
                value = checked,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(end = 12.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                color = palette.ink,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = null,
        )
    }
}

@Composable
private fun EnvImportDialog(
    onDismiss: () -> Unit,
    onReadClipboard: () -> String?,
    onParseEnvAsync: suspend (String) -> ParsedEnvConfig,
    onApply: (ParsedEnvConfig) -> Unit,
) {
    val palette = LocalSeraPalette.current
    var rawText by rememberSaveable { mutableStateOf("") }
    var preview by remember { mutableStateOf(ParsedEnvConfig()) }
    var parsedForText by remember { mutableStateOf("") }
    var clipboardEmptyNotice by remember { mutableStateOf(false) }

    LaunchedEffect(rawText) {
        if (rawText.isBlank()) {
            preview = ParsedEnvConfig()
            parsedForText = ""
            return@LaunchedEffect
        }
        delay(120L)
        preview = onParseEnvAsync(rawText)
        parsedForText = rawText
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Import .env.node.local") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Paste your SERA node environment file to auto-fill Server URL, Token, Node ID, Node Role, Providers, YouTube/Instagram/Reddit credentials, Capacity, Network/Power policies, and GitHub Repo.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                FilledTonalButton(
                    onClick = {
                        val pasted = onReadClipboard()
                        if (!pasted.isNullOrBlank()) {
                            rawText = pasted
                            clipboardEmptyNotice = false
                        } else {
                            clipboardEmptyNotice = true
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Paste from Clipboard")
                }
                if (clipboardEmptyNotice) {
                    Text(
                        text = "Clipboard is empty or has no text.",
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.warning,
                    )
                }
                OutlinedTextField(
                    value = rawText,
                    onValueChange = {
                        rawText = it
                        clipboardEmptyNotice = false
                    },
                    minLines = 5,
                    maxLines = 9,
                    placeholder = {
                        Text("SERA_API_URL=https://...\nSERA_EXTRACTION_NODE_TOKEN=...")
                    },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (preview.importedFields.isNotEmpty()) {
                    Text(
                        text = "Detected: ${preview.importedFields.joinToString(", ")}",
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.success,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onApply(preview) },
                enabled = preview.importedFields.isNotEmpty() && parsedForText == rawText,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text("Import")
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text("Cancel")
            }
        },
    )
}

private fun isValidHttpUrl(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    val candidate = if (
        trimmed.startsWith("http://", ignoreCase = true) ||
        trimmed.startsWith("https://", ignoreCase = true)
    ) {
        trimmed
    } else {
        "http://$trimmed"
    }
    return candidate.toHttpUrlOrNull() != null
}
