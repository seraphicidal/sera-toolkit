package dev.sera.node.extractor

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlin.math.max
import kotlin.math.min

private const val DEFAULT_MAX_REDIRECTS = 5
private val ALLOWED_PORTS = setOf(80, 443)

class BlockedAddressIoException(message: String) : IOException(message)

private class DirectByteArrayOutputStream(initialCapacity: Int) : ByteArrayOutputStream(initialCapacity) {
    fun toUtf8String(): String = String(buf, 0, count, Charsets.UTF_8)
}

class OkHttpFetcher(
    private val baseClient: OkHttpClient,
    private val dnsResolver: Dns = Dns.SYSTEM,
) : HttpFetcher {

    private fun buildClient(allowPrivateAddresses: Boolean, timeoutMs: Long): OkHttpClient {
        val guardedDns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                val cleanHost = hostname.lowercase().trim().trimEnd('.')
                if (!allowPrivateAddresses && isBlockedLocalHostname(cleanHost)) {
                    throw BlockedAddressIoException("blocked local host $cleanHost")
                }
                val resolved = dnsResolver.lookup(hostname)
                if (!allowPrivateAddresses) {
                    if (resolved.isEmpty() || resolved.any { !isPublicInetAddress(it) }) {
                        throw BlockedAddressIoException("non-public dns resolution for $cleanHost")
                    }
                }
                return resolved
            }
        }
        return baseClient.newBuilder()
            .dns(guardedDns)
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(timeoutMs.coerceAtLeast(1_000L), TimeUnit.MILLISECONDS)
            .build()
    }

    override suspend fun fetchText(
        url: HttpUrl,
        maxBytes: Long,
        headers: Map<String, String>,
        keepCookies: Boolean,
        allowPrivateAddresses: Boolean,
        timeoutMs: Long,
        userAgent: String,
        isCancelled: () -> Boolean,
    ): HttpTextResponse = withContext(Dispatchers.IO) {
        val opened = openWithRedirects(
            initialUrl = url,
            headers = headers,
            keepCookies = keepCookies,
            allowPrivateAddresses = allowPrivateAddresses,
            timeoutMs = timeoutMs,
            userAgent = userAgent,
            allowUrl = { true },
            isCancelled = isCancelled,
        )
        withImmediateCancelHook(
            onCancel = { opened.call.cancel() },
            isCancelled = isCancelled,
        ) {
            withContext(Dispatchers.IO) {
                opened.response.use { response ->
                    if (response.code >= 400) {
                        throw seraError(
                            if (response.code == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                            detail = "GET ${response.code}",
                        )
                    }
                    val bodyText = readBoundedText(response, maxBytes, isCancelled)
                    HttpTextResponse(
                        body = bodyText,
                        url = opened.finalUrl.toString(),
                        status = response.code,
                        headers = extractHeaders(response),
                    )
                }
            }
        }
    }

    override suspend fun head(
        url: HttpUrl,
        headers: Map<String, String>,
        allowPrivateAddresses: Boolean,
        timeoutMs: Long,
        userAgent: String,
        isCancelled: () -> Boolean,
    ): HttpHeadResponse = withContext(Dispatchers.IO) {
        val opened = openWithRedirects(
            initialUrl = url,
            headers = headers,
            keepCookies = false,
            allowPrivateAddresses = allowPrivateAddresses,
            timeoutMs = timeoutMs,
            userAgent = userAgent,
            allowUrl = { true },
            isCancelled = isCancelled,
            method = "HEAD",
        )
        opened.response.use { response ->
            val contentType = response.header("content-type")
            val contentLength = response.header("content-length")?.toLongOrNull()?.takeIf { it > 0L }
            HttpHeadResponse(
                status = response.code,
                contentType = contentType,
                contentLength = contentLength,
                url = opened.finalUrl.toString(),
            )
        }
    }

    override suspend fun fetchNoFollow(
        url: HttpUrl,
        maxBytes: Long,
        headers: Map<String, String>,
        allowPrivateAddresses: Boolean,
        timeoutMs: Long,
        userAgent: String,
        isCancelled: () -> Boolean,
    ): HttpTextResponse = withContext(Dispatchers.IO) {
        validateDestination(url, allowPrivateAddresses)
        val client = buildClient(allowPrivateAddresses, timeoutMs)
        val reqBuilder = Request.Builder().url(url).get()
        reqBuilder.header("User-Agent", userAgent)
        for ((k, v) in headers) reqBuilder.header(k, v)
        val call = client.newCall(reqBuilder.build())
        val response = executeCall(call, isCancelled)
        withImmediateCancelHook(
            onCancel = { call.cancel() },
            isCancelled = isCancelled,
        ) {
            withContext(Dispatchers.IO) {
                response.use { resp ->
                    val bodyText = readBoundedText(resp, maxBytes, isCancelled)
                    HttpTextResponse(
                        body = bodyText,
                        url = url.toString(),
                        status = resp.code,
                        headers = extractHeaders(resp),
                    )
                }
            }
        }
    }

    override suspend fun postForm(
        url: HttpUrl,
        formBody: String,
        headers: Map<String, String>,
        maxBytes: Long,
        allowPrivateAddresses: Boolean,
        timeoutMs: Long,
        userAgent: String,
        isCancelled: () -> Boolean,
    ): HttpTextResponse = withContext(Dispatchers.IO) {
        validateDestination(url, allowPrivateAddresses)
        val client = buildClient(allowPrivateAddresses, timeoutMs)
        val body = formBody.toRequestBody("application/x-www-form-urlencoded".toMediaType())
        val reqBuilder = Request.Builder().url(url).post(body)
        reqBuilder.header("User-Agent", userAgent)
        for ((k, v) in headers) reqBuilder.header(k, v)
        val call = client.newCall(reqBuilder.build())
        val response = executeCall(call, isCancelled)
        withImmediateCancelHook(
            onCancel = { call.cancel() },
            isCancelled = isCancelled,
        ) {
            withContext(Dispatchers.IO) {
                response.use { resp ->
                    val bodyText = readBoundedText(resp, maxBytes, isCancelled)
                    HttpTextResponse(
                        body = bodyText,
                        url = url.toString(),
                        status = resp.code,
                        headers = extractHeaders(resp),
                    )
                }
            }
        }
    }

    override suspend fun downloadDirect(
        url: String,
        destination: File,
        maxBytes: Long,
        timeoutMs: Long,
        allowPrivateAddresses: Boolean,
        allowUrl: (HttpUrl) -> Boolean,
        isCancelled: () -> Boolean,
        onProgress: (DirectDownloadProgress) -> Unit,
    ): DirectDownloadResult = withContext(Dispatchers.IO) {
        val parsed = url.toHttpUrlOrNull()
            ?: throw seraError(SeraErrorCode.INVALID_URL, detail = "invalid url: $url")

        val opened = openWithRedirects(
            initialUrl = parsed,
            headers = emptyMap(),
            keepCookies = false,
            allowPrivateAddresses = allowPrivateAddresses,
            timeoutMs = timeoutMs,
            userAgent = dev.sera.node.model.DEFAULT_INSTAGRAM_USER_AGENT,
            allowUrl = allowUrl,
            isCancelled = isCancelled,
        )

        try {
            withImmediateCancelHook(
                onCancel = { opened.call.cancel() },
                isCancelled = isCancelled,
            ) {
                withContext(Dispatchers.IO) {
                    opened.response.use { response ->
                        if (response.code >= 400) {
                            throw seraError(
                                if (response.code == 404) SeraErrorCode.MEDIA_UNAVAILABLE else SeraErrorCode.NETWORK_ERROR,
                                detail = "GET ${response.code}",
                            )
                        }
                        val body = response.body
                            ?: throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "server returned an empty body")
                        val declared = body.contentLength().takeIf { it > 0L }
                        if (declared != null && declared > maxBytes) {
                            throw seraError(SeraErrorCode.TOO_LARGE, detail = "content-length $declared > $maxBytes")
                        }

                        destination.parentFile?.mkdirs()
                        var received = 0L
                        val startedAt = System.currentTimeMillis()
                        var lastReport = 0L
                        val buffer = ByteArray(64 * 1024)

                        body.byteStream().use { input ->
                            FileOutputStream(destination).use { output ->
                                while (true) {
                                    if (isCancelled() || !currentCoroutineContext().isActive) {
                                        opened.call.cancel()
                                        throw seraError(SeraErrorCode.CANCELLED)
                                    }
                                    val read = input.read(buffer)
                                    if (read < 0) break
                                    received += read
                                    if (received > maxBytes) {
                                        opened.call.cancel()
                                        throw seraError(SeraErrorCode.TOO_LARGE, detail = "body exceeded $maxBytes bytes")
                                    }
                                    output.write(buffer, 0, read)
                                    val now = System.currentTimeMillis()
                                    if (now - lastReport >= 250L) {
                                        lastReport = now
                                        val elapsed = (now - startedAt) / 1000.0
                                        val speed = if (elapsed > 0.0) received / elapsed else null
                                        val eta = if (speed != null && speed > 0.0 && declared != null) {
                                            max(0.0, (declared - received) / speed)
                                        } else {
                                            null
                                        }
                                        onProgress(
                                            DirectDownloadProgress(
                                                bytesDownloaded = received,
                                                bytesTotal = declared,
                                                speedBytesPerSecond = speed,
                                                etaSeconds = eta,
                                            ),
                                        )
                                    }
                                }
                                output.flush()
                            }
                        }

                        if (received == 0L) {
                            destination.delete()
                            throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "server returned an empty file")
                        }

                        onProgress(
                            DirectDownloadProgress(
                                bytesDownloaded = received,
                                bytesTotal = declared,
                            ),
                        )

                        DirectDownloadResult(
                            bytes = received,
                            contentType = response.header("content-type"),
                            url = opened.finalUrl.toString(),
                        )
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            destination.delete()
            throw cancelled
        } catch (error: Throwable) {
            destination.delete()
            if (error is SeraException) throw error
            if (error is BlockedAddressIoException) {
                throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = error.message, cause = error)
            }
            if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED, cause = error)
            if (error is InterruptedIOException) throw seraError(SeraErrorCode.TIMEOUT, cause = error)
            throw seraError(SeraErrorCode.NETWORK_ERROR, detail = error.message ?: "stream to disk failed", cause = error)
        }
    }

    private data class OpenedHttp(
        val response: Response,
        val finalUrl: HttpUrl,
        val call: Call,
    )

    private suspend fun openWithRedirects(
        initialUrl: HttpUrl,
        headers: Map<String, String>,
        keepCookies: Boolean,
        allowPrivateAddresses: Boolean,
        timeoutMs: Long,
        userAgent: String,
        allowUrl: (HttpUrl) -> Boolean,
        isCancelled: () -> Boolean,
        method: String = "GET",
    ): OpenedHttp {
        val client = buildClient(allowPrivateAddresses, timeoutMs)

        val initialOrigin = originOf(initialUrl)
        val jar = parseCookieJar(headers.entries.firstOrNull { it.key.equals("cookie", ignoreCase = true) }?.value)
        var current = initialUrl

        for (hop in 0..DEFAULT_MAX_REDIRECTS) {
            if (isCancelled() || !currentCoroutineContext().isActive) throw seraError(SeraErrorCode.CANCELLED)
            validateDestination(current, allowPrivateAddresses)
            if (hop > 0 && current.port !in ALLOWED_PORTS && current.port != initialUrl.port) {
                throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "redirect to port ${current.port}")
            }
            if (!allowUrl(current)) {
                throw seraError(
                    SeraErrorCode.BLOCKED_ADDRESS,
                    detail = if (hop == 0) {
                        "destination is not on the allowed hosts"
                    } else {
                        "redirect $hop left the allowed hosts"
                    },
                )
            }

            val reqBuilder = Request.Builder().url(current)
            if (method.equals("HEAD", ignoreCase = true)) {
                reqBuilder.head()
            } else {
                reqBuilder.get()
            }
            reqBuilder.header("User-Agent", userAgent)
            reqBuilder.header("Accept-Language", "en-US,en;q=0.9")
            reqBuilder.header("Accept", "*/*")

            val currentOrigin = originOf(current)
            val crossOrigin = currentOrigin != initialOrigin
            for ((key, value) in headers) {
                val lower = key.lowercase()
                if (lower == "cookie") continue
                if (crossOrigin && (lower == "authorization" || lower == "proxy-authorization" || lower == "x-api-key")) {
                    continue
                }
                reqBuilder.header(key, value)
            }
            if (jar.isNotEmpty() && !crossOrigin) {
                reqBuilder.header("cookie", jar.entries.joinToString("; ") { "${it.key}=${it.value}" })
            }

            val call = client.newCall(reqBuilder.build())
            val response = executeCall(call, isCancelled)

            if (response.code in 300..399) {
                val location = response.header("location")
                val setCookies = response.headers("set-cookie")
                response.close()
                if (location.isNullOrBlank()) {
                    throw seraError(SeraErrorCode.NETWORK_ERROR, detail = "redirect ${response.code} without location")
                }
                if (keepCookies && currentOrigin == initialOrigin) {
                    keepSetCookies(jar, setCookies)
                }
                current = current.resolve(location)
                    ?: throw seraError(SeraErrorCode.NETWORK_ERROR, detail = "invalid redirect location")
                continue
            }

            return OpenedHttp(response = response, finalUrl = current, call = call)
        }

        throw seraError(SeraErrorCode.NETWORK_ERROR, detail = "redirect loop")
    }

    private fun validateDestination(current: HttpUrl, allowPrivateAddresses: Boolean) {
        if (current.scheme != "http" && current.scheme != "https") {
            throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "redirect to ${current.scheme}:")
        }
        if (current.encodedUsername.isNotEmpty() || current.encodedPassword.isNotEmpty()) {
            throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "credentials in url")
        }
        val bareHost = current.host.lowercase().trimEnd('.')
        if (!allowPrivateAddresses) {
            if (isBlockedLocalHostname(bareHost)) {
                throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "blocked local host $bareHost")
            }
            if (isIpLiteral(bareHost) && !isPublicAddress(bareHost)) {
                throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "non-public address $bareHost")
            }
            if (current.port !in ALLOWED_PORTS) {
                throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = "port ${current.port}")
            }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun executeCall(call: Call, isCancelled: () -> Boolean): Response =
        try {
            if (isCancelled() || !currentCoroutineContext().isActive) {
                call.cancel()
                throw seraError(SeraErrorCode.CANCELLED)
            }
            coroutineScope {
                val cancelWatcher = launch {
                    while (isActive) {
                        if (isCancelled()) {
                            call.cancel()
                            break
                        }
                        delay(100L)
                    }
                }
                try {
                    suspendCancellableCoroutine<Response> { cont ->
                        cont.invokeOnCancellation { call.cancel() }
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
                } finally {
                    cancelWatcher.cancel()
                }
            }
        } catch (cancelled: CancellationException) {
            call.cancel()
            throw cancelled
        } catch (error: SeraException) {
            throw error
        } catch (error: BlockedAddressIoException) {
            throw seraError(SeraErrorCode.BLOCKED_ADDRESS, detail = error.message, cause = error)
        } catch (error: UnknownHostException) {
            throw seraError(
                SeraErrorCode.INVALID_URL,
                message = "We couldn't find that site.",
                hint = "Check the address and try again.",
                detail = error.message,
                cause = error,
            )
        } catch (error: InterruptedIOException) {
            if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED, cause = error)
            throw seraError(SeraErrorCode.TIMEOUT, cause = error)
        } catch (error: IOException) {
            if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED, cause = error)
            throw seraError(SeraErrorCode.NETWORK_ERROR, detail = error.message, cause = error)
        }

    private suspend fun readBoundedText(response: Response, maxBytes: Long, isCancelled: () -> Boolean): String {
        val body = response.body ?: return ""
        val declared = body.contentLength()
        if (declared > maxBytes) {
            throw seraError(SeraErrorCode.TOO_LARGE, detail = "content-length $declared > $maxBytes")
        }
        val initialSize = if (declared > 0L) min(declared, min(maxBytes, 65_536L)).toInt() else 8192
        val out = DirectByteArrayOutputStream(initialSize)
        val buf = ByteArray(16 * 1024)
        var total = 0L
        body.byteStream().use { stream ->
            while (true) {
                if (isCancelled() || !currentCoroutineContext().isActive) throw seraError(SeraErrorCode.CANCELLED)
                val read = stream.read(buf)
                if (read < 0) break
                total += read
                if (total > maxBytes) {
                    throw seraError(SeraErrorCode.TOO_LARGE, detail = "body exceeded $maxBytes bytes")
                }
                out.write(buf, 0, read)
            }
        }
        return out.toUtf8String()
    }

    private fun extractHeaders(response: Response): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        for (i in 0 until response.headers.size) {
            map[response.headers.name(i).lowercase()] = response.headers.value(i)
        }
        return map
    }

    private fun originOf(url: HttpUrl): String = "${url.scheme}://${url.host.lowercase()}:${url.port}"

    private fun parseCookieJar(cookieHeader: String?): MutableMap<String, String> {
        val jar = LinkedHashMap<String, String>()
        if (cookieHeader.isNullOrBlank()) return jar
        for (pair in cookieHeader.split(';')) {
            val eq = pair.indexOf('=')
            if (eq > 0) {
                jar[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim()
            }
        }
        return jar
    }

    private fun keepSetCookies(jar: MutableMap<String, String>, setCookies: List<String>) {
        for (line in setCookies) {
            val pair = line.substringBefore(';')
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val name = pair.substring(0, eq).trim()
            val value = pair.substring(eq + 1).trim()
            if (value.isNotEmpty() && value != "\"\"") {
                jar[name] = value
            }
        }
    }
}
