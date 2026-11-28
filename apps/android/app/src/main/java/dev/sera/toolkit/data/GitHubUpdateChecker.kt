package dev.sera.toolkit.data

import dev.sera.toolkit.model.SeraJson
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

@Serializable
data class GitHubReleaseDto(
    @SerialName("tag_name")
    val tagName: String,
    val name: String? = null,
    @SerialName("html_url")
    val htmlUrl: String,
    val draft: Boolean = false,
    val prerelease: Boolean = false,
)

sealed interface UpdateCheckResult {
    data class UpToDate(val currentVersionName: String) : UpdateCheckResult
    data class UpdateAvailable(
        val tagName: String,
        val versionName: String,
        val versionCode: Int?,
        val htmlUrl: String,
    ) : UpdateCheckResult
    data class Error(val message: String) : UpdateCheckResult
}

class GitHubUpdateChecker(
    private val httpClient: OkHttpClient,
    private val releasesUrl: String = DEFAULT_RELEASES_URL,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    suspend fun checkForUpdates(
        currentVersionName: String,
        currentVersionCode: Int,
    ): UpdateCheckResult = withContext(ioDispatcher) {
        val request = Request.Builder()
            .url(releasesUrl)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "SERA.toolkit-Android/$currentVersionName")
            .get()
            .build()

        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            return@withContext UpdateCheckResult.Error("Could not reach GitHub to check for updates.")
        }

        response.use { res ->
            if (!res.isSuccessful) {
                return@withContext UpdateCheckResult.Error("Update check failed (HTTP ${res.code}).")
            }
            val body = res.body?.string().orEmpty()
            val releases = try {
                SeraJson.decodeFromString<List<GitHubReleaseDto>>(body)
            } catch (_: Exception) {
                return@withContext UpdateCheckResult.Error("Unexpected response from GitHub Releases.")
            }

            val latest = releases
                .asSequence()
                .filter { !it.draft && it.tagName.startsWith(ANDROID_TAG_PREFIX) }
                .mapNotNull { release ->
                    val parsed = parseTag(release.tagName) ?: return@mapNotNull null
                    val safeUrl = release.htmlUrl.takeIf {
                        it.startsWith("https://", ignoreCase = true)
                    } ?: return@mapNotNull null
                    CandidateRelease(release, parsed.first, parsed.second, safeUrl)
                }
                .maxWithOrNull(candidateComparator)
                ?: return@withContext UpdateCheckResult.UpToDate(currentVersionName)

            if (isNewer(latest.versionName, latest.versionCode, currentVersionName, currentVersionCode)) {
                UpdateCheckResult.UpdateAvailable(
                    tagName = latest.release.tagName,
                    versionName = latest.versionName,
                    versionCode = latest.versionCode,
                    htmlUrl = latest.htmlUrl,
                )
            } else {
                UpdateCheckResult.UpToDate(currentVersionName)
            }
        }
    }

    private data class CandidateRelease(
        val release: GitHubReleaseDto,
        val versionName: String,
        val versionCode: Int?,
        val htmlUrl: String,
    )

    companion object {
        const val ANDROID_TAG_PREFIX = "android-v"
        const val DEFAULT_RELEASES_URL =
            "https://api.github.com/repos/seraphicidal/sera-toolkit/releases?per_page=20"
        const val SOURCE_REPO_URL = "https://github.com/seraphicidal/sera-toolkit"

        private val candidateComparator = Comparator<CandidateRelease> { a, b ->
            val semver = compareVersions(a.versionName, b.versionName)
            if (semver != 0) {
                semver
            } else {
                (a.versionCode ?: 0).compareTo(b.versionCode ?: 0)
            }
        }

        fun parseTag(tagName: String): Pair<String, Int?>? {
            if (!tagName.startsWith(ANDROID_TAG_PREFIX)) return null
            val remainder = tagName.removePrefix(ANDROID_TAG_PREFIX).trim()
            if (remainder.isEmpty()) return null
            val plusIdx = remainder.lastIndexOf('+')
            return if (plusIdx > 0) {
                val version = remainder.substring(0, plusIdx)
                val code = remainder.substring(plusIdx + 1).toIntOrNull()
                version to code
            } else {
                remainder to null
            }
        }

        fun isNewer(
            candidateName: String,
            candidateCode: Int?,
            currentName: String,
            currentCode: Int,
        ): Boolean {
            if (candidateCode != null && candidateCode != currentCode) {
                return candidateCode > currentCode
            }
            return compareVersions(candidateName, currentName) > 0
        }

        fun compareVersions(a: String, b: String): Int {
            val aCore = a.substringBefore('-')
            val bCore = b.substringBefore('-')
            val aParts = aCore.split('.').map { it.toIntOrNull() ?: 0 }
            val bParts = bCore.split('.').map { it.toIntOrNull() ?: 0 }
            val maxLen = maxOf(aParts.size, bParts.size)
            for (i in 0 until maxLen) {
                val diff = (aParts.getOrElse(i) { 0 }).compareTo(bParts.getOrElse(i) { 0 })
                if (diff != 0) return diff
            }
            val aPre = a.contains('-')
            val bPre = b.contains('-')
            return when {
                aPre && !bPre -> -1
                !aPre && bPre -> 1
                else -> a.compareTo(b)
            }
        }
    }
}
