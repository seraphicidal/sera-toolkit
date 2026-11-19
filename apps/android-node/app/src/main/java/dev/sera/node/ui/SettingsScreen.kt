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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.sera.node.data.EnvConfigParser
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.ParsedEnvConfig
import dev.sera.node.data.ThemePreference
import dev.sera.node.ui.theme.LocalSeraPalette

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    settings: NodeSettings,
    onSave: (
        apiBaseUrl: String,
        nodeToken: String,
        nodeId: String,
        enableYoutube: Boolean,
        enableInstagram: Boolean,
        instagramSessionId: String,
        youtubePlayerClients: String,
        youtubePotProviderUrl: String,
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
    onImportEnv: (String) -> ParsedEnvConfig,
) {
    val palette = LocalSeraPalette.current

    var apiBaseUrl by remember { mutableStateOf(settings.apiBaseUrl) }
    var nodeToken by remember { mutableStateOf(settings.nodeToken) }
    var nodeId by remember { mutableStateOf(settings.nodeId) }
    var enableYoutube by remember { mutableStateOf(settings.enableYoutube) }
    var enableInstagram by remember { mutableStateOf(settings.enableInstagram) }
    var instagramSessionId by remember { mutableStateOf(settings.instagramSessionId) }
    var youtubePlayerClients by remember { mutableStateOf(settings.youtubePlayerClients) }
    var youtubePotProviderUrl by remember { mutableStateOf(settings.youtubePotProviderUrl) }
    var allowCellular by remember { mutableStateOf(settings.allowCellular) }
    var allowWifi by remember { mutableStateOf(settings.allowWifi) }
    var onlyWhileCharging by remember { mutableStateOf(settings.onlyWhileCharging) }
    var autoStartOnBoot by remember { mutableStateOf(settings.autoStartOnBoot) }
    var autoUpdateApp by remember { mutableStateOf(settings.autoUpdateApp) }
    var autoUpdateTools by remember { mutableStateOf(settings.autoUpdateTools) }
    var preferredCapacity by remember { mutableIntStateOf(settings.preferredCapacity) }
    var githubReleasesRepo by remember { mutableStateOf(settings.githubReleasesRepo) }
    var themePreference by remember { mutableStateOf(settings.themePreference) }

    var showToken by remember { mutableStateOf(false) }
    var showSessionId by remember { mutableStateOf(false) }
    var showImportDialog by remember { mutableStateOf(false) }

    LaunchedEffect(settings) {
        apiBaseUrl = settings.apiBaseUrl
        nodeToken = settings.nodeToken
        nodeId = settings.nodeId
        enableYoutube = settings.enableYoutube
        enableInstagram = settings.enableInstagram
        instagramSessionId = settings.instagramSessionId
        youtubePlayerClients = settings.youtubePlayerClients
        youtubePotProviderUrl = settings.youtubePotProviderUrl
        allowCellular = settings.allowCellular
        allowWifi = settings.allowWifi
        onlyWhileCharging = settings.onlyWhileCharging
        autoStartOnBoot = settings.autoStartOnBoot
        autoUpdateApp = settings.autoUpdateApp
        autoUpdateTools = settings.autoUpdateTools
        preferredCapacity = settings.preferredCapacity
        githubReleasesRepo = settings.githubReleasesRepo
        themePreference = settings.themePreference
    }

    if (showImportDialog) {
        EnvImportDialog(
            onDismiss = { showImportDialog = false },
            onApply = { rawText ->
                val parsed = onImportEnv(rawText)
                parsed.apiBaseUrl?.let { apiBaseUrl = it }
                parsed.nodeToken?.let { nodeToken = it }
                parsed.nodeId?.let { nodeId = it }
                parsed.enableYoutube?.let { enableYoutube = it }
                parsed.enableInstagram?.let { enableInstagram = it }
                parsed.instagramSessionId?.let { instagramSessionId = it }
                parsed.youtubePlayerClients?.let { youtubePlayerClients = it }
                parsed.youtubePotProviderUrl?.let { youtubePotProviderUrl = it }
                parsed.preferredCapacity?.let { preferredCapacity = it }
                parsed.allowCellular?.let { allowCellular = it }
                parsed.allowWifi?.let { allowWifi = it }
                parsed.onlyWhileCharging?.let { onlyWhileCharging = it }
                parsed.githubReleasesRepo?.let { githubReleasesRepo = it }
                showImportDialog = false
            },
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedButton(
            onClick = { showImportDialog = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Paste .env.node.local to Auto-Fill")
        }

        SettingsSectionCard(title = "Server & Credentials") {
            OutlinedTextField(
                value = apiBaseUrl,
                onValueChange = { apiBaseUrl = it },
                label = { Text("Server URL (SERA_API_URL)") },
                placeholder = { Text("https://api.example.com") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = nodeToken,
                onValueChange = { nodeToken = it },
                label = { Text("Node Token (SERA_EXTRACTION_NODE_TOKEN)") },
                singleLine = true,
                visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showToken = !showToken }) {
                        Icon(
                            imageVector = if (showToken) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                            contentDescription = "Toggle token visibility",
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = nodeId,
                onValueChange = { nodeId = it },
                label = { Text("Node ID (SERA_NODE_ID)") },
                placeholder = { Text("android-node") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
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
            OutlinedTextField(
                value = instagramSessionId,
                onValueChange = { instagramSessionId = it },
                label = { Text("Instagram Session ID (optional)") },
                placeholder = { Text("sessionid cookie value") },
                singleLine = true,
                visualTransformation = if (showSessionId) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showSessionId = !showSessionId }) {
                        Icon(
                            imageVector = if (showSessionId) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                            contentDescription = "Toggle session id visibility",
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
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = youtubePotProviderUrl,
                onValueChange = { youtubePotProviderUrl = it },
                label = { Text("YouTube PO Token URL (optional)") },
                placeholder = { Text("http://127.0.0.1:4416") },
                singleLine = true,
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
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                text = "Theme",
                style = MaterialTheme.typography.bodyMedium,
                color = palette.inkMuted,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ThemePreference.entries.forEach { pref ->
                    FilterChip(
                        selected = themePreference == pref,
                        onClick = { themePreference = pref },
                        label = { Text(pref.label) },
                    )
                }
            }
        }

        Button(
            onClick = {
                onSave(
                    apiBaseUrl,
                    nodeToken,
                    nodeId,
                    enableYoutube,
                    enableInstagram,
                    instagramSessionId,
                    youtubePlayerClients,
                    youtubePotProviderUrl,
                    allowCellular,
                    allowWifi,
                    onlyWhileCharging,
                    autoStartOnBoot,
                    autoUpdateApp,
                    autoUpdateTools,
                    preferredCapacity,
                    githubReleasesRepo,
                    themePreference,
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Rounded.Save, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Save Settings")
        }

        Spacer(modifier = Modifier.height(16.dp))
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
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
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
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun EnvImportDialog(
    onDismiss: () -> Unit,
    onApply: (String) -> Unit,
) {
    val palette = LocalSeraPalette.current
    var rawText by remember { mutableStateOf("") }
    val preview = remember(rawText) { EnvConfigParser.parse(rawText) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Import .env.node.local") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Paste your SERA node environment file to fill Server URL, Token, Node ID, Providers, and Instagram Session ID.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.inkMuted,
                )
                OutlinedTextField(
                    value = rawText,
                    onValueChange = { rawText = it },
                    minLines = 5,
                    maxLines = 9,
                    placeholder = {
                        Text("SERA_API_URL=https://...\nSERA_EXTRACTION_NODE_TOKEN=...")
                    },
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
                onClick = { onApply(rawText) },
                enabled = preview.importedFields.isNotEmpty(),
            ) {
                Text("Import")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
    )
}
