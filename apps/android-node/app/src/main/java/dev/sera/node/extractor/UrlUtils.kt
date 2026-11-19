package dev.sera.node.extractor

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.math.BigInteger
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class ParsedUrl(
    val url: HttpUrl,
    val host: String,
    val rawHost: String,
)

private val ALLOWED_PORTS = setOf(80, 443)

private val SCHEME_PREFIX_REGEX = Regex("""^([a-z][a-z0-9+.-]*):""", RegexOption.IGNORE_CASE)

private val UNIVERSAL_TRACKING_PARAMS = listOf(
    Regex("^utm_", RegexOption.IGNORE_CASE),
    Regex("^fbclid$", RegexOption.IGNORE_CASE),
    Regex("^gclid$", RegexOption.IGNORE_CASE),
    Regex("^dclid$", RegexOption.IGNORE_CASE),
    Regex("^msclkid$", RegexOption.IGNORE_CASE),
    Regex("^mc_[ce]id$", RegexOption.IGNORE_CASE),
    Regex("^igshid$", RegexOption.IGNORE_CASE),
    Regex("^igsh$", RegexOption.IGNORE_CASE),
    Regex("^__twitter_impression$", RegexOption.IGNORE_CASE),
    Regex("^spm_id_from$", RegexOption.IGNORE_CASE),
    Regex("^ref_src$", RegexOption.IGNORE_CASE),
    Regex("^ref_url$", RegexOption.IGNORE_CASE),
)

private val SOCIAL_TRACKING_PARAMS = listOf(
    Regex("^si$", RegexOption.IGNORE_CASE),
    Regex("^feature$", RegexOption.IGNORE_CASE),
    Regex("^s$", RegexOption.IGNORE_CASE),
    Regex("^t$", RegexOption.IGNORE_CASE),
    Regex("^_r$", RegexOption.IGNORE_CASE),
    Regex("^_t$", RegexOption.IGNORE_CASE),
    Regex("^share_(app_)?id$", RegexOption.IGNORE_CASE),
    Regex("^is_from_webapp$", RegexOption.IGNORE_CASE),
    Regex("^sender_device$", RegexOption.IGNORE_CASE),
    Regex("^web_id$", RegexOption.IGNORE_CASE),
)

private val KNOWN_SOCIAL_DOMAINS = listOf(
    "x.com",
    "twitter.com",
    "t.co",
    "vxtwitter.com",
    "fxtwitter.com",
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "instagram.com",
    "reddit.com",
)

private val PRESERVE_PARAMS = setOf("v", "list", "index", "id", "p", "story_fbid", "set")

val YOUTUBE_HOSTS = listOf(
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "music.youtube.com",
)

val TWITTER_HOSTS = listOf(
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "t.co",
    "vxtwitter.com",
    "fxtwitter.com",
    "fixupx.com",
    "fixvx.com",
    "twittpr.com",
)

val TIKTOK_HOSTS = listOf(
    "tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "m.tiktok.com",
)

val INSTAGRAM_HOSTS = listOf(
    "instagram.com",
    "instagr.am",
    "ddinstagram.com",
)

val REDDIT_HOSTS = listOf(
    "reddit.com",
    "redd.it",
    "v.redd.it",
    "old.reddit.com",
)

val TWITCH_HOSTS = listOf(
    "twitch.tv",
    "clips.twitch.tv",
    "m.twitch.tv",
)

val VIMEO_HOSTS = listOf(
    "vimeo.com",
    "player.vimeo.com",
)

val SOUNDCLOUD_HOSTS = listOf(
    "soundcloud.com",
    "snd.sc",
    "m.soundcloud.com",
    "on.soundcloud.com",
)

val FACEBOOK_HOSTS = listOf(
    "facebook.com",
    "fb.watch",
    "fb.com",
    "m.facebook.com",
    "web.facebook.com",
)

val PINTEREST_HOSTS = listOf(
    "pinterest.com",
    "pin.it",
    "pinterest.co.uk",
    "pinterest.ca",
    "pinterest.de",
)

val BANDCAMP_HOSTS = listOf(
    "bandcamp.com",
)

val DAILYMOTION_HOSTS = listOf(
    "dailymotion.com",
    "dai.ly",
)

val TUMBLR_HOSTS = listOf(
    "tumblr.com",
)

val THREADS_HOSTS = listOf(
    "threads.net",
    "threads.com",
)

val BLUESKY_HOSTS = listOf(
    "bsky.app",
    "bsky.social",
)

val MASTODON_HOSTS = listOf(
    "mastodon.social",
    "mastodon.online",
    "mastodon.world",
    "mstdn.social",
    "fosstodon.org",
    "hachyderm.io",
    "infosec.exchange",
    "techhub.social",
    "mas.to",
)

val SNAPCHAT_HOSTS = listOf(
    "snapchat.com",
    "t.snapchat.com",
)

val GDRIVE_HOSTS = listOf(
    "drive.google.com",
    "docs.google.com",
    "drive.usercontent.google.com",
)

val DROPBOX_HOSTS = listOf(
    "dropbox.com",
    "dl.dropboxusercontent.com",
)

val MEDIAFIRE_HOSTS = listOf(
    "mediafire.com",
)

val MEGA_HOSTS = listOf(
    "mega.nz",
    "mega.co.nz",
)

val MEDIA_EXTENSIONS = setOf(
    "mp4",
    "m4v",
    "mov",
    "webm",
    "mkv",
    "avi",
    "flv",
    "ts",
    "m3u8",
    "mpd",
    "mp3",
    "m4a",
    "aac",
    "opus",
    "ogg",
    "oga",
    "wav",
    "flac",
    "wma",
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif",
    "avif",
    "bmp",
    "tif",
    "tiff",
    "heic",
    "pdf",
    "iso",
    "zip",
    "tar",
    "7z",
    "apk",
    "dmg",
    "exe",
    "epub",
)

val ALL_OTHER_PROVIDER_IDS = listOf(
    "twitter",
    "tiktok",
    "reddit",
    "twitch",
    "vimeo",
    "soundcloud",
    "facebook",
    "pinterest",
    "bandcamp",
    "dailymotion",
    "tumblr",
    "threads",
    "bluesky",
    "mastodon",
    "snapchat",
    "gdrive",
    "dropbox",
    "mediafire",
    "mega",
    "direct",
    "generic",
)

val ALL_PROVIDER_IDS = listOf("youtube", "instagram") + ALL_OTHER_PROVIDER_IDS

val DEFAULT_INSTAGRAM_CDN_HOSTS = listOf(
    "cdninstagram.com",
    "fbcdn.net",
)

private val INSTAGRAM_SHORTCODE_REGEX = Regex("""/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)""")
private val MASTODON_STATUS_PATH_REGEX = Regex("""^/(@[^/]+/\d+|users/[^/]+/statuses/\d+)/?$""")
private val GDRIVE_PATH_ID_REGEX = Regex("""/(?:file|document|presentation|spreadsheets)/d/([a-zA-Z0-9_-]{6,})""", RegexOption.IGNORE_CASE)
private val GDRIVE_QUERY_ID_REGEX = Regex("""^[a-zA-Z0-9_-]{6,}$""")

private const val SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

private val YOUTUBE_WATCH_PATH_TYPES = setOf("shorts", "live", "embed", "v")

fun hasForbiddenUrlChar(value: String): Boolean {
    for (ch in value) {
        val code = ch.code
        if (code <= 0x20 || code == 0x7f || code in 0x80..0x9f) return true
        if (code in 0x200b..0x200f) return true
        if (code in 0x202a..0x202e) return true
        if (code in 0x2066..0x2069) return true
        if (code == 0x3000 || code == 0xfeff) return true
    }
    return false
}

fun stripWww(host: String): String {
    val clean = if (host.startsWith("www.")) host.substring(4) else host
    return clean.trimEnd('.')
}

fun hostMatches(host: String, domain: String): Boolean {
    val h = stripWww(host.lowercase())
    val d = stripWww(domain.lowercase())
    return d.isNotEmpty() && (h == d || h.endsWith(".$d"))
}

fun hostMatchesAny(host: String, domains: Iterable<String>): Boolean =
    domains.any { hostMatches(host, it) }

private fun parseIpv4Octets(input: String): IntArray? {
    val parts = input.split('.')
    if (parts.size != 4) return null
    val octets = IntArray(4)
    for (i in 0 until 4) {
        val part = parts[i]
        if (part.isEmpty() || part.length > 3 || !part.all { it in '0'..'9' }) return null
        if (part.length > 1 && part[0] == '0') return null
        val value = part.toIntOrNull() ?: return null
        if (value !in 0..255) return null
        octets[i] = value
    }
    return octets
}

private fun parseIpv6Words(address: String): IntArray? {
    val zoneIdx = address.indexOf('%')
    val bare = (if (zoneIdx >= 0) address.substring(0, zoneIdx) else address).lowercase().trim()
    if (bare.isEmpty()) return null
    val firstDc = bare.indexOf("::")
    if (firstDc != -1 && bare.indexOf("::", firstDc + 2) != -1) return null

    val headParts = if (firstDc != -1) {
        val prefix = bare.substring(0, firstDc)
        if (prefix.isEmpty()) emptyList() else prefix.split(':')
    } else {
        bare.split(':')
    }
    val tailParts = if (firstDc != -1) {
        val suffix = bare.substring(firstDc + 2)
        if (suffix.isEmpty()) emptyList() else suffix.split(':')
    } else {
        emptyList()
    }

    fun expand(parts: List<String>, allowV4: Boolean): List<Int>? {
        val words = ArrayList<Int>(parts.size)
        for (i in parts.indices) {
            val part = parts[i]
            if (part.isEmpty()) return null
            if (part.contains('.')) {
                if (!allowV4 || i != parts.lastIndex) return null
                val octets = parseIpv4Octets(part) ?: return null
                words.add((octets[0] shl 8) or octets[1])
                words.add((octets[2] shl 8) or octets[3])
            } else {
                if (part.length > 4 || !part.all { it in '0'..'9' || it in 'a'..'f' }) return null
                words.add(part.toInt(16))
            }
        }
        return words
    }

    val headWords = expand(headParts, tailParts.isEmpty()) ?: return null
    val tailWords = expand(tailParts, true) ?: return null

    if (firstDc != -1) {
        val missing = 8 - (headWords.size + tailWords.size)
        if (missing < 1) return null
        val out = IntArray(8)
        for (i in headWords.indices) out[i] = headWords[i]
        for (i in tailWords.indices) out[headWords.size + missing + i] = tailWords[i]
        return out
    }
    return if (headWords.size == 8) headWords.toIntArray() else null
}

private fun isPublicIpv4(octets: IntArray): Boolean {
    val a = octets[0]
    val b = octets[1]
    val c = octets[2]
    if (a == 0) return false
    if (a == 10) return false
    if (a == 100 && (b and 0xC0) == 64) return false
    if (a == 127) return false
    if (a == 169 && b == 254) return false
    if (a == 172 && b in 16..31) return false
    if (a == 192 && b == 0 && c == 0) return false
    if (a == 192 && b == 0 && c == 2) return false
    if (a == 192 && b == 31 && c == 196) return false
    if (a == 192 && b == 88 && c == 99) return false
    if (a == 192 && b == 168) return false
    if (a == 198 && (b == 18 || b == 19)) return false
    if (a == 198 && b == 51 && c == 100) return false
    if (a == 203 && b == 0 && c == 113) return false
    if (a >= 224) return false
    return true
}

private fun isPublicIpv6(words: IntArray): Boolean {
    if (words[0] == 0 && words[1] == 0 && words[2] == 0 && words[3] == 0 && words[4] == 0) {
        if (words[5] == 0xffff) {
            val mapped = intArrayOf(
                words[6] ushr 8,
                words[6] and 0xff,
                words[7] ushr 8,
                words[7] and 0xff,
            )
            return isPublicIpv4(mapped)
        }
        if (words[5] == 0) return false
    }
    if ((words[0] and 0xff00) == 0) return false
    if (words[0] == 0x0064 && words[1] == 0xff9b && words[2] == 0 && words[3] == 0 && words[4] == 0 && words[5] == 0) {
        return false
    }
    if (words[0] == 0x0064 && words[1] == 0xff9b && words[2] == 0x0001) return false
    if (words[0] == 0x0100 && words[1] == 0 && words[2] == 0 && words[3] == 0) return false
    if (words[0] == 0x2001 && (words[1] ushr 9) == 0) return false
    if (words[0] == 0x2001 && words[1] == 0x0db8) return false
    if (words[0] == 0x2002) return false
    if (words[0] == 0x3fff && (words[1] ushr 12) == 0) return false
    if (words[0] == 0x5f00) return false
    if ((words[0] and 0xfe00) == 0xfc00) return false
    if ((words[0] and 0xffc0) == 0xfe80) return false
    if ((words[0] and 0xffc0) == 0xfec0) return false
    if ((words[0] and 0xff00) == 0xff00) return false
    return true
}

fun isIpLiteral(hostname: String): Boolean {
    val bare = if (hostname.startsWith("[") && hostname.endsWith("]")) {
        hostname.substring(1, hostname.length - 1)
    } else {
        hostname
    }
    return parseIpv4Octets(bare) != null || parseIpv6Words(bare) != null
}

fun isPublicAddress(address: String): Boolean {
    val zoneIdx = address.indexOf('%')
    val trimmed = (if (zoneIdx >= 0) address.substring(0, zoneIdx) else address).trim()
    val v4 = parseIpv4Octets(trimmed)
    if (v4 != null) return isPublicIpv4(v4)
    val v6 = parseIpv6Words(trimmed)
    if (v6 != null) return isPublicIpv6(v6)
    return false
}

fun parseUserUrl(input: String, allowPrivateAddresses: Boolean = false): ParsedUrl {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) {
        throw seraError(SeraErrorCode.INVALID_URL, message = "Enter a link.")
    }
    if (hasForbiddenUrlChar(trimmed)) {
        throw seraError(SeraErrorCode.INVALID_URL, detail = "control character or space in url")
    }

    val schemeMatch = SCHEME_PREFIX_REGEX.find(trimmed)
    if (schemeMatch != null) {
        val scheme = schemeMatch.groupValues[1].lowercase()
        if (scheme != "http" && scheme != "https") {
            throw seraError(
                SeraErrorCode.INVALID_URL,
                message = "Only http and https links are supported.",
                detail = "protocol $scheme:",
            )
        }
    }
    val candidate = if (schemeMatch != null) trimmed else "https://$trimmed"
    val parsed = candidate.toHttpUrlOrNull() ?: throw seraError(SeraErrorCode.INVALID_URL)

    if (parsed.encodedUsername.isNotEmpty() || parsed.encodedPassword.isNotEmpty()) {
        throw seraError(
            SeraErrorCode.INVALID_URL,
            message = "Links with embedded credentials are not accepted.",
        )
    }
    if (!allowPrivateAddresses && parsed.port !in ALLOWED_PORTS) {
        throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "port ${parsed.port}")
    }

    val rawHost = parsed.host.lowercase().trimEnd('.')
    if (rawHost.isEmpty()) throw seraError(SeraErrorCode.INVALID_URL)

    val normalizedBuilder = parsed.newBuilder().host(rawHost)
    val cleanHost = stripWww(rawHost)
    if (!allowPrivateAddresses && isIpLiteral(rawHost)) {
        val bare = if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
            rawHost.substring(1, rawHost.length - 1)
        } else {
            rawHost
        }
        if (!isPublicAddress(bare)) {
            throw seraError(SeraErrorCode.BLOCKED_ADDRESS)
        }
    }
    if (cleanHost != "mega.nz" && cleanHost != "mega.co.nz") {
        normalizedBuilder.fragment(null)
    }
    return ParsedUrl(url = normalizedBuilder.build(), host = cleanHost, rawHost = rawHost)
}

fun normalizeUrl(url: HttpUrl): HttpUrl {
    val rawHost = url.host.lowercase().trimEnd('.')
    val cleanHost = stripWww(rawHost)
    val builder = url.newBuilder().host(rawHost)
    if (cleanHost != "mega.nz" && cleanHost != "mega.co.nz") {
        builder.fragment(null)
    }

    val isSocial = hostMatchesAny(rawHost, KNOWN_SOCIAL_DOMAINS)
    val keptParams = ArrayList<Pair<String, String?>>()
    for (i in 0 until url.querySize) {
        val key = url.queryParameterName(i)
        val value = url.queryParameterValue(i)
        val lower = key.lowercase()
        val keep = if (lower in PRESERVE_PARAMS) {
            true
        } else if (UNIVERSAL_TRACKING_PARAMS.any { it.containsMatchIn(key) }) {
            false
        } else if (isSocial && SOCIAL_TRACKING_PARAMS.any { it.containsMatchIn(key) }) {
            false
        } else {
            true
        }
        if (keep) keptParams.add(key to value)
    }
    builder.query(null)
    for ((key, value) in keptParams.sortedBy { it.first }) {
        builder.addQueryParameter(key, value)
    }

    val currentPath = url.encodedPath
    if (currentPath.length > 1 && currentPath.endsWith("/")) {
        builder.encodedPath(currentPath.trimEnd('/').ifEmpty { "/" })
    }
    return builder.build()
}

fun validateProviderUrl(
    raw: String?,
    allowPrivateAddresses: Boolean = false,
    blockedHosts: Collection<String> = emptyList(),
): String? {
    if (raw == null) return null
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || hasForbiddenUrlChar(trimmed)) return null
    val schemeMatch = SCHEME_PREFIX_REGEX.find(trimmed) ?: return null
    val scheme = schemeMatch.groupValues[1].lowercase()
    if (scheme != "http" && scheme != "https") return null
    val parsed = trimmed.toHttpUrlOrNull() ?: return null
    if (parsed.encodedUsername.isNotEmpty() || parsed.encodedPassword.isNotEmpty()) return null
    if (!allowPrivateAddresses && parsed.port !in ALLOWED_PORTS) return null
    val rawHost = parsed.host.lowercase().trimEnd('.')
    if (rawHost.isEmpty()) return null
    if (!allowPrivateAddresses && isIpLiteral(rawHost)) {
        val bare = if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
            rawHost.substring(1, rawHost.length - 1)
        } else {
            rawHost
        }
        if (!isPublicAddress(bare)) return null
    }
    val cleanHost = stripWww(rawHost)
    if (blockedHosts.isNotEmpty() && hostMatchesAny(cleanHost, blockedHosts)) return null
    return parsed.toString()
}

fun urlExtension(url: HttpUrl): String? {
    val decoded = try {
        URLDecoder.decode(url.encodedPath, StandardCharsets.UTF_8.name())
    } catch (_: Exception) {
        url.encodedPath
    }
    val match = Regex("""\.([a-z0-9]{1,5})$""", RegexOption.IGNORE_CASE).find(decoded)
    return match?.groupValues?.get(1)?.lowercase()
}

fun normalizeYoutubeUrl(url: HttpUrl): HttpUrl {
    val host = url.host.lowercase().removePrefix("www.")
    if (host == "youtu.be") {
        val id = url.pathSegments.firstOrNull { it.isNotEmpty() }
        if (id != null) return youtubeWatchUrl(id, url)
    }
    val segments = url.pathSegments.filter { it.isNotEmpty() }
    if (segments.size >= 2 && segments[0] in YOUTUBE_WATCH_PATH_TYPES) {
        return youtubeWatchUrl(segments[1], url)
    }
    return url.newBuilder()
        .scheme("https")
        .host("www.youtube.com")
        .build()
}

private fun youtubeWatchUrl(videoId: String, source: HttpUrl): HttpUrl {
    val builder = HttpUrl.Builder()
        .scheme("https")
        .host("www.youtube.com")
        .addPathSegment("watch")
        .addQueryParameter("v", videoId)
    val list = source.queryParameter("list")
    if (list != null) builder.addQueryParameter("list", list)
    return builder.build()
}

fun normalizeInstagramUrl(url: HttpUrl): HttpUrl =
    url.newBuilder()
        .scheme("https")
        .host("www.instagram.com")
        .build()

fun shortcodeFrom(url: HttpUrl): String? =
    INSTAGRAM_SHORTCODE_REGEX.find(url.encodedPath)?.groupValues?.get(1)

fun mediaIdFromShortcode(shortcode: String): String {
    var id = BigInteger.ZERO
    val sixtyFour = BigInteger.valueOf(64L)
    for (ch in shortcode.take(11)) {
        val digit = SHORTCODE_ALPHABET.indexOf(ch)
        if (digit < 0) {
            throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "instagram: bad shortcode")
        }
        id = id.multiply(sixtyFour).add(BigInteger.valueOf(digit.toLong()))
    }
    return id.toString()
}

fun isAllowedMediaUrl(
    value: String?,
    hosts: Collection<String> = DEFAULT_INSTAGRAM_CDN_HOSTS,
    requireHttps: Boolean = true,
): Boolean {
    if (value.isNullOrBlank()) return false
    val parsed = value.toHttpUrlOrNull() ?: return false
    if (parsed.encodedUsername.isNotEmpty() || parsed.encodedPassword.isNotEmpty()) return false
    if (requireHttps) {
        if (!parsed.isHttps || parsed.port != 443) return false
    } else if (parsed.scheme != "https" && parsed.scheme != "http") {
        return false
    }
    return hostMatchesAny(parsed.host, hosts)
}

fun assertCdnHosts(
    urls: Collection<String>,
    hosts: Collection<String> = DEFAULT_INSTAGRAM_CDN_HOSTS,
) {
    val refused = urls.indexOfFirst { !isAllowedMediaUrl(it, hosts, requireHttps = true) }
    if (refused == -1) return
    throw seraError(
        SeraErrorCode.BLOCKED_ADDRESS,
        message = "That post pointed at media somewhere other than Instagram.",
        hint = "Send the post again from instagram.com.",
        detail = "import: url $refused is not on the media hosts",
    )
}

fun extractGoogleDriveId(url: HttpUrl): String? {
    val pathMatch = GDRIVE_PATH_ID_REGEX.find(url.encodedPath)?.groupValues?.get(1)
    if (pathMatch != null) return pathMatch
    val queryId = url.queryParameter("id")
    if (queryId != null && GDRIVE_QUERY_ID_REGEX.matches(queryId)) return queryId
    return null
}

fun detectProvider(url: HttpUrl): String? {
    val host = stripWww(url.host.lowercase())
    val path = url.encodedPath
    if (hostMatchesAny(host, YOUTUBE_HOSTS)) return "youtube"
    if (hostMatchesAny(host, TWITTER_HOSTS)) return "twitter"
    if (hostMatchesAny(host, TIKTOK_HOSTS)) return "tiktok"
    if (hostMatchesAny(host, INSTAGRAM_HOSTS)) return "instagram"
    if (hostMatchesAny(host, REDDIT_HOSTS)) return "reddit"
    if (hostMatchesAny(host, TWITCH_HOSTS)) return "twitch"
    if (hostMatchesAny(host, VIMEO_HOSTS)) return "vimeo"
    if (hostMatchesAny(host, SOUNDCLOUD_HOSTS)) return "soundcloud"
    if (hostMatchesAny(host, FACEBOOK_HOSTS)) return "facebook"
    if (hostMatchesAny(host, PINTEREST_HOSTS)) return "pinterest"
    if (hostMatches(host, "bandcamp.com")) return "bandcamp"
    if (hostMatchesAny(host, DAILYMOTION_HOSTS)) return "dailymotion"
    if (hostMatches(host, "tumblr.com")) return "tumblr"
    if (hostMatchesAny(host, THREADS_HOSTS)) return "threads"
    if (hostMatchesAny(host, BLUESKY_HOSTS) && path.contains("/post/")) return "bluesky"
    if (hostMatchesAny(host, MASTODON_HOSTS) || MASTODON_STATUS_PATH_REGEX.matches(path)) return "mastodon"
    if (hostMatchesAny(host, SNAPCHAT_HOSTS)) return "snapchat"
    if (hostMatchesAny(host, GDRIVE_HOSTS) && extractGoogleDriveId(url) != null) return "gdrive"
    if (hostMatchesAny(host, DROPBOX_HOSTS) && path.length > 1) return "dropbox"
    if (hostMatchesAny(host, MEDIAFIRE_HOSTS) && path.length > 1) return "mediafire"
    if (hostMatchesAny(host, MEGA_HOSTS) && (
            path.startsWith("/file/") ||
                path.startsWith("/folder/") ||
                url.encodedFragment?.startsWith("!") == true
            )
    ) {
        return "mega"
    }
    val ext = urlExtension(url)
    if (ext != null && ext in MEDIA_EXTENSIONS) return "direct"
    return null
}

fun confineToHttp(selector: String): String {
    val httpProtocols = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']"
    return selector.split(',').joinToString(",") { part ->
        part.split('/').joinToString("/") { alternative ->
            alternative.split('+').joinToString("+") { atom ->
                if (atom.isEmpty() || atom.contains(httpProtocols)) atom else "$atom$httpProtocols"
            }
        }
    }
}
