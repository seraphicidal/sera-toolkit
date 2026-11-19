package dev.sera.node.extractor

import dev.sera.node.model.TaskExecutionOutcome
import java.util.concurrent.CancellationException

enum class SeraErrorCode(
    val defaultRetryable: Boolean,
    val defaultMessage: String,
    val defaultHint: String? = null,
) {
    INVALID_URL(false, "That doesn't look like a valid link."),
    UNSUPPORTED_SOURCE(
        false,
        "This source isn't currently supported.",
        "Try a direct link to the media file itself.",
    ),
    PRIVATE_CONTENT(
        false,
        "This content isn't publicly accessible.",
        "Only public posts can be processed.",
    ),
    MEDIA_UNAVAILABLE(false, "This media is no longer available."),
    GEO_RESTRICTED(false, "This media isn't available from this server's region."),
    AGE_RESTRICTED(false, "This media is age-restricted and cannot be accessed without signing in."),
    LOGIN_REQUIRED(false, "This media requires an account to view."),
    SOURCE_BLOCKED(
        false,
        "This source is blocking this server, not the link.",
        "Sites often challenge requests coming from datacentres. The same link usually works from a home connection.",
    ),
    PROVIDER_AUTH_REQUIRED(
        false,
        "This source needs an account, and this server does not have one.",
        "Nothing is wrong with the link. The operator of this server can enable it by adding credentials for that source.",
    ),
    PROVIDER_CONFIGURATION_ERROR(false, "This source is configured incorrectly on this server."),
    ROBOTS_DISALLOWED(
        false,
        "This site asks not to be read automatically.",
        "Try a direct link to the media file itself.",
    ),
    DRM_PROTECTED(
        false,
        "This media is protected by Digital Rights Management (DRM) and cannot be downloaded.",
        "Circumventing technical protection measures (Widevine, PlayReady, FairPlay) is prohibited under DMCA \u00a7 1201 and \u00a7 95a UrhG.",
    ),
    LIVE_IN_PROGRESS(
        false,
        "This stream is still live. Try again once it has finished.",
        "Live streams can only be processed after they end.",
    ),
    RATE_LIMITED(
        true,
        "The source is temporarily limiting requests. Try again later.",
        "Waiting a minute usually clears it.",
    ),
    PROVIDER_UNAVAILABLE(true, "Support for this source is temporarily unavailable."),
    NETWORK_ERROR(true, "We couldn't retrieve this media."),
    TOO_LARGE(
        false,
        "This media is larger than this server allows.",
        "Try a lower quality.",
    ),
    TOO_LONG(false, "This media is longer than this server allows."),
    CONVERSION_FAILED(
        false,
        "The media was downloaded, but conversion failed.",
        "Try a different format.",
    ),
    TIMEOUT(true, "This took too long and was stopped."),
    CANCELLED(false, "This download was cancelled."),
    NOT_FOUND(false, "We couldn't find that."),
    EXPIRED(
        false,
        "This link has expired. Analyze the URL again.",
        "Paste the link again to refresh the available formats.",
    ),
    BLOCKED_ADDRESS(false, "That address cannot be reached from this server."),
    QUEUE_FULL(true, "The server is busy right now. Try again in a moment."),
    INTERNAL(true, "Something went wrong on our side."),
}

enum class FailureClass {
    DATACENTER_BLOCKED,
    BOT_DETECTION,
    STREAM_403,
    CDN_DOWNLOAD_FAILURE,
    PO_TOKEN_REQUIRED,
    FORMAT_UNAVAILABLE,
    LOGIN_REQUIRED,
    AGE_RESTRICTED,
    AUTH_CONFIGURATION_ERROR,
    PRIVATE_CONTENT,
    DELETED_CONTENT,
    GEO_BLOCKED,
    UNSUPPORTED_URL,
    UNSUPPORTED_MEDIA,
    RATE_LIMITED,
    SOURCE_ERROR,
    UPSTREAM_TIMEOUT,
    NETWORK_ERROR,
    EXTRACTOR_BUG,
    OUTPUT_ERROR,
    CANCELLED,
}

class SeraException(
    val code: SeraErrorCode,
    override val message: String = code.defaultMessage,
    val hint: String? = code.defaultHint,
    val retryable: Boolean = code.defaultRetryable,
    val detail: String? = null,
    cause: Throwable? = null,
) : RuntimeException(message, cause) {
    fun toOutcome(): TaskExecutionOutcome {
        if (code == SeraErrorCode.CANCELLED) return TaskExecutionOutcome.Cancelled
        return TaskExecutionOutcome.Failed(
            code = code.name,
            message = message,
            detail = detail,
        )
    }

    companion object {
        fun from(
            value: Throwable,
            fallbackCode: SeraErrorCode = SeraErrorCode.INTERNAL,
        ): SeraException {
            if (value is SeraException) return value
            if (value is CancellationException) {
                return SeraException(
                    code = SeraErrorCode.CANCELLED,
                    detail = value.message,
                    cause = value,
                )
            }
            return SeraException(
                code = fallbackCode,
                message = fallbackCode.defaultMessage,
                detail = value.message ?: value.toString(),
                cause = value,
            )
        }
    }
}

fun seraError(
    code: SeraErrorCode,
    message: String? = null,
    hint: String? = null,
    detail: String? = null,
    cause: Throwable? = null,
): SeraException = SeraException(
    code = code,
    message = message ?: code.defaultMessage,
    hint = hint ?: code.defaultHint,
    retryable = code.defaultRetryable,
    detail = detail,
    cause = cause,
)

private val FAILURE_BY_CODE: Map<SeraErrorCode, FailureClass> = mapOf(
    SeraErrorCode.SOURCE_BLOCKED to FailureClass.DATACENTER_BLOCKED,
    SeraErrorCode.LOGIN_REQUIRED to FailureClass.LOGIN_REQUIRED,
    SeraErrorCode.PROVIDER_AUTH_REQUIRED to FailureClass.LOGIN_REQUIRED,
    SeraErrorCode.PROVIDER_CONFIGURATION_ERROR to FailureClass.AUTH_CONFIGURATION_ERROR,
    SeraErrorCode.PRIVATE_CONTENT to FailureClass.PRIVATE_CONTENT,
    SeraErrorCode.AGE_RESTRICTED to FailureClass.AGE_RESTRICTED,
    SeraErrorCode.DRM_PROTECTED to FailureClass.PRIVATE_CONTENT,
    SeraErrorCode.GEO_RESTRICTED to FailureClass.GEO_BLOCKED,
    SeraErrorCode.MEDIA_UNAVAILABLE to FailureClass.DELETED_CONTENT,
    SeraErrorCode.NOT_FOUND to FailureClass.DELETED_CONTENT,
    SeraErrorCode.EXPIRED to FailureClass.DELETED_CONTENT,
    SeraErrorCode.RATE_LIMITED to FailureClass.RATE_LIMITED,
    SeraErrorCode.PROVIDER_UNAVAILABLE to FailureClass.EXTRACTOR_BUG,
    SeraErrorCode.UNSUPPORTED_SOURCE to FailureClass.UNSUPPORTED_MEDIA,
    SeraErrorCode.ROBOTS_DISALLOWED to FailureClass.UNSUPPORTED_MEDIA,
    SeraErrorCode.LIVE_IN_PROGRESS to FailureClass.UNSUPPORTED_MEDIA,
    SeraErrorCode.INVALID_URL to FailureClass.UNSUPPORTED_URL,
    SeraErrorCode.BLOCKED_ADDRESS to FailureClass.UNSUPPORTED_URL,
    SeraErrorCode.NETWORK_ERROR to FailureClass.NETWORK_ERROR,
    SeraErrorCode.TIMEOUT to FailureClass.UPSTREAM_TIMEOUT,
    SeraErrorCode.CONVERSION_FAILED to FailureClass.OUTPUT_ERROR,
    SeraErrorCode.TOO_LARGE to FailureClass.OUTPUT_ERROR,
    SeraErrorCode.TOO_LONG to FailureClass.OUTPUT_ERROR,
    SeraErrorCode.QUEUE_FULL to FailureClass.RATE_LIMITED,
    SeraErrorCode.CANCELLED to FailureClass.CANCELLED,
    SeraErrorCode.INTERNAL to FailureClass.EXTRACTOR_BUG,
)

private val PHRASE_RULES: List<Pair<FailureClass, List<String>>> = listOf(
    FailureClass.BOT_DETECTION to listOf(
        "not a bot",
        "unusual traffic",
        "suspicious activity",
        "confirm your identity",
    ),
    FailureClass.PO_TOKEN_REQUIRED to listOf(
        "po token",
        "po_token",
        "potoken",
        "missing a gvs po token",
        "requires a po token",
    ),
    FailureClass.FORMAT_UNAVAILABLE to listOf(
        "requested format is not available",
        "no video formats found",
        "no formats found",
    ),
    FailureClass.STREAM_403 to listOf(
        "http error 403",
        "unable to download video data: http error 403",
    ),
    FailureClass.CDN_DOWNLOAD_FAILURE to listOf(
        "fragment 1 not found",
        "giving up after 10 fragment retries",
        "unable to download fragment",
        "the download is incomplete",
    ),
    FailureClass.AGE_RESTRICTED to listOf(
        "age-restricted",
        "confirm your age",
        "sign in to confirm your age",
    ),
    FailureClass.DELETED_CONTENT to listOf(
        "has been removed",
        "no longer available",
        "video unavailable",
    ),
    FailureClass.GEO_BLOCKED to listOf(
        "not available in your country",
        "blocked it in your country",
    ),
    FailureClass.SOURCE_ERROR to listOf(
        "http error 5",
        "internal server error",
        "service unavailable",
    ),
)

private val DEFINITIVE_CODES = setOf(
    SeraErrorCode.UNSUPPORTED_SOURCE,
    SeraErrorCode.PRIVATE_CONTENT,
    SeraErrorCode.DRM_PROTECTED,
    SeraErrorCode.BLOCKED_ADDRESS,
    SeraErrorCode.CANCELLED,
)

fun classifyFailure(error: Throwable): FailureClass {
    val sera = SeraException.from(error)
    if (sera.code in DEFINITIVE_CODES) {
        return FAILURE_BY_CODE[sera.code] ?: FailureClass.EXTRACTOR_BUG
    }
    val haystack = "${sera.message} ${sera.detail.orEmpty()}".lowercase()
    for ((failure, phrases) in PHRASE_RULES) {
        if (phrases.any { haystack.contains(it) }) return failure
    }
    return FAILURE_BY_CODE[sera.code] ?: FailureClass.EXTRACTOR_BUG
}

fun isEgressProblem(failure: FailureClass): Boolean =
    failure == FailureClass.DATACENTER_BLOCKED ||
        failure == FailureClass.BOT_DETECTION ||
        failure == FailureClass.PO_TOKEN_REQUIRED ||
        failure == FailureClass.CDN_DOWNLOAD_FAILURE

fun isDefinitive(failure: FailureClass): Boolean =
    failure == FailureClass.PRIVATE_CONTENT ||
        failure == FailureClass.AGE_RESTRICTED ||
        failure == FailureClass.DELETED_CONTENT ||
        failure == FailureClass.GEO_BLOCKED ||
        failure == FailureClass.UNSUPPORTED_URL ||
        failure == FailureClass.CANCELLED

private val CRED_USERINFO_REGEX = Regex("""([a-z][a-z0-9+.-]{0,15}://)[^\s/@]+@""", RegexOption.IGNORE_CASE)
private val CRED_PARAM_REGEX = Regex(
    """([?&](?:token|access_token|auth|key|apikey|api_key|sig|signature|password)=)[^&\s]+""",
    RegexOption.IGNORE_CASE,
)

fun scrubCredentials(text: String): String =
    text
        .replace(CRED_USERINFO_REGEX, "$1[redacted]@")
        .replace(CRED_PARAM_REGEX, "$1[redacted]")

private val ERROR_LINE_REGEX = Regex("""^\s*error:""", RegexOption.IGNORE_CASE)

fun classifyYtdlpFailure(stderr: String, exitCode: Int): SeraException {
    val errorLines = stderr.split(Regex("""\r?\n""")).filter { ERROR_LINE_REGEX.containsMatchIn(it) }
    val text = (if (errorLines.isNotEmpty()) errorLines.joinToString("\n") else stderr).lowercase()
    val scrubbed = scrubCredentials(stderr)
    val tail = if (scrubbed.length > 600) scrubbed.takeLast(600) else scrubbed
    val detail = "yt-dlp exit $exitCode: $tail"

    fun has(vararg needles: String): Boolean = needles.any { text.contains(it) }

    if (has("is private", "private video", "private account", "this post is private")) {
        return seraError(SeraErrorCode.PRIVATE_CONTENT, detail = detail)
    }
    if (
        has(
            "sign in to confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
        )
    ) {
        return seraError(SeraErrorCode.AGE_RESTRICTED, detail = detail)
    }
    if (
        has(
            "protected by widevine",
            "widevine",
            "fairplay",
            "playready",
            "clearkey",
            "drm protected",
            "drm_protected",
            "is encrypted",
            "encrypted media",
            "encrypted_media",
            "sample-aes",
            "this video is drm protected",
            "known to use drm",
        )
    ) {
        return seraError(SeraErrorCode.DRM_PROTECTED, detail = detail)
    }
    if (
        has(
            "paywall",
            "subscription required",
            "subscribers only",
            "premium only",
            "requires a subscription",
            "paid content",
            "members-only",
            "members only",
        )
    ) {
        return seraError(SeraErrorCode.PROVIDER_AUTH_REQUIRED, detail = detail)
    }
    if (
        has(
            "you're not a bot",
            "you\u2019re not a bot",
            "not a bot",
            "confirm you are not a bot",
            "unusual traffic",
            "suspicious activity",
        )
    ) {
        return seraError(SeraErrorCode.SOURCE_BLOCKED, detail = detail)
    }
    if (
        has(
            "sign in to confirm",
            "login required",
            "requires authentication",
            "use --cookies",
            "account is required",
            "you're not signed in",
            "only available for registered users",
            "use --username",
            "provide account credentials",
            "you need to log in",
            "please log in",
            "login is required",
        )
    ) {
        return seraError(SeraErrorCode.LOGIN_REQUIRED, detail = detail)
    }
    if (
        has(
            "not available in your country",
            "available in your country",
            "not available from your location",
            "geo restricted",
            "geo-restricted",
            "geo restriction",
            "blocked in your country",
            "blocked it in your country",
        )
    ) {
        return seraError(SeraErrorCode.GEO_RESTRICTED, detail = detail)
    }
    if (
        has(
            "live event will begin",
            "is not yet available",
            "premieres in",
            "live stream is offline",
        )
    ) {
        return seraError(SeraErrorCode.LIVE_IN_PROGRESS, detail = detail)
    }
    if (has("http error 429", "too many requests", "rate-limit", "rate limit")) {
        return seraError(SeraErrorCode.RATE_LIMITED, detail = detail)
    }
    if (
        has(
            "no video could be found",
            "there is no video in this post",
            "no media found",
            "unable to find any media",
        )
    ) {
        return seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            detail = "no extractable video: $detail",
        )
    }
    if (has("primarily used for piracy")) {
        return seraError(
            SeraErrorCode.UNSUPPORTED_SOURCE,
            message = "This site isn't supported.",
            hint = "Try the link on the site that published the video.",
            detail = detail,
        )
    }
    if (
        has(
            "unsupported url",
            "no suitable inforextractor",
            "no suitable extractor",
            "is not a valid url",
        )
    ) {
        return seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = detail)
    }
    if (
        has(
            "video unavailable",
            "this video is not available",
            "has been removed",
            "no longer available",
            "page does not exist",
            "account has been suspended",
        ) || (!has("fragment") && has("http error 404", "not found"))
    ) {
        return seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = detail)
    }
    if (
        has(
            "requested format is not available",
            "no video formats found",
            "no formats found",
        )
    ) {
        return seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "The requested quality is no longer available.",
            hint = "Analyze the link again to refresh the format list.",
            detail = detail,
        )
    }
    if (has("file is larger than max-filesize", "exceeds --max-filesize")) {
        return seraError(SeraErrorCode.TOO_LARGE, detail = detail)
    }
    if (
        has(
            "unable to download webpage",
            "connection reset",
            "connection refused",
            "temporary failure in name resolution",
            "timed out",
            "unable to connect",
            "ssl",
        )
    ) {
        return seraError(SeraErrorCode.NETWORK_ERROR, detail = detail)
    }
    if (has("unable to extract", "failed to parse", "unable to recognize", "extractor")) {
        return seraError(
            SeraErrorCode.PROVIDER_UNAVAILABLE,
            hint = "This usually clears once the extractor is updated.",
            detail = detail,
        )
    }
    return seraError(SeraErrorCode.PROVIDER_UNAVAILABLE, detail = detail)
}
