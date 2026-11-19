package dev.sera.toolkit.data

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import dev.sera.toolkit.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

sealed interface TransferState {
    data object Idle : TransferState
    data class Downloading(
        val percent: Int,
        val bytesRead: Long,
        val totalBytes: Long,
    ) : TransferState

    data class Saved(
        val uri: Uri,
        val filename: String,
        val mimeType: String,
        val sizeBytes: Long,
    ) : TransferState

    data class Failed(val message: String) : TransferState
}

class DeviceDownloadManager(
    private val context: Context,
    httpClient: OkHttpClient = SeraApiClient.defaultHttpClient(),
) {
    private val transferClient = httpClient.newBuilder()
        .readTimeout(10, TimeUnit.MINUTES)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _transfers = MutableStateFlow<Map<String, TransferState>>(emptyMap())
    val transfers: StateFlow<Map<String, TransferState>> = _transfers.asStateFlow()

    init {
        ensureNotificationChannel()
    }

    fun startDownload(
        key: String,
        baseUrl: String,
        downloadPath: String,
        filename: String,
        mimeType: String,
        onSaved: (suspend (Uri, String, String) -> Unit)? = null,
    ) {
        val current = _transfers.value[key]
        if (current is TransferState.Downloading) return

        val resolvedUrl = SeraApiClient.resolveApiPath(baseUrl, downloadPath)
        if (resolvedUrl == null) {
            _transfers.update { it + (key to TransferState.Failed("Unsafe download path.")) }
            return
        }

        val cleanName = sanitizeFilename(filename)
        val effectiveMime = safeViewMimeType(mimeType)

        scope.launch {
            _transfers.update { it + (key to TransferState.Downloading(0, 0L, -1L)) }
            val notifId = key.hashCode() and 0x7FFFFFFF
            postProgressNotification(notifId, cleanName, 0, indeterminate = true)

            try {
                val request = Request.Builder().url(resolvedUrl).get().build()
                transferClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        val msg = if (response.code == 404 || response.code == 410) {
                            "Download expired on server."
                        } else {
                            "Download failed (HTTP ${response.code})."
                        }
                        _transfers.update { it + (key to TransferState.Failed(msg)) }
                        postCompletionNotification(notifId, cleanName, msg, null, effectiveMime, success = false)
                        return@use
                    }

                    val body = response.body ?: run {
                        _transfers.update { it + (key to TransferState.Failed("Empty response body.")) }
                        return@use
                    }
                    val totalBytes = body.contentLength()
                    var writtenBytes = 0L
                    val savedUri = streamToDeviceStorage(cleanName, effectiveMime) { output ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            var bytesRead = 0L
                            var lastNotifyAt = 0L
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                output.write(buffer, 0, read)
                                bytesRead += read
                                val pct = if (totalBytes > 0L) {
                                    ((bytesRead.toDouble() / totalBytes.toDouble()) * 100.0)
                                        .roundToInt()
                                        .coerceIn(0, 100)
                                } else {
                                    0
                                }
                                val now = System.currentTimeMillis()
                                if (now - lastNotifyAt >= 200L || (totalBytes > 0L && bytesRead >= totalBytes)) {
                                    lastNotifyAt = now
                                    _transfers.update {
                                        it + (key to TransferState.Downloading(pct, bytesRead, totalBytes))
                                    }
                                    postProgressNotification(notifId, cleanName, pct, indeterminate = totalBytes <= 0L)
                                }
                            }
                            output.flush()
                            writtenBytes = bytesRead
                            bytesRead
                        }
                    }

                    val finalSize = if (totalBytes > 0L) totalBytes else writtenBytes
                    _transfers.update {
                        it + (key to TransferState.Saved(savedUri, cleanName, effectiveMime, finalSize))
                    }
                    postCompletionNotification(
                        notifId,
                        cleanName,
                        "Saved to Downloads/SERA",
                        savedUri,
                        effectiveMime,
                        success = true,
                    )
                    onSaved?.invoke(savedUri, cleanName, effectiveMime)
                }
            } catch (e: Exception) {
                val msg = e.message ?: "Could not save file."
                _transfers.update { it + (key to TransferState.Failed(msg)) }
                postCompletionNotification(notifId, cleanName, msg, null, effectiveMime, success = false)
            }
        }
    }

    fun clearTransfer(key: String) {
        _transfers.update { it - key }
    }

    private fun streamToDeviceStorage(
        filename: String,
        mimeType: String,
        writer: (OutputStream) -> Long,
    ): Uri {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/SERA")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Could not create MediaStore entry.")
            try {
                resolver.openOutputStream(itemUri)?.use { output ->
                    writer(output)
                } ?: throw IllegalStateException("Could not open MediaStore stream.")
                val finalizeValues = ContentValues().apply {
                    put(MediaStore.Downloads.IS_PENDING, 0)
                }
                resolver.update(itemUri, finalizeValues, null, null)
                return itemUri
            } catch (e: Exception) {
                resolver.delete(itemUri, null, null)
                throw e
            }
        }

        val targetDir = run {
            @Suppress("DEPRECATION")
            val publicDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val seraPublic = File(publicDownloads, "SERA")
            if (seraPublic.exists() || seraPublic.mkdirs()) {
                seraPublic
            } else {
                File(context.filesDir, "SERA").apply { mkdirs() }
            }
        }
        val destFile = uniqueFile(targetDir, filename)
        destFile.outputStream().use { output ->
            writer(output)
        }
        MediaScannerConnection.scanFile(context, arrayOf(destFile.absolutePath), arrayOf(mimeType), null)
        return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", destFile)
    }

    private fun uniqueFile(dir: File, filename: String): File {
        var candidate = File(dir, filename)
        if (!candidate.exists()) return candidate
        val dot = filename.lastIndexOf('.')
        val stem = if (dot > 0) filename.substring(0, dot) else filename
        val ext = if (dot > 0) filename.substring(dot) else ""
        var counter = 1
        while (candidate.exists() && counter < 1000) {
            candidate = File(dir, "$stem ($counter)$ext")
            counter++
        }
        return candidate
    }

    private fun sanitizeFilename(raw: String): String {
        val cleaned = raw
            .trim()
            .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), "_")
            .trimStart('.')
            .trimEnd('.', ' ')
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") {
            return "sera-download"
        }
        if (cleaned.length <= 180) return cleaned
        val dot = cleaned.lastIndexOf('.')
        if (dot in 1 until cleaned.length - 1) {
            val ext = cleaned.substring(dot).take(16)
            val stem = cleaned.substring(0, dot).take(180 - ext.length).ifEmpty { "sera-download" }
            return "$stem$ext"
        }
        return cleaned.take(180)
    }

    private fun ensureNotificationChannel() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Downloads",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "SERA.toolkit file download progress"
        }
        manager.createNotificationChannel(channel)
    }

    private fun canPostNotifications(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    private fun postProgressNotification(
        id: Int,
        title: String,
        percent: Int,
        indeterminate: Boolean,
    ) {
        if (!canPostNotifications()) return
        val launchIntent = Intent(context, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            context,
            id,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(if (indeterminate) "Downloading…" else "$percent%")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, indeterminate)
            .setContentIntent(pending)
            .build()
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    private fun postCompletionNotification(
        id: Int,
        title: String,
        message: String,
        uri: Uri?,
        mimeType: String,
        success: Boolean,
    ) {
        if (!canPostNotifications()) return
        val targetIntent = if (success && uri != null) {
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, safeViewMimeType(mimeType))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            Intent.createChooser(viewIntent, "Open file").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            Intent(context, MainActivity::class.java)
        }
        val pending = PendingIntent.getActivity(
            context,
            id,
            targetIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(
                if (success) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error,
            )
            .setContentTitle(title)
            .setContentText(message)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    companion object {
        private const val CHANNEL_ID = "sera_downloads"

        fun safeViewMimeType(rawMime: String?): String {
            val normalized = rawMime?.substringBefore(';')?.trim()?.lowercase().orEmpty()
            return when {
                normalized.startsWith("video/") -> normalized
                normalized.startsWith("audio/") -> normalized
                normalized.startsWith("image/") && normalized != "image/svg+xml" -> normalized
                normalized == "application/zip" ||
                    normalized == "application/pdf" ||
                    normalized == "text/plain" -> normalized
                else -> "application/octet-stream"
            }
        }

        fun openFile(context: Context, uri: Uri, mimeType: String?) {
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, safeViewMimeType(mimeType))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val chooser = Intent.createChooser(viewIntent, "Open file")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(chooser) }
        }

        fun shareFile(context: Context, uri: Uri, mimeType: String?) {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType?.ifBlank { "*/*" } ?: "*/*"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(sendIntent, "Share media")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(chooser) }
        }
    }
}
