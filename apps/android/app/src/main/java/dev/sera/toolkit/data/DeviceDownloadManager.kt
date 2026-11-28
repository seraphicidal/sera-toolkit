package dev.sera.toolkit.data

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import dev.sera.toolkit.MainActivity
import dev.sera.toolkit.R
import dev.sera.toolkit.worker.DownloadActionReceiver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

data class SavedDownloadFile(
    val uri: Uri,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
    val savedToPublicDownloads: Boolean,
)

class DeviceDownloadManager(
    private val context: Context,
    httpClient: OkHttpClient = SeraApiClient.defaultHttpClient(),
) {
    private val transferClient = httpClient.newBuilder()
        .readTimeout(10, TimeUnit.MINUTES)
        .build()

    private val resumableDownloader = ResumableDownloader(transferClient)

    init {
        ensureNotificationChannels()
    }

    suspend fun downloadAndSave(
        baseUrl: String,
        downloadPath: String,
        filename: String,
        mimeType: String,
        expectedSizeBytes: Long? = null,
        onProgress: suspend (TransferProgress) -> Unit = {},
    ): SavedDownloadFile {
        val resolvedUrl = SeraApiClient.resolveApiPath(baseUrl, downloadPath)
            ?: throw IllegalArgumentException("Unsafe download path.")
        val cleanName = sanitizeFilename(filename)
        val effectiveMime = safeViewMimeType(mimeType)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(
                resolvedUrl = resolvedUrl,
                filename = cleanName,
                mimeType = effectiveMime,
                expectedSizeBytes = expectedSizeBytes,
                onProgress = onProgress,
            )
        } else {
            saveViaLegacyStorage(
                resolvedUrl = resolvedUrl,
                filename = cleanName,
                mimeType = effectiveMime,
                expectedSizeBytes = expectedSizeBytes,
                onProgress = onProgress,
            )
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private suspend fun saveViaMediaStore(
        resolvedUrl: String,
        filename: String,
        mimeType: String,
        expectedSizeBytes: Long?,
        onProgress: suspend (TransferProgress) -> Unit,
    ): SavedDownloadFile {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/SERA")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val itemUri = withContext(Dispatchers.IO) {
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } ?: throw IllegalStateException("Could not create MediaStore entry.")

        try {
            val writtenBytes = withContext(Dispatchers.IO) {
                resolver.openFileDescriptor(itemUri, "rw")
            }?.use { pfd ->
                FileOutputStream(pfd.fileDescriptor).use { fos ->
                    val sink = FileChannelSink(fos.channel)
                    val written = resumableDownloader.downloadToSink(
                        url = resolvedUrl,
                        sink = sink,
                        expectedSizeBytes = expectedSizeBytes,
                        onProgress = onProgress,
                    )
                    withContext(Dispatchers.IO) { fos.flush() }
                    written
                }
            } ?: throw IllegalStateException("Could not open MediaStore file descriptor.")

            withContext(Dispatchers.IO) {
                val finalizeValues = ContentValues().apply {
                    put(MediaStore.Downloads.IS_PENDING, 0)
                }
                resolver.update(itemUri, finalizeValues, null, null)
            }
            return SavedDownloadFile(
                uri = itemUri,
                filename = filename,
                mimeType = mimeType,
                sizeBytes = writtenBytes,
                savedToPublicDownloads = true,
            )
        } catch (t: Throwable) {
            withContext(NonCancellable + Dispatchers.IO) {
                runCatching { resolver.delete(itemUri, null, null) }
            }
            throw t
        }
    }

    private suspend fun saveViaLegacyStorage(
        resolvedUrl: String,
        filename: String,
        mimeType: String,
        expectedSizeBytes: Long?,
        onProgress: suspend (TransferProgress) -> Unit,
    ): SavedDownloadFile {
        val (targetDir, isPublic) = withContext(Dispatchers.IO) {
            val canWritePublic = hasLegacyStoragePermission(context)
            if (canWritePublic) {
                @Suppress("DEPRECATION")
                val publicDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                val seraPublic = File(publicDownloads, "SERA")
                if (seraPublic.exists() || seraPublic.mkdirs()) {
                    seraPublic to true
                } else {
                    File(context.filesDir, "SERA").apply { mkdirs() } to false
                }
            } else {
                File(context.filesDir, "SERA").apply { mkdirs() } to false
            }
        }
        val destFile = withContext(Dispatchers.IO) { uniqueFile(targetDir, filename) }
        var raf: RandomAccessFile? = null
        try {
            raf = withContext(Dispatchers.IO) { RandomAccessFile(destFile, "rw") }
            val sink = FileChannelSink(raf.channel)
            val writtenBytes = resumableDownloader.downloadToSink(
                url = resolvedUrl,
                sink = sink,
                expectedSizeBytes = expectedSizeBytes,
                onProgress = onProgress,
            )
            withContext(Dispatchers.IO) {
                raf.close()
                raf = null
            }
            MediaScannerConnection.scanFile(
                context,
                arrayOf(destFile.absolutePath),
                arrayOf(mimeType),
                null,
            )
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", destFile)
            return SavedDownloadFile(
                uri = uri,
                filename = destFile.name,
                mimeType = mimeType,
                sizeBytes = writtenBytes,
                savedToPublicDownloads = isPublic,
            )
        } catch (t: Throwable) {
            withContext(NonCancellable + Dispatchers.IO) {
                runCatching { raf?.close() }
                runCatching { if (destFile.exists()) destFile.delete() }
            }
            if (t is CancellationException) throw t
            throw t
        }
    }

    fun buildProgressNotification(
        taskId: String,
        title: String,
        statusText: String,
        percent: Int,
        indeterminate: Boolean,
    ): Notification {
        val openDownloadsIntent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_INITIAL_TAB, MainActivity.TAB_DOWNLOADS)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentPending = PendingIntent.getActivity(
            context,
            PROGRESS_NOTIFICATION_ID,
            openDownloadsIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val cancelIntent = Intent(context, DownloadActionReceiver::class.java).apply {
            action = DownloadActionReceiver.ACTION_CANCEL_DOWNLOAD
            putExtra(DownloadActionReceiver.EXTRA_TASK_ID, taskId)
        }
        val cancelPending = PendingIntent.getBroadcast(
            context,
            taskId.hashCode(),
            cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { context.getString(R.string.app_name) })
            .setContentText(statusText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setProgress(100, percent.coerceIn(0, 100), indeterminate)
            .setContentIntent(contentPending)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                context.getString(R.string.action_cancel),
                cancelPending,
            )
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun postCompletionNotification(
        taskId: String,
        title: String,
        fileCount: Int,
        uri: Uri,
        mimeType: String,
    ) {
        if (!canPostNotifications(context)) return
        val notifId = completionNotificationId(taskId)
        val safeMime = safeViewMimeType(mimeType)
        val openIntent = buildOpenIntent(context, uri, safeMime)
        val shareIntent = buildShareIntent(context, uri, safeMime)

        val openPending = PendingIntent.getActivity(
            context,
            notifId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val sharePending = PendingIntent.getActivity(
            context,
            notifId + 1,
            shareIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val message = if (fileCount > 1) {
            context.getString(R.string.notification_saved_multiple, fileCount)
        } else {
            context.getString(R.string.notification_saved_single)
        }

        val notification = NotificationCompat.Builder(context, COMPLETE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .addAction(
                android.R.drawable.ic_menu_view,
                context.getString(R.string.action_open),
                openPending,
            )
            .addAction(
                android.R.drawable.ic_menu_share,
                context.getString(R.string.action_share),
                sharePending,
            )
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notifId, notification)
        } catch (_: SecurityException) {
            Unit
        }
    }

    fun postFailureNotification(
        taskId: String,
        title: String,
        message: String,
        hint: String?,
    ) {
        if (!canPostNotifications(context)) return
        val notifId = completionNotificationId(taskId)
        val openDownloadsIntent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_INITIAL_TAB, MainActivity.TAB_DOWNLOADS)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentPending = PendingIntent.getActivity(
            context,
            notifId,
            openDownloadsIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val fullText = if (!hint.isNullOrBlank()) "$message\n$hint" else message
        val notification = NotificationCompat.Builder(context, COMPLETE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(title.ifBlank { context.getString(R.string.download_failed_title) })
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(fullText))
            .setAutoCancel(true)
            .setContentIntent(contentPending)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notifId, notification)
        } catch (_: SecurityException) {
            Unit
        }
    }

    private fun completionNotificationId(taskId: String): Int {
        return 10_000 + ((taskId.hashCode() and 0x7FFFFFFF) % 50_000)
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

    private fun ensureNotificationChannels() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val progressChannel = NotificationChannel(
            PROGRESS_CHANNEL_ID,
            context.getString(R.string.notification_channel_progress),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_progress_desc)
            setShowBadge(false)
        }
        val completeChannel = NotificationChannel(
            COMPLETE_CHANNEL_ID,
            context.getString(R.string.notification_channel_complete),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.notification_channel_complete_desc)
        }
        manager.createNotificationChannel(progressChannel)
        manager.createNotificationChannel(completeChannel)
    }

    companion object {
        const val PROGRESS_NOTIFICATION_ID = 4_001
        private const val PROGRESS_CHANNEL_ID = "sera_downloads_progress"
        private const val COMPLETE_CHANNEL_ID = "sera_downloads_complete"

        fun canPostNotifications(context: Context): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        }

        fun needsLegacyStoragePermission(context: Context): Boolean {
            return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
                !hasLegacyStoragePermission(context)
        }

        fun hasLegacyStoragePermission(context: Context): Boolean {
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ||
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE,
                ) == PackageManager.PERMISSION_GRANTED
        }

        fun sanitizeFilename(raw: String): String {
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

        fun buildOpenIntent(context: Context, uri: Uri, mimeType: String?): Intent {
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, safeViewMimeType(mimeType))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            return Intent.createChooser(viewIntent, context.getString(R.string.action_open_file)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }

        fun buildShareIntent(context: Context, uri: Uri, mimeType: String?): Intent {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType?.ifBlank { "*/*" } ?: "*/*"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(null, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            return Intent.createChooser(sendIntent, context.getString(R.string.action_share_media)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }

        fun openFile(context: Context, uri: Uri, mimeType: String?) {
            runCatching { context.startActivity(buildOpenIntent(context, uri, mimeType)) }
        }

        fun shareFile(context: Context, uri: Uri, mimeType: String?) {
            runCatching { context.startActivity(buildShareIntent(context, uri, mimeType)) }
        }
    }
}
