package dev.sera.node.extractor

import dev.sera.node.model.ConversionSpec
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.FetchPlan
import dev.sera.node.model.NodeRuntimeConfig
import dev.sera.node.model.NodeTaskRunner
import dev.sera.node.model.ProducedFile
import dev.sera.node.model.ProviderHotConfig
import dev.sera.node.model.RemoteSubtitleSpec
import dev.sera.node.model.RemoteTask
import dev.sera.node.model.RemoteTrimRange
import dev.sera.node.model.ResolvedItem
import dev.sera.node.model.ResolvedMedia
import dev.sera.node.model.ResolvedPlan
import dev.sera.node.model.TaskExecutionOutcome
import dev.sera.node.model.TaskProgress
import dev.sera.node.model.planKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

private const val DOWNLOAD_SHARE = 0.85
private const val NODE_DOWNLOAD_SCALE = 0.85
private const val RESOLVE_CACHE_TTL_MS = 5 * 60_000L
private const val RESOLVE_CACHE_MAX_ENTRIES = 100
private const val SECTION_STALL_MS = 20_000L
private const val DEFAULT_MAX_DURATION_SECONDS = 4 * 60 * 60
private val VALID_SUBTITLE_LANG = Regex("""^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$""")
private val VALID_AUDIO_ID = Regex("""^[A-Za-z0-9_.-]+$""")
private val VALIDATED_AUDIO_VIDEO_EXTS = setOf(
    "mp4",
    "webm",
    "mov",
    "mkv",
    "mp3",
    "m4a",
    "opus",
    "wav",
    "flac",
    "ogg",
)
private val FORMAT_FALLBACK_ANSWERS = setOf(
    FailureClass.FORMAT_UNAVAILABLE,
    FailureClass.STREAM_403,
    FailureClass.CDN_DOWNLOAD_FAILURE,
    FailureClass.SOURCE_ERROR,
)

data class TaskSelection(
    val itemIndex: Int,
    val sourceId: String? = null,
    val planKey: String,
)

data class MatchedSelection(
    val item: ResolvedItem,
    val plan: ResolvedPlan,
)

private data class CachedResolution(
    val result: ExtractorResolveResult,
    val resolvedAtMs: Long,
)

private sealed interface ItemExecutionResult {
    data class Subtitles(
        val index: Int,
        val file: File,
        val item: ResolvedItem,
        val plan: ResolvedPlan,
    ) : ItemExecutionResult

    data class Media(
        val index: Int,
        val file: File,
        val usedPlan: ResolvedPlan,
        val item: ResolvedItem,
        val requestedPlan: ResolvedPlan,
        val subtitleFile: File? = null,
    ) : ItemExecutionResult
}

class SeraNodeTaskRunner(
    private val toolsManager: ExtractionToolsManager,
    private val executor: MediaCommandExecutor,
    private val httpFetcher: HttpFetcher,
    private val defaultWorkRoot: File,
) : NodeTaskRunner {

    private val youtubeExtractor = YoutubeExtractor(executor)
    private val instagramExtractor = InstagramExtractor(executor, httpFetcher)
    private val twitterExtractor = TwitterExtractor(executor, httpFetcher)
    private val tiktokExtractor = TiktokExtractor(executor)
    private val redditExtractor = RedditExtractor(executor, httpFetcher)
    private val twitchExtractor = TwitchExtractor(executor)
    private val vimeoExtractor = VimeoExtractor(executor)
    private val soundcloudExtractor = SoundcloudExtractor(executor)
    private val facebookExtractor = FacebookExtractor(executor)
    private val pinterestExtractor = PinterestExtractor(executor)
    private val bandcampExtractor = BandcampExtractor(executor)
    private val dailymotionExtractor = DailymotionExtractor(executor)
    private val tumblrExtractor = TumblrExtractor(executor)
    private val threadsExtractor = ThreadsExtractor(executor, httpFetcher)
    private val blueskyExtractor = BlueskyExtractor(executor, httpFetcher)
    private val mastodonExtractor = MastodonExtractor(executor, httpFetcher)
    private val snapchatExtractor = SnapchatExtractor(executor)
    private val gdriveExtractor = GoogleDriveExtractor(executor, httpFetcher)
    private val dropboxExtractor = DropboxExtractor(executor, httpFetcher)
    private val mediafireExtractor = MediaFireExtractor(executor, httpFetcher)
    private val megaExtractor = MegaExtractor(executor)
    private val directExtractor = DirectFileExtractor(executor, httpFetcher)
    private val genericExtractor = GenericExtractor(executor, httpFetcher)

    private val extractorsById: Map<String, YtdlpBaseExtractor> = listOf(
        youtubeExtractor,
        instagramExtractor,
        twitterExtractor,
        tiktokExtractor,
        redditExtractor,
        twitchExtractor,
        vimeoExtractor,
        soundcloudExtractor,
        facebookExtractor,
        pinterestExtractor,
        bandcampExtractor,
        dailymotionExtractor,
        tumblrExtractor,
        threadsExtractor,
        blueskyExtractor,
        mastodonExtractor,
        snapchatExtractor,
        gdriveExtractor,
        dropboxExtractor,
        mediafireExtractor,
        megaExtractor,
        directExtractor,
        genericExtractor,
    ).associateBy { it.id }

    private val ffmpegProcessor = FfmpegMediaProcessor(executor)
    private val resolveCache = ConcurrentHashMap<String, CachedResolution>()

    override suspend fun executeTask(
        task: RemoteTask,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        onProgress: suspend (TaskProgress) -> Boolean,
    ): TaskExecutionOutcome {
        val localCancelled = AtomicBoolean(false)

        suspend fun report(percent: Double, step: String, bytesDown: Long? = null, bytesTotal: Long? = null) {
            currentCoroutineContext().ensureActive()
            val keepGoing = onProgress(
                TaskProgress(
                    percent = percent.coerceIn(0.0, 100.0),
                    step = step,
                    bytesDownloaded = bytesDown,
                    bytesTotal = bytesTotal,
                ),
            )
            if (!keepGoing) {
                localCancelled.set(true)
                throw seraError(SeraErrorCode.CANCELLED)
            }
        }

        val isCancelled: () -> Boolean = { localCancelled.get() }

        return try {
            val activeProviders = config.providers.map { it.lowercase() }.toSet()
            val requestedProvider = task.providerId.lowercase()
            val providerAllowed = activeProviders.isEmpty() ||
                requestedProvider in activeProviders ||
                ("generic" in activeProviders && requestedProvider != "youtube" && requestedProvider != "instagram")
            if (!providerAllowed) {
                throw seraError(
                    SeraErrorCode.UNSUPPORTED_SOURCE,
                    detail = "node: not configured for ${task.providerId}",
                )
            }

            val parsed = parseUserUrl(task.url, allowPrivateAddresses = config.allowPrivateAddresses)
            val detected = detectProvider(parsed.url)
            if (requestedProvider != "generic" && detected != requestedProvider) {
                throw seraError(
                    SeraErrorCode.UNSUPPORTED_SOURCE,
                    detail = "node: ${parsed.url.host} is not ${task.providerId}",
                )
            }

            val extractor = extractorFor(requestedProvider)
                ?: throw seraError(SeraErrorCode.UNSUPPORTED_SOURCE, detail = "unknown provider ${task.providerId}")

            toolsManager.ensureReady()
            val canonical = extractor.normalize(parsed.url)
            val requireSession = task.requires?.contains("instagram-session") == true

            if (task.kind == "resolve") {
                val resolved = resolveWithCache(
                    extractor = extractor,
                    canonical = canonical,
                    config = config,
                    hotConfig = hotConfig,
                    requireSession = requireSession,
                    isCancelled = isCancelled,
                )
                return TaskExecutionOutcome.Resolved(resolved.media)
            }

            runJobTask(
                task = task,
                extractor = extractor,
                canonical = canonical,
                config = config,
                hotConfig = hotConfig,
                requireSession = requireSession,
                isCancelled = isCancelled,
                report = ::report,
            )
        } catch (cancelled: CancellationException) {
            TaskExecutionOutcome.Cancelled
        } catch (error: Throwable) {
            val sera = SeraException.from(error)
            sera.toOutcome()
        }
    }

    private fun extractorFor(providerId: String): YtdlpBaseExtractor? =
        extractorsById[providerId.lowercase()]

    private suspend fun resolveWithCache(
        extractor: YtdlpBaseExtractor,
        canonical: HttpUrl,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        requireSession: Boolean,
        isCancelled: () -> Boolean,
    ): ExtractorResolveResult {
        val cacheKey = "${extractor.id}|$canonical"
        val now = System.currentTimeMillis()
        val cached = resolveCache[cacheKey]
        if (cached != null && now - cached.resolvedAtMs < RESOLVE_CACHE_TTL_MS) {
            return cached.result
        }

        val execContext = ExtractionExecutionContext(
            runtimeConfig = config,
            hotConfig = hotConfig,
            resolveTimeoutMs = (config.jobTimeoutSeconds.coerceAtMost(90) * 1000L).coerceAtLeast(30_000L),
            allowDegraded = false,
            isCancelled = isCancelled,
        )

        val result = try {
            extractor.resolve(canonical, execContext)
        } catch (error: Throwable) {
            val sera = SeraException.from(error)
            val failure = classifyFailure(sera)
            if (
                extractor.id == "instagram" &&
                !requireSession &&
                !isDefinitive(failure)
            ) {
                try {
                    extractor.resolve(canonical, execContext.copy(allowDegraded = true))
                } catch (_: Throwable) {
                    throw sera
                }
            } else if (
                extractor.id != "generic" &&
                extractor.id != "youtube" &&
                extractor.id != "instagram" &&
                sera.code == SeraErrorCode.UNSUPPORTED_SOURCE
            ) {
                try {
                    genericExtractor.resolve(canonical, execContext)
                } catch (fallbackError: Throwable) {
                    val refusal = SeraException.from(fallbackError)
                    if (refusal.detail?.startsWith("robots.txt disallows") == true) throw refusal
                    throw sera
                }
            } else {
                throw sera
            }
        }

        if (resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
            val cutoff = now - RESOLVE_CACHE_TTL_MS
            resolveCache.entries.removeIf { it.value.resolvedAtMs < cutoff }
            if (resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
                resolveCache.clear()
            }
        }
        resolveCache[cacheKey] = CachedResolution(result = result, resolvedAtMs = now)
        return result
    }

    private suspend fun runJobTask(
        task: RemoteTask,
        extractor: YtdlpBaseExtractor,
        canonical: HttpUrl,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        requireSession: Boolean,
        isCancelled: () -> Boolean,
        report: suspend (Double, String, Long?, Long?) -> Unit,
    ): TaskExecutionOutcome {
        report(0.0, "Reading the link", null, null)

        val resolveResult = resolveWithCache(
            extractor = extractor,
            canonical = canonical,
            config = config,
            hotConfig = hotConfig,
            requireSession = requireSession,
            isCancelled = isCancelled,
        )
        val resolved = resolveResult.media
        val selections = taskSelections(task, resolved.items.size)
        if (selections.isEmpty()) {
            throw seraError(SeraErrorCode.INVALID_URL, detail = "job task carried no plan keys")
        }
        val trim = validateTaskTrim(task.trim)
        val subtitles = validateTaskSubtitles(task.subtitles)
        val matched = selections.map { matchSelection(resolved, it) }
        assertWithinLimits(matched, config)

        val workRootBase = if (config.workDirPath.isNotBlank()) File(config.workDirPath) else defaultWorkRoot
        val workspaceDir = File(workRootBase, "job-${task.id}")
        val scratchDir = File(workspaceDir, "work")
        val outputDir = File(workspaceDir, "out")
        workspaceDir.deleteRecursively()
        scratchDir.mkdirs()
        outputDir.mkdirs()

        val totalFiles = matched.size
        val itemFractions = DoubleArray(totalFiles)
        var lastReportedPercent = 0.0
        val progressLock = Any()

        fun computeJobPercent(index: Int, fraction: Double): Double = synchronized(progressLock) {
            itemFractions[index] = fraction.coerceIn(0.0, 1.0)
            val sum = itemFractions.sum()
            val percent = min(99.0, max(lastReportedPercent, (sum / totalFiles.toDouble()) * 100.0))
            lastReportedPercent = percent
            percent
        }

        val itemResults = coroutineScope {
            val concurrency = min(max(1, config.preferredCapacity), totalFiles)
            val semaphore = Semaphore(concurrency)
            matched.mapIndexed { index, pair ->
                async {
                    semaphore.withPermit {
                        processSingleItem(
                            index = index,
                            item = pair.item,
                            plan = pair.plan,
                            task = task,
                            resolved = resolved,
                            rawInfoJson = resolveResult.rawInfoJson,
                            trim = trim,
                            subtitles = subtitles,
                            config = config,
                            hotConfig = hotConfig,
                            workspaceDir = workspaceDir,
                            scratchDir = scratchDir,
                            isCancelled = isCancelled,
                            onFraction = { fraction, step, down, total ->
                                val runnerPct = computeJobPercent(index, fraction)
                                val scaledPct = min(85.0, (runnerPct / 100.0) * 85.0)
                                report(scaledPct, step, down, total)
                            },
                        )
                    }
                }
            }.awaitAll()
        }

        val taken = HashSet<String>()
        val produced = ArrayList<ProducedFile>(totalFiles * 2)

        for (res in itemResults) {
            when (res) {
                is ItemExecutionResult.Subtitles -> {
                    val baseName = nameFor(task, resolved, res.item, res.plan, res.file, totalFiles)
                    val name = dedupeFilename(assertSafeFilename(subtitleName(baseName, subtitles!!.lang)), taken)
                    val dest = File(outputDir, name)
                    moveFile(res.file, dest)
                    produced.add(
                        ProducedFile(
                            name = name,
                            mimeType = mimeTypeFor(name),
                            filePath = dest.absolutePath,
                            sizeBytes = dest.length(),
                        ),
                    )
                }
                is ItemExecutionResult.Media -> {
                    val name = dedupeFilename(
                        assertSafeFilename(nameFor(task, resolved, res.item, res.usedPlan, res.file, totalFiles)),
                        taken,
                    )
                    val dest = File(outputDir, name)
                    moveFile(res.file, dest)
                    produced.add(
                        ProducedFile(
                            name = name,
                            mimeType = mimeTypeFor(name),
                            filePath = dest.absolutePath,
                            sizeBytes = dest.length(),
                        ),
                    )
                    if (res.subtitleFile != null && subtitles != null) {
                        val subExt = ".${subtitles.format}"
                        val subBase = if (Regex("""\.[^.]+$""").containsMatchIn(name)) {
                            name.replace(Regex("""\.[^.]+$"""), subExt)
                        } else {
                            "$name$subExt"
                        }
                        val subName = dedupeFilename(assertSafeFilename(subtitleName(subBase, subtitles.lang)), taken)
                        val subDest = File(outputDir, subName)
                        moveFile(res.subtitleFile, subDest)
                        produced.add(
                            ProducedFile(
                                name = subName,
                                mimeType = mimeTypeFor(subName),
                                filePath = subDest.absolutePath,
                                sizeBytes = subDest.length(),
                            ),
                        )
                    }
                }
            }
        }

        scratchDir.deleteRecursively()
        validateProduced(produced, config.maxFilesizeBytes, isCancelled)

        if (produced.isEmpty()) {
            throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "job produced no files")
        }
        return TaskExecutionOutcome.JobFiles(
            files = produced,
            cleanupDirPath = workspaceDir.absolutePath,
        )
    }

    private suspend fun processSingleItem(
        index: Int,
        item: ResolvedItem,
        plan: ResolvedPlan,
        task: RemoteTask,
        resolved: ResolvedMedia,
        rawInfoJson: String?,
        trim: RemoteTrimRange?,
        subtitles: RemoteSubtitleSpec?,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        workspaceDir: File,
        scratchDir: File,
        isCancelled: () -> Boolean,
        onFraction: suspend (Double, String, Long?, Long?) -> Unit,
    ): ItemExecutionResult {
        if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
        if (subtitles != null) assertSubtitlesOffered(item, subtitles)

        if (subtitles?.only == true) {
            onFraction(0.0, "Downloading subtitles", null, null)
            val subFile = fetchSubtitles(
                resolved = resolved,
                item = item,
                scratchDir = scratchDir,
                index = index,
                subtitles = subtitles,
                config = config,
                hotConfig = hotConfig,
                isCancelled = isCancelled,
            )
            onFraction(1.0, "Downloading subtitles", null, null)
            return ItemExecutionResult.Subtitles(index = index, file = subFile, item = item, plan = plan)
        }

        val (downloaded, usedPlan) = fetchWithFallback(
            workspaceDir = workspaceDir,
            scratchDir = scratchDir,
            resolved = resolved,
            item = item,
            requestedPlan = plan,
            index = index,
            rawInfoJson = rawInfoJson,
            trim = trim,
            embedSubtitles = subtitles?.takeIf { it.format == "embed" },
            config = config,
            hotConfig = hotConfig,
            isCancelled = isCancelled,
            onFraction = onFraction,
        )

        val converted = if (usedPlan.convert != null) {
            convertOne(
                input = downloaded,
                spec = usedPlan.convert,
                scratchDir = scratchDir,
                index = index,
                durationSeconds = item.duration,
                config = config,
                isCancelled = isCancelled,
                onFraction = onFraction,
            )
        } else {
            downloaded
        }

        val finished = if (usedPlan.kind == "audio") {
            tagOne(
                input = converted,
                resolved = resolved,
                item = item,
                scratchDir = scratchDir,
                index = index,
                config = config,
                isCancelled = isCancelled,
            )
        } else {
            converted
        }

        var subtitleFile: File? = null
        if (subtitles != null && subtitles.format != "embed") {
            onFraction(0.99, "Downloading subtitles", null, null)
            subtitleFile = fetchSubtitles(
                resolved = resolved,
                item = item,
                scratchDir = scratchDir,
                index = index,
                subtitles = subtitles,
                config = config,
                hotConfig = hotConfig,
                isCancelled = isCancelled,
            )
        }

        onFraction(1.0, "Finalizing", null, null)
        return ItemExecutionResult.Media(
            index = index,
            file = finished,
            usedPlan = usedPlan,
            item = item,
            requestedPlan = plan,
            subtitleFile = subtitleFile,
        )
    }

    private suspend fun fetchWithFallback(
        workspaceDir: File,
        scratchDir: File,
        resolved: ResolvedMedia,
        item: ResolvedItem,
        requestedPlan: ResolvedPlan,
        index: Int,
        rawInfoJson: String?,
        trim: RemoteTrimRange?,
        embedSubtitles: RemoteSubtitleSpec?,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        isCancelled: () -> Boolean,
        onFraction: suspend (Double, String, Long?, Long?) -> Unit,
    ): Pair<File, ResolvedPlan> {
        val candidates = listOf(requestedPlan) + lowerQualityAlternatives(item, requestedPlan)
        for (attempt in candidates.indices) {
            val candidate = candidates[attempt]
            try {
                val path = fetchOne(
                    workspaceDir = workspaceDir,
                    scratchDir = scratchDir,
                    resolved = resolved,
                    item = item,
                    plan = candidate,
                    index = index,
                    rawInfoJson = rawInfoJson,
                    trim = trim,
                    embedSubtitles = embedSubtitles,
                    config = config,
                    hotConfig = hotConfig,
                    isCancelled = isCancelled,
                    onFraction = onFraction,
                )
                return path to candidate
            } catch (error: Throwable) {
                val failure = classifyFailure(error)
                val hasNext = attempt + 1 < candidates.size
                if (!hasNext || failure !in FORMAT_FALLBACK_ANSWERS) throw error
            }
        }
        throw seraError(SeraErrorCode.MEDIA_UNAVAILABLE, detail = "no format could be fetched")
    }

    private suspend fun fetchOne(
        workspaceDir: File,
        scratchDir: File,
        resolved: ResolvedMedia,
        item: ResolvedItem,
        plan: ResolvedPlan,
        index: Int,
        rawInfoJson: String?,
        trim: RemoteTrimRange?,
        embedSubtitles: RemoteSubtitleSpec?,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        isCancelled: () -> Boolean,
        onFraction: suspend (Double, String, Long?, Long?) -> Unit,
    ): File {
        val itemScratch = File(scratchDir, "sel-$index")
        itemScratch.mkdirs()

        val loadInfoJsonPath: File? = if (!rawInfoJson.isNullOrEmpty()) {
            val infoDir = File(workspaceDir, "info-$index")
            infoDir.mkdirs()
            File(infoDir, "info.json").also { it.writeText(rawInfoJson, Charsets.UTF_8) }
        } else {
            null
        }

        val step = if (resolved.items.size > 1) "Downloading ${index + 1}" else "Downloading"
        onFraction(0.0, step, null, null)

        val timeoutMs = config.jobTimeoutSeconds.toLong() * 1000L

        if (plan.fetch is FetchPlan.Direct) {
            if (embedSubtitles != null) {
                throw seraError(
                    SeraErrorCode.MEDIA_UNAVAILABLE,
                    message = "Subtitles cannot be embedded in this file.",
                    detail = "embed requested on a direct download",
                )
            }
            val destination = File(itemScratch, "media.${plan.container}")
            val resultRef = AtomicReference<DirectDownloadProgress?>(null)
            httpFetcher.downloadDirect(
                url = plan.fetch.url,
                destination = destination,
                maxBytes = config.maxFilesizeBytes,
                timeoutMs = timeoutMs,
                allowPrivateAddresses = config.allowPrivateAddresses,
                isCancelled = isCancelled,
                onProgress = { progress -> resultRef.set(progress) },
            )
            resultRef.get()?.let { p ->
                val frac = if (p.bytesTotal != null && p.bytesTotal > 0L) {
                    (p.bytesDownloaded.toDouble() / p.bytesTotal.toDouble()) * DOWNLOAD_SHARE
                } else {
                    DOWNLOAD_SHARE
                }
                onFraction(frac, step, p.bytesDownloaded, p.bytesTotal)
            }
            val fetched = renameToActualFormat(destination, plan.container)
            if (trim == null) return fetched

            onFraction(DOWNLOAD_SHARE, "Trimming", null, null)
            val ext = fetched.extension.ifEmpty { plan.container }
            val trimmed = File(itemScratch, "trimmed.$ext")
            ffmpegProcessor.trimMedia(
                input = fetched,
                output = trimmed,
                range = trim,
                maxOutputBytes = config.maxFilesizeBytes,
                timeoutMs = timeoutMs,
                isCancelled = isCancelled,
            )
            fetched.delete()
            return trimmed
        }

        val fetchPlan = plan.fetch as FetchPlan.Ytdlp
        val target = fetchPlan.target ?: resolved.url
        val youtubeExtra = if (resolved.provider == "youtube") hotConfig?.youtube?.extraArgs.orEmpty() else emptyList()
        val youtubeRemoteComponents = if (resolved.provider == "youtube") {
            hotConfig?.youtube?.remoteComponents.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }
        } else {
            emptyList()
        }

        suspend fun runDownload(
            infoPath: File?,
            sections: YtdlpSectionSpec?,
            downloadCancelled: () -> Boolean,
            formatSelector: String,
        ) {
            itemScratch.deleteRecursively()
            itemScratch.mkdirs()
            var sawPostprocessor: String? = null
            var latestProgress: YtdlpProgress? = null
            var latestStep = step

            coroutineScope {
                val pumpJob = launch {
                    while (isActive) {
                        delay(250L)
                        val p = latestProgress ?: continue
                        val frac = (p.percent / 100.0) * DOWNLOAD_SHARE
                        onFraction(frac, latestStep, p.bytesDownloaded, p.bytesTotal)
                    }
                }
                try {
                    executor.download(
                        YtdlpDownloadOptions(
                            url = target,
                            format = formatSelector,
                            workdir = itemScratch,
                            outputTemplate = "media.%(ext)s",
                            timeoutMs = timeoutMs,
                            maxFilesizeBytes = config.maxFilesizeBytes,
                            extractorArgs = fetchPlan.extractorArgs.orEmpty(),
                            extraArgs = youtubeExtra,
                            remoteComponents = youtubeRemoteComponents,
                            useExtractors = fetchPlan.useExtractors,
                            mergeContainer = fetchPlan.merge,
                            remuxContainer = fetchPlan.remux,
                            audioFormat = fetchPlan.audio?.format,
                            audioQuality = fetchPlan.audio?.quality,
                            playlistItem = if (resolved.items.size > 1) item.index + 1 else null,
                            expectedTotalBytes = plan.filesizeBytes,
                            subtitles = embedSubtitles?.let { YtdlpSubtitleFilter(it.lang, it.auto) },
                            sections = sections,
                            loadInfoJsonPath = infoPath,
                            isCancelled = downloadCancelled,
                            onProgress = { progress ->
                                if (progress.postprocessor != null && progress.postprocessor != sawPostprocessor) {
                                    sawPostprocessor = progress.postprocessor
                                    latestStep = stepForPostprocessor(progress.postprocessor, plan)
                                }
                                latestProgress = progress
                            },
                        ),
                    )
                } finally {
                    pumpJob.cancel()
                }
            }
            latestProgress?.let { p ->
                val frac = (p.percent / 100.0) * DOWNLOAD_SHARE
                onFraction(frac, latestStep, p.bytesDownloaded, p.bytesTotal)
            }
        }

        suspend fun attemptFormat(
            formatSelector: String,
            sections: YtdlpSectionSpec?,
            downloadCancelled: () -> Boolean,
        ) {
            if (loadInfoJsonPath != null) {
                try {
                    runDownload(loadInfoJsonPath, sections, downloadCancelled, formatSelector)
                    return
                } catch (error: Throwable) {
                    if (downloadCancelled() || isCancelled()) throw error
                    val failure = classifyFailure(error)
                    if (
                        failure == FailureClass.STREAM_403 ||
                        failure == FailureClass.CDN_DOWNLOAD_FAILURE ||
                        failure == FailureClass.FORMAT_UNAVAILABLE ||
                        failure == FailureClass.NETWORK_ERROR
                    ) {
                        runDownload(null, sections, downloadCancelled, formatSelector)
                        return
                    }
                    throw error
                }
            }
            runDownload(null, sections, downloadCancelled, formatSelector)
        }

        val sameHeightFallback = sameHeightFallbackSelector(plan)

        suspend fun downloadWithSameHeight(
            sections: YtdlpSectionSpec? = null,
            downloadCancelled: () -> Boolean = isCancelled,
        ) {
            try {
                attemptFormat(fetchPlan.selector, sections, downloadCancelled)
            } catch (error: Throwable) {
                if (downloadCancelled() || isCancelled() || sameHeightFallback == null) throw error
                val failure = classifyFailure(error)
                if (failure !in FORMAT_FALLBACK_ANSWERS) throw error
                attemptFormat(sameHeightFallback, sections, downloadCancelled)
            }
        }

        if (trim == null) {
            downloadWithSameHeight()
            return findSingleFile(itemScratch)
        }

        val stalled = AtomicBoolean(false)
        val combinedCancelled = { isCancelled() || stalled.get() }
        val sectionOk = coroutineScope {
            val watcher = launch {
                watchDirectoryGrowth(itemScratch, SECTION_STALL_MS) { stalled.set(true) }
            }
            try {
                downloadWithSameHeight(
                    sections = YtdlpSectionSpec(
                        start = trim.start,
                        end = trim.end,
                        forceKeyframes = trim.start > 0.0,
                    ),
                    downloadCancelled = combinedCancelled,
                )
                watcher.cancel()
                val cut = findSingleFile(itemScratch)
                val probed = runCatching {
                    executor.probeMedia(cut, timeoutMs = 30_000L, isCancelled = isCancelled)
                }.getOrNull()
                if (sectionIsUsable(probed, trim, item.duration)) cut else null
            } catch (error: Throwable) {
                watcher.cancel()
                if (isCancelled()) throw error
                null
            }
        }

        if (sectionOk != null) return sectionOk

        downloadWithSameHeight()
        val full = findSingleFile(itemScratch)
        onFraction(DOWNLOAD_SHARE, "Trimming", null, null)
        val ext = full.extension.ifEmpty { plan.container }
        val trimmed = File(itemScratch, "trimmed.$ext")
        ffmpegProcessor.trimMedia(
            input = full,
            output = trimmed,
            range = trim,
            maxOutputBytes = config.maxFilesizeBytes,
            timeoutMs = timeoutMs,
            isCancelled = isCancelled,
        )
        full.delete()
        return trimmed
    }

    private suspend fun convertOne(
        input: File,
        spec: ConversionSpec,
        scratchDir: File,
        index: Int,
        durationSeconds: Double?,
        config: NodeRuntimeConfig,
        isCancelled: () -> Boolean,
        onFraction: suspend (Double, String, Long?, Long?) -> Unit,
    ): File {
        val target = targetExtension(spec)
        val output = File(File(scratchDir, "sel-$index"), "converted.$target")
        val step = "Converting to ${target.uppercase()}"
        onFraction(DOWNLOAD_SHARE, step, null, null)

        var lastPct = 0.0
        ffmpegProcessor.convert(
            input = input,
            output = output,
            spec = spec,
            durationSeconds = durationSeconds,
            maxOutputBytes = config.maxFilesizeBytes,
            timeoutMs = config.jobTimeoutSeconds.toLong() * 1000L,
            isCancelled = isCancelled,
            onProgress = { pct -> lastPct = pct },
        )
        if (lastPct > 0.0) {
            onFraction(DOWNLOAD_SHARE + (lastPct / 100.0) * (1.0 - DOWNLOAD_SHARE), step, null, null)
        }
        return output
    }

    private suspend fun tagOne(
        input: File,
        resolved: ResolvedMedia,
        item: ResolvedItem,
        scratchDir: File,
        index: Int,
        config: NodeRuntimeConfig,
        isCancelled: () -> Boolean,
    ): File {
        val ext = input.extension.lowercase()
        if (ext !in TAGGABLE_AUDIO) return input

        val dir = File(scratchDir, "sel-$index")
        val artist = item.tags?.artist ?: resolved.author
        val title = item.tags?.track ?: item.title ?: resolved.title
        val candidates = listOfNotNull(item.thumbnailUrl, item.thumbnailFallbackUrl, resolved.thumbnailUrl).distinct()

        var coverPath: File? = null
        for ((attempt, thumbnail) in candidates.withIndex()) {
            try {
                val source = File(dir, "thumbnail-$attempt.img")
                httpFetcher.downloadDirect(
                    url = thumbnail,
                    destination = source,
                    maxBytes = 10L * 1024L * 1024L,
                    timeoutMs = 30_000L,
                    allowPrivateAddresses = config.allowPrivateAddresses,
                    isCancelled = isCancelled,
                )
                val cover = File(dir, "cover.jpg")
                ffmpegProcessor.squareCover(source, cover, isCancelled = isCancelled)
                coverPath = cover
                break
            } catch (_: Throwable) {
                coverPath = null
            }
        }

        val output = File(dir, "tagged.$ext")
        return try {
            ffmpegProcessor.tagAudio(
                input = input,
                output = output,
                tags = MediaAudioTags(title = title, artist = artist, album = item.tags?.album),
                coverPath = coverPath,
                scratchDir = dir,
                timeoutMs = config.jobTimeoutSeconds.toLong() * 1000L,
                isCancelled = isCancelled,
            )
            output
        } catch (_: Throwable) {
            input
        }
    }

    private suspend fun fetchSubtitles(
        resolved: ResolvedMedia,
        item: ResolvedItem,
        scratchDir: File,
        index: Int,
        subtitles: RemoteSubtitleSpec,
        config: NodeRuntimeConfig,
        hotConfig: ProviderHotConfig?,
        isCancelled: () -> Boolean,
    ): File {
        val subDir = File(scratchDir, "subs-$index")
        subDir.mkdirs()
        val youtubeExtra = if (resolved.provider == "youtube") hotConfig?.youtube?.extraArgs.orEmpty() else emptyList()
        val youtubeRemoteComponents = if (resolved.provider == "youtube") {
            hotConfig?.youtube?.remoteComponents.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }
        } else {
            emptyList()
        }
        return executor.downloadSubtitles(
            YtdlpSubtitleOptions(
                url = resolved.url,
                workdir = subDir,
                lang = subtitles.lang,
                auto = subtitles.auto,
                format = if (subtitles.format == "vtt") "vtt" else "srt",
                timeoutMs = min(config.jobTimeoutSeconds.toLong() * 1000L, 120_000L),
                playlistItem = if (resolved.items.size > 1) item.index + 1 else null,
                extraArgs = youtubeExtra,
                remoteComponents = youtubeRemoteComponents,
                isCancelled = isCancelled,
            ),
        )
    }

    private suspend fun validateProduced(
        produced: List<ProducedFile>,
        maxFilesizeBytes: Long,
        isCancelled: () -> Boolean,
    ) {
        var totalBytes = 0L
        for (fileInfo in produced) {
            val file = File(fileInfo.filePath)
            if (!file.exists() || file.length() == 0L) {
                throw seraError(
                    SeraErrorCode.CONVERSION_FAILED,
                    message = "The download finished but produced an empty file.",
                    detail = "empty output: ${fileInfo.name}",
                )
            }
            val size = file.length()
            if (size > maxFilesizeBytes) {
                throw seraError(
                    SeraErrorCode.TOO_LARGE,
                    message = "The converted file is larger than this server allows.",
                    detail = "$size bytes: ${fileInfo.name}",
                )
            }
            totalBytes += size
            if (totalBytes > maxFilesizeBytes) {
                throw seraError(
                    SeraErrorCode.TOO_LARGE,
                    message = "The output exceeds the maximum allowed size.",
                    hint = "Try a lower quality or fewer items.",
                    detail = "$totalBytes total bytes across ${produced.size} items",
                )
            }

            val ext = fileInfo.name.substringAfterLast('.', "").lowercase()
            if (ext != "srt" && ext != "vtt") {
                val head = headOf(file)
                val imposter = sniffTextImposter(head)
                if (imposter != null) {
                    throw seraError(
                        SeraErrorCode.MEDIA_UNAVAILABLE,
                        message = "The source returned a page instead of the media.",
                        hint = "The post may have become private, or the site may be asking for a login.",
                        detail = "${fileInfo.name} is $imposter, not media",
                    )
                }
                if (isExecutableHeader(head)) {
                    throw seraError(
                        SeraErrorCode.MEDIA_UNAVAILABLE,
                        message = "The source returned an unexpected file type instead of media.",
                        detail = "${fileInfo.name} has an executable header",
                    )
                }
            }
            if (ext in VALIDATED_AUDIO_VIDEO_EXTS) {
                val probed = runCatching {
                    executor.probeMedia(file, timeoutMs = 30_000L, isCancelled = isCancelled)
                }.getOrNull()
                if (isCancelled()) throw seraError(SeraErrorCode.CANCELLED)
                if (probed?.durationSeconds != null && probed.durationSeconds <= 0.0) {
                    throw seraError(
                        SeraErrorCode.CONVERSION_FAILED,
                        message = "The download finished but the file has no playable content.",
                        detail = "zero duration: ${fileInfo.name}",
                    )
                }
                if (probed == null || (probed.video == null && probed.audio == null)) {
                    throw seraError(
                        SeraErrorCode.CONVERSION_FAILED,
                        message = "The download finished but the file could not be verified.",
                        detail = "unreadable output: ${fileInfo.name}",
                    )
                }
            }
        }
    }

    private fun nameFor(
        task: RemoteTask,
        resolved: ResolvedMedia,
        item: ResolvedItem,
        plan: ResolvedPlan,
        producedFile: File,
        totalFiles: Int,
    ): String {
        val ext = producedFile.extension.lowercase().ifEmpty { plan.container }
        val suffix = task.trim?.let { trimSuffix(it, item.duration) }.orEmpty()
        if (!task.filename.isNullOrBlank() && totalFiles == 1) {
            return "${sanitizeStem(task.filename)}$suffix.$ext"
        }
        val name = mediaFilename(
            author = resolved.author,
            title = item.title ?: resolved.title,
            container = ext,
            index = if (totalFiles > 1 || resolved.items.size > 1) item.index + 1 else null,
        )
        if (suffix.isEmpty()) return name
        val dot = name.lastIndexOf('.')
        return if (dot > 0) "${name.substring(0, dot)}$suffix${name.substring(dot)}" else "$name$suffix"
    }
}

fun taskSelections(task: RemoteTask, itemCount: Int): List<TaskSelection> {
    val keys = task.planKeys.orEmpty()
    val items = task.items
    return keys.mapIndexed { position, key ->
        val item = if (items != null && items.size == keys.size) items[position] else null
        if (item != null) {
            TaskSelection(itemIndex = item.index, sourceId = item.sourceId, planKey = key)
        } else {
            TaskSelection(
                itemIndex = if (itemCount > position) position else 0,
                planKey = key,
            )
        }
    }
}

fun matchSelection(resolved: ResolvedMedia, selection: TaskSelection): MatchedSelection {
    val item = (if (!selection.sourceId.isNullOrEmpty()) {
        resolved.items.firstOrNull { it.sourceId == selection.sourceId }
    } else {
        null
    }) ?: resolved.items.getOrNull(selection.itemIndex)

    if (item == null) {
        throw seraError(
            SeraErrorCode.EXPIRED,
            message = "That item is no longer part of this post.",
            detail = "item ${selection.itemIndex} not found among ${resolved.items.size}",
        )
    }

    val plan = item.plans.firstOrNull { planKey(it) == selection.planKey }
        ?: throw seraError(
            SeraErrorCode.EXPIRED,
            message = "The quality you chose is no longer available.",
            hint = "Analyze the link again to see the current options.",
            detail = "plan ${selection.planKey} missing",
        )
    return MatchedSelection(item = item, plan = plan)
}

fun validateTaskTrim(trim: RemoteTrimRange?): RemoteTrimRange? {
    if (trim == null) return null
    val valid = trim.start.isFinite() &&
        trim.start >= 0.0 &&
        (trim.end == null || (trim.end.isFinite() && trim.end > trim.start))
    if (!valid) throw seraError(SeraErrorCode.INVALID_URL, detail = "node: malformed trim")
    return trim
}

fun validateTaskSubtitles(subtitles: RemoteSubtitleSpec?): RemoteSubtitleSpec? {
    if (subtitles == null) return null
    val valid = VALID_SUBTITLE_LANG.matches(subtitles.lang) &&
        subtitles.format in setOf("srt", "vtt", "embed") &&
        !(subtitles.only && subtitles.format == "embed")
    if (!valid) throw seraError(SeraErrorCode.INVALID_URL, detail = "node: malformed subtitles")
    return subtitles
}

private fun assertWithinLimits(matched: List<MatchedSelection>, config: NodeRuntimeConfig) {
    var total = 0L
    for ((item, plan) in matched) {
        if (item.isLive == true) throw seraError(SeraErrorCode.LIVE_IN_PROGRESS)
        val duration = item.duration
        if (duration != null && duration > DEFAULT_MAX_DURATION_SECONDS) {
            throw seraError(
                SeraErrorCode.TOO_LONG,
                message = "This server accepts media up to ${DEFAULT_MAX_DURATION_SECONDS / 60} minutes.",
                detail = "${duration.roundToLong()}s exceeds limit",
            )
        }
        total += plan.filesizeBytes ?: 0L
    }
    if (total > config.maxFilesizeBytes) {
        throw seraError(
            SeraErrorCode.TOO_LARGE,
            detail = "$total bytes across ${matched.size} items",
        )
    }
}

private fun assertSubtitlesOffered(item: ResolvedItem, subtitles: RemoteSubtitleSpec) {
    val offered = item.subtitles.orEmpty().any { track ->
        track.lang == subtitles.lang && (track.auto == true) == subtitles.auto
    }
    if (!offered) {
        throw seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "Those subtitles are not available any more.",
            detail = "subtitles ${subtitles.lang}${if (subtitles.auto) " (auto)" else ""} not offered",
        )
    }
}

fun sameHeightFallbackSelector(plan: ResolvedPlan): String? {
    if (plan.kind != "video") return null
    val h = plan.height ?: return null
    val ytdlp = plan.fetch as? FetchPlan.Ytdlp ?: return null
    val selector = ytdlp.selector.trim()
    if (Regex("""\b(?:best|worst)(?:video|audio)?\b""", RegexOption.IGNORE_CASE).containsMatchIn(selector)) {
        return null
    }

    val plus = selector.indexOf('+')
    val rawAudioId = if (plus >= 0) selector.substring(plus + 1).trim() else null
    val audioId = rawAudioId?.takeIf { VALID_AUDIO_ID.matches(it) }

    if (plan.container == "mov") {
        val vCodec = "[vcodec~='^(avc|h264|hev|hvc)']"
        val aCodec = "[acodec~='^(mp4a|aac|ac-3|ec-3)']"
        return if (audioId != null) {
            listOf(
                "bestvideo[height=$h][protocol^=http]$vCodec+$audioId",
                "bestvideo[height=$h][protocol^=http]$vCodec+bestaudio[protocol^=http]$aCodec",
                "best[height=$h][protocol^=http]$vCodec",
                "bestvideo[height=$h]$vCodec+$audioId",
                "bestvideo[height=$h]$vCodec+bestaudio$aCodec",
                "best[height=$h]$vCodec",
            ).joinToString("/")
        } else {
            listOf(
                "best[height=$h][protocol^=http]$vCodec",
                "bestvideo[height=$h][protocol^=http]$vCodec",
                "best[height=$h]$vCodec",
                "bestvideo[height=$h]$vCodec",
            ).joinToString("/")
        }
    }

    if (plan.container == "webm") {
        val vCodec = "[vcodec~='^(vp9|vp09|vp8|av01)']"
        return if (audioId != null) {
            listOf(
                "bestvideo[height=$h][protocol^=http]$vCodec+$audioId",
                "bestvideo[height=$h][protocol^=http]$vCodec+bestaudio[protocol^=http][acodec=opus]",
                "bestvideo[height=$h][protocol^=http]+bestaudio[protocol^=http][acodec=opus]",
                "bestvideo[height=$h][protocol^=http]+bestaudio[protocol^=http]",
                "best[height=$h][protocol^=http]",
                "bestvideo[height=$h]+$audioId",
                "bestvideo[height=$h]+bestaudio",
                "best[height=$h]",
            ).joinToString("/")
        } else {
            listOf(
                "best[height=$h][protocol^=http]$vCodec",
                "best[height=$h][protocol^=http]",
                "bestvideo[height=$h][protocol^=http]$vCodec",
                "bestvideo[height=$h][protocol^=http]",
                "best[height=$h]",
                "bestvideo[height=$h]",
            ).joinToString("/")
        }
    }

    return if (audioId != null) {
        listOf(
            "bestvideo[height=$h][protocol^=http][vcodec^=avc]+$audioId",
            "bestvideo[height=$h][protocol^=http][ext=mp4]+$audioId",
            "bestvideo[height=$h][protocol^=http]+$audioId",
            "bestvideo[height=$h][protocol^=http][vcodec^=avc]+bestaudio[protocol^=http][acodec^=mp4a]",
            "bestvideo[height=$h][protocol^=http][ext=mp4]+bestaudio[protocol^=http][acodec^=mp4a]",
            "bestvideo[height=$h][protocol^=http]+bestaudio[protocol^=http][acodec^=mp4a]",
            "best[height=$h][protocol^=http][ext=mp4]",
            "best[height=$h][protocol^=http]",
            "bestvideo[height=$h]+$audioId",
            "bestvideo[height=$h]+bestaudio[acodec^=mp4a]",
            "bestvideo[height=$h]+bestaudio",
            "best[height=$h]",
        ).joinToString("/")
    } else {
        listOf(
            "best[height=$h][protocol^=http][ext=mp4]",
            "best[height=$h][protocol^=http]",
            "bestvideo[height=$h][protocol^=http][vcodec^=avc]+bestaudio[protocol^=http][acodec^=mp4a]",
            "bestvideo[height=$h][protocol^=http]+bestaudio[protocol^=http][acodec^=mp4a]",
            "bestvideo[height=$h][protocol^=http]",
            "best[height=$h]",
            "bestvideo[height=$h]+bestaudio",
            "bestvideo[height=$h]",
        ).joinToString("/")
    }
}

fun lowerQualityAlternatives(item: ResolvedItem, chosen: ResolvedPlan): List<ResolvedPlan> {
    val ceiling = chosen.height ?: Int.MAX_VALUE
    val chosenKey = planKey(chosen)
    return item.plans
        .filter { plan ->
            plan !== chosen &&
                plan.kind == chosen.kind &&
                planKey(plan) != chosenKey &&
                (plan.height ?: 0) < ceiling
        }
        .sortedByDescending { it.height ?: 0 }
        .take(2)
}

fun sectionIsUsable(
    probed: FfprobeResult?,
    range: RemoteTrimRange,
    itemDuration: Double? = null,
): Boolean {
    if (probed == null || (probed.video == null && probed.audio == null)) return false
    val end = range.end ?: itemDuration
    if (end == null) return probed.durationSeconds == null || probed.durationSeconds > 0.0
    val actual = probed.durationSeconds ?: return false
    val expected = end - range.start
    return kotlin.math.abs(actual - expected) <= max(1.0, expected * 0.1)
}

private suspend fun CoroutineScope.watchDirectoryGrowth(
    directory: File,
    stallMs: Long,
    onStall: () -> Unit,
) {
    var lastSize = -1L
    var since = System.currentTimeMillis()
    val pollMs = min(1_000L, max(50L, stallMs / 4L))
    while (isActive) {
        delay(pollMs)
        val current = directory.listFiles()
            ?.filter { it.isFile }
            ?.sumOf { it.length() }
            ?: 0L
        if (current != lastSize) {
            lastSize = current
            since = System.currentTimeMillis()
        } else if (System.currentTimeMillis() - since >= stallMs) {
            onStall()
            return
        }
    }
}

private fun findSingleFile(directory: File): File {
    val files = directory.listFiles()
        ?.filter { entry ->
            entry.isFile &&
                !entry.name.endsWith(".part") &&
                !entry.name.endsWith(".tmp") &&
                entry.name != "info.json" &&
                !entry.name.endsWith(".info.json")
        }
        .orEmpty()
    if (files.isEmpty()) {
        throw seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "The download completed without producing a file.",
            detail = "empty scratch dir ${directory.absolutePath}",
        )
    }
    if (files.size == 1) return files[0]
    return files.maxByOrNull { it.length() } ?: files[0]
}

private fun renameToActualFormat(path: File, claimed: String): File {
    val head = headOf(path)
    if (head.isEmpty()) return path
    val actual = sniffContainer(head)
    if (actual == "exe" && claimed != "exe") {
        throw seraError(
            SeraErrorCode.MEDIA_UNAVAILABLE,
            message = "The source returned an unexpected file type instead of media.",
            detail = "downloaded payload has executable PE header",
        )
    }
    if (actual == null || !contradicts(claimed, actual)) return path
    val base = path.name.substringBeforeLast('.', path.name)
    val corrected = File(path.parentFile, "$base.$actual")
    return if (path.renameTo(corrected)) corrected else path
}

private fun moveFile(source: File, destination: File) {
    destination.parentFile?.mkdirs()
    try {
        Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
    } catch (_: Exception) {
        source.copyTo(destination, overwrite = true)
        source.delete()
    }
}

private fun targetExtension(spec: ConversionSpec): String =
    when (spec) {
        is ConversionSpec.Audio -> spec.container
        is ConversionSpec.Remux -> spec.container
        is ConversionSpec.Video -> spec.container
        is ConversionSpec.Gif -> "gif"
    }

private fun stepForPostprocessor(name: String, plan: ResolvedPlan): String =
    when (name) {
        "Merger" -> "Merging video and audio"
        "ExtractAudio" -> "Converting to ${plan.container.uppercase()}"
        "VideoRemuxer" -> "Remuxing to ${plan.container.uppercase()}"
        "MoveFiles" -> "Finishing up"
        else -> "Processing"
    }
