package dev.sera.node.updater

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import dev.sera.node.data.NodeLogStore
import dev.sera.node.data.NodeSettings
import dev.sera.node.extractor.withImmediateCancelHook
import dev.sera.node.model.AndroidAppUpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

object Sha256Verifier {
    fun normalizeExpected(raw: String): String {
        return raw.trim().removePrefix("sha256:").removePrefix("SHA256:").trim().lowercase()
    }

    fun computeHex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun computeHex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(65_536)
        FileInputStream(file).use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun matches(file: File, expectedHex: String): Boolean {
        val expected = normalizeExpected(expectedHex)
        if (!Regex("^[a-f0-9]{64}$").matches(expected)) return false
        if (!file.isFile) return false
        return computeHex(file) == expected
    }
}

object UpdateVersionComparator {
    fun isUpdateAvailable(
        currentVersionCode: Int,
        currentVersionName: String,
        candidateVersionCode: Int,
        candidateVersionName: String? = null,
    ): Boolean {
        if (candidateVersionCode > currentVersionCode) return true
        if (candidateVersionCode < currentVersionCode) return false
        if (!candidateVersionName.isNullOrBlank()) {
            return compareSemver(candidateVersionName, currentVersionName) > 0
        }
        return false
    }

    fun compareSemver(a: String, b: String): Int {
        val pa = parseParts(a)
        val pb = parseParts(b)
        val maxLen = maxOf(pa.size, pb.size)
        for (i in 0 until maxLen) {
            val va = pa.getOrElse(i) { 0 }
            val vb = pb.getOrElse(i) { 0 }
            if (va != vb) return va.compareTo(vb)
        }
        return 0
    }

    private fun parseParts(raw: String): List<Int> {
        val clean = raw.trim().removePrefix("v").substringBefore('-').substringBefore('+')
        return clean.split('.').mapNotNull { it.trim().toIntOrNull() }
    }
}

data class DownloadTarget(
    val url: String,
    val sendAuthHeader: Boolean,
)

sealed interface ApkDownloadOutcome {
    data class Verified(
        val file: File,
        val sha256: String,
        val sizeBytes: Long,
        val sourceUrl: String,
    ) : ApkDownloadOutcome

    data class Failed(
        val reason: String,
    ) : ApkDownloadOutcome
}

class AppSelfUpdater(
    baseHttpClient: OkHttpClient,
    private val logStore: NodeLogStore,
) {
    private val downloadClient: OkHttpClient = baseHttpClient.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(60, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.MINUTES)
        .build()

    fun canInstallPackages(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    fun createInstallUnknownAppsIntent(context: Context): Intent {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
            Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    suspend fun downloadAndVerifyApk(
        info: AndroidAppUpdateInfo,
        apiBaseUrl: String?,
        authToken: String?,
        updatesDir: File,
        onProgress: (Long, Long?) -> Unit = { _, _ -> },
    ): ApkDownloadOutcome = withContext(Dispatchers.IO) {
        if (info.versionCode <= 0) {
            return@withContext ApkDownloadOutcome.Failed("Invalid APK version code in manifest")
        }
        val expectedSha = Sha256Verifier.normalizeExpected(info.sha256)
        if (!Regex("^[a-f0-9]{64}$").matches(expectedSha)) {
            return@withContext ApkDownloadOutcome.Failed("Invalid APK SHA-256 in manifest")
        }
        if (!updatesDir.exists() && !updatesDir.mkdirs()) {
            return@withContext ApkDownloadOutcome.Failed("Could not create updates directory")
        }

        val finalFile = File(updatesDir, "sera-node-v${info.versionCode}.apk")
        if (finalFile.isFile && Sha256Verifier.matches(finalFile, expectedSha)) {
            logStore.info("UPDATER", "Verified cached APK ${finalFile.name}")
            return@withContext ApkDownloadOutcome.Verified(
                file = finalFile,
                sha256 = expectedSha,
                sizeBytes = finalFile.length(),
                sourceUrl = "cache",
            )
        }

        val targets = resolveDownloadTargets(
            apiBaseUrl = apiBaseUrl,
            proxyPath = info.proxyPath,
            directUrl = info.apkUrl,
        )
        if (targets.isEmpty()) {
            return@withContext ApkDownloadOutcome.Failed("No APK download URL available")
        }

        val partFile = File(updatesDir, "sera-node-v${info.versionCode}.apk.part")
        var lastError = "APK download failed"

        for (target in targets) {
            currentCoroutineContext().ensureActive()
            partFile.delete()
            var activeCall: Call? = null
            try {
                logStore.info("UPDATER", "Downloading APK update v${info.versionName} (${info.versionCode}) from ${target.url}")
                val reqBuilder = Request.Builder().url(target.url).get()
                if (target.sendAuthHeader) {
                    val safeToken = sanitizeBearerToken(authToken)
                    if (safeToken != null) {
                        reqBuilder.header("Authorization", "Bearer $safeToken")
                    }
                }
                val call = downloadClient.newCall(reqBuilder.build())
                activeCall = call
                val response = awaitCall(call)
                val verified = withImmediateCancelHook(onCancel = { call.cancel() }) {
                    withContext(Dispatchers.IO) {
                        response.use { res ->
                            if (!res.isSuccessful) {
                                lastError = "HTTP ${res.code} downloading ${target.url}"
                                logStore.warn("UPDATER", lastError)
                                return@use null
                            }
                            val body = res.body ?: run {
                                lastError = "Empty APK response body"
                                return@use null
                            }
                            val totalBytes = body.contentLength().takeIf { it > 0L }
                            var downloaded = 0L
                            val digest = MessageDigest.getInstance("SHA-256")
                            val buffer = ByteArray(65_536)

                            body.byteStream().use { input ->
                                FileOutputStream(partFile).use { output ->
                                    while (true) {
                                        currentCoroutineContext().ensureActive()
                                        val read = input.read(buffer)
                                        if (read <= 0) break
                                        output.write(buffer, 0, read)
                                        digest.update(buffer, 0, read)
                                        downloaded += read
                                        onProgress(downloaded, totalBytes)
                                    }
                                    output.fd.sync()
                                }
                            }

                            val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                            if (actualSha != expectedSha) {
                                partFile.delete()
                                lastError = "SHA-256 mismatch for APK (expected $expectedSha, got $actualSha)"
                                logStore.error("UPDATER", lastError)
                                return@use null
                            }

                            if (finalFile.exists()) finalFile.delete()
                            if (!partFile.renameTo(finalFile)) {
                                partFile.copyTo(finalFile, overwrite = true)
                                partFile.delete()
                            }
                            cleanupOldApks(updatesDir, keepName = finalFile.name)
                            logStore.info("UPDATER", "APK SHA-256 verified (${finalFile.length()} bytes)")
                            ApkDownloadOutcome.Verified(
                                file = finalFile,
                                sha256 = actualSha,
                                sizeBytes = finalFile.length(),
                                sourceUrl = target.url,
                            )
                        }
                    }
                }
                if (verified != null) {
                    return@withContext verified
                }
            } catch (cancelled: CancellationException) {
                activeCall?.cancel()
                partFile.delete()
                throw cancelled
            } catch (error: IOException) {
                partFile.delete()
                lastError = error.message ?: "Network error downloading APK"
                logStore.warn("UPDATER", "APK download attempt failed: $lastError")
            }
        }

        ApkDownloadOutcome.Failed(lastError)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun awaitCall(call: Call): Response {
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation {
                call.cancel()
            }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) {
                        cont.resumeWithException(e)
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    cont.resume(response) { _, res, _ ->
                        res.close()
                    }
                }
            })
        }
    }

    suspend fun installApkWithPackageInstaller(
        context: Context,
        apkFile: File,
        expectedVersionCode: Int,
    ): Boolean = withContext(Dispatchers.IO) {
        if (!apkFile.isFile) return@withContext false
        val appContext = context.applicationContext
        val installer = appContext.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(appContext.packageName)
            setSize(apkFile.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER)
            }
        }

        var sessionId = -1
        try {
            sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                FileInputStream(apkFile).use { input ->
                    session.openWrite("sera-node.apk", 0, apkFile.length()).use { output ->
                        val buffer = ByteArray(65_536)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            output.write(buffer, 0, read)
                        }
                        session.fsync(output)
                    }
                }

                val callbackIntent = Intent(appContext, AppUpdateResultReceiver::class.java).apply {
                    putExtra(AppUpdateResultReceiver.EXTRA_APK_PATH, apkFile.absolutePath)
                    putExtra(AppUpdateResultReceiver.EXTRA_VERSION_CODE, expectedVersionCode)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val statusIntent = PendingIntent.getBroadcast(
                    appContext,
                    expectedVersionCode,
                    callbackIntent,
                    flags,
                )
                session.commit(statusIntent.intentSender)
                logStore.info("UPDATER", "Committed PackageInstaller session $sessionId for v$expectedVersionCode")
            }
            true
        } catch (error: Exception) {
            if (sessionId != -1) {
                runCatching { installer.abandonSession(sessionId) }
            }
            logStore.error("UPDATER", "PackageInstaller session failed: ${error.message}")
            false
        }
    }

    private fun cleanupOldApks(updatesDir: File, keepName: String) {
        updatesDir.listFiles()?.forEach { child ->
            if (child.isFile && child.name != keepName &&
                (child.name.endsWith(".apk") || child.name.endsWith(".apk.part"))
            ) {
                child.delete()
            }
        }
    }

    companion object {
        private fun sanitizeBearerToken(raw: String?): String? {
            val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return trimmed.takeIf { token -> token.all { it.code in 0x21..0x7E } }
        }

        private fun isSameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
            a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                a.port == b.port

        private fun isSafeRelativeProxyPath(path: String): Boolean {
            if (!path.startsWith("/") || path.startsWith("//") || path.contains('\\')) return false
            if (path.any { it.code < 0x20 || it.code == 0x7F }) return false
            val withoutQuery = path.substringBefore('?').substringBefore('#')
            return withoutQuery.split('/').none { it == ".." }
        }

        fun resolveDownloadTargets(
            apiBaseUrl: String?,
            proxyPath: String?,
            directUrl: String?,
        ): List<DownloadTarget> {
            val targets = mutableListOf<DownloadTarget>()
            val cleanBase = apiBaseUrl?.trim()?.let { NodeSettings.normalizeBaseUrl(it) }?.ifBlank { null }
            val baseHttpUrl = cleanBase?.toHttpUrlOrNull()
            val cleanProxy = proxyPath?.trim()?.ifBlank { null }
            if (baseHttpUrl != null && cleanProxy != null) {
                val resolvedUrl: HttpUrl? = if (
                    cleanProxy.startsWith("http://", ignoreCase = true) ||
                    cleanProxy.startsWith("https://", ignoreCase = true)
                ) {
                    cleanProxy.toHttpUrlOrNull()?.takeIf { isSameOrigin(it, baseHttpUrl) }
                } else {
                    val normalizedPath = if (cleanProxy.startsWith("/")) cleanProxy else "/$cleanProxy"
                    if (isSafeRelativeProxyPath(normalizedPath)) {
                        baseHttpUrl.resolve(normalizedPath)?.takeIf { isSameOrigin(it, baseHttpUrl) }
                    } else {
                        null
                    }
                }
                if (resolvedUrl != null) {
                    targets += DownloadTarget(url = resolvedUrl.toString(), sendAuthHeader = true)
                }
            }
            val cleanDirect = directUrl?.trim()?.ifBlank { null }
            val directHttpUrl = cleanDirect?.toHttpUrlOrNull()
            if (directHttpUrl != null) {
                val allowedDirect = directHttpUrl.scheme == "https" ||
                    (directHttpUrl.scheme == "http" && baseHttpUrl != null && isSameOrigin(directHttpUrl, baseHttpUrl))
                if (allowedDirect && targets.none { it.url == directHttpUrl.toString() }) {
                    targets += DownloadTarget(url = directHttpUrl.toString(), sendAuthHeader = false)
                }
            }
            return targets
        }
    }
}
