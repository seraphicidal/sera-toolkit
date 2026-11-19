package dev.sera.node.service

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import dev.sera.node.BuildConfig
import dev.sera.node.ServiceLocator
import dev.sera.node.data.ClaimOutcome
import dev.sera.node.data.FatalAuthException
import dev.sera.node.data.NodeSettings
import dev.sera.node.data.TaskCancelledException
import dev.sera.node.data.UploadOffsetMismatchException
import dev.sera.node.model.ClaimRequest
import dev.sera.node.model.FailedRequest
import dev.sera.node.model.NetworkTransport
import dev.sera.node.model.ProducedFile
import dev.sera.node.model.ProgressRequest
import dev.sera.node.model.RemoteTask
import dev.sera.node.model.TaskExecutionOutcome
import dev.sera.node.model.TaskProgress
import dev.sera.node.updater.UpdateCoordinator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class NodeForegroundService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val isPaused = AtomicBoolean(false)
    private val isCharging = AtomicBoolean(false)
    private val activeClaimCall = AtomicReference<Call?>(null)
    private val activeTasks = ConcurrentHashMap<String, Job>()
    private val wakeSignal = Channel<Unit>(Channel.CONFLATED)

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var mainLoopJob: Job? = null
    private var periodicUpdateJob: Job? = null
    private var batteryReceiverRegistered = false

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            refreshChargingState(intent)
            signalLoopWake()
        }
    }

    override fun onCreate() {
        super.onCreate()
        val notifications = ServiceLocator.notificationManager(this)
        val tracker = ServiceLocator.runtimeTracker()
        notifications.ensureChannels()
        val initialSnapshot = tracker.snapshot.value.copy(
            serviceState = NodeServiceState.STARTING,
            startedAtMs = System.currentTimeMillis(),
        )
        tracker.update { initialSnapshot }
        startForegroundWithType(notifications.buildStatusNotification(initialSnapshot, 0L, isPaused = false))

        ServiceLocator.connectivityMonitor(this).start()
        registerBatteryObserver()
        acquireWakeLock()
        observeNetworkAndSettings()
        startMainLoops()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                serviceScope.launch {
                    ServiceLocator.preferences(this@NodeForegroundService)
                        .setServiceEnabled(enabled = false, explicitStop = true)
                    stopSelf()
                }
                return START_NOT_STICKY
            }

            ACTION_PAUSE -> {
                isPaused.set(true)
                activeClaimCall.get()?.cancel()
                releaseWifiLock()
                signalLoopWake()
                refreshNotification()
                return START_STICKY
            }

            ACTION_RESUME -> {
                isPaused.set(false)
                signalLoopWake()
                refreshNotification()
                return START_STICKY
            }

            ACTION_CHECK_UPDATES -> {
                serviceScope.launch {
                    ServiceLocator.updateCoordinator(this@NodeForegroundService)
                        .checkAndApplyUpdates(force = true, allowAppInstall = true)
                    refreshNotification()
                }
                return START_STICKY
            }

            else -> {
                isPaused.set(false)
                serviceScope.launch {
                    ServiceLocator.preferences(this@NodeForegroundService)
                        .setServiceEnabled(enabled = true, explicitStop = false)
                }
                signalLoopWake()
                return START_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        activeClaimCall.get()?.cancel()
        mainLoopJob?.cancel()
        periodicUpdateJob?.cancel()
        activeTasks.values.forEach { it.cancel() }
        activeTasks.clear()
        unregisterBatteryObserver()
        releaseWifiLock()
        releaseWakeLock()
        ServiceLocator.connectivityMonitor(this).stop()
        ServiceLocator.runtimeTracker().resetStopped()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun startForegroundWithType(notification: android.app.Notification) {
        val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(
            this,
            NodeNotificationManager.STATUS_NOTIFICATION_ID,
            notification,
            fgsType,
        )
    }

    private fun observeNetworkAndSettings() {
        val connectivity = ServiceLocator.connectivityMonitor(this)
        val tracker = ServiceLocator.runtimeTracker()
        val preferences = ServiceLocator.preferences(this)

        serviceScope.launch {
            connectivity.networkState.collectLatest { net ->
                tracker.update {
                    it.copy(
                        transport = net.transport,
                        isConnected = net.isConnected,
                    )
                }
                syncWifiLock(net.transport == NetworkTransport.WIFI && net.isConnected && !isPaused.get())
                refreshNotification()
                signalLoopWake()
            }
        }

        serviceScope.launch {
            connectivity.handoffEvents.collect { net ->
                ServiceLocator.logStore(this@NodeForegroundService)
                    .info("NET", "Network handoff detected -> ${net.transport.displayLabel} (epoch ${net.epoch})")
                activeClaimCall.get()?.cancel()
                signalLoopWake()
            }
        }

        serviceScope.launch {
            preferences.settings.collectLatest {
                refreshNotification()
                signalLoopWake()
            }
        }
    }

    private fun startMainLoops() {
        val logStore = ServiceLocator.logStore(this)
        val preferences = ServiceLocator.preferences(this)
        val connectivity = ServiceLocator.connectivityMonitor(this)
        val apiClient = ServiceLocator.apiClient(this)
        val toolsManager = ServiceLocator.toolsManager(this)
        val updateCoordinator = ServiceLocator.updateCoordinator(this)
        val tracker = ServiceLocator.runtimeTracker()

        periodicUpdateJob = serviceScope.launch {
            runCatching { toolsManager.ensureReady() }
            updateCoordinator.refreshToolsStatus()
            val settings = preferences.current()
            if (settings.autoUpdateTools || settings.autoUpdateApp) {
                updateCoordinator.checkAndApplyUpdates(force = false, allowAppInstall = settings.autoUpdateApp)
            }
            while (isActive) {
                delay(UpdateCoordinator.UPDATE_CHECK_INTERVAL_MS)
                val latest = preferences.current()
                if (latest.autoUpdateTools || latest.autoUpdateApp) {
                    updateCoordinator.checkAndApplyUpdates(force = false, allowAppInstall = latest.autoUpdateApp)
                }
            }
        }

        mainLoopJob = serviceScope.launch {
            runCatching { toolsManager.ensureReady() }
                .onFailure { logStore.warn("YTDLP", "Initial tool setup warning: ${it.message}") }

            var consecutiveErrors = 0
            var authFailures = 0

            while (isActive) {
                val settings = preferences.current()
                val capacity = settings.preferredCapacity.coerceIn(1, 8)
                if (activeTasks.size >= capacity) {
                    withTimeoutOrNull(2_000L) { wakeSignal.receive() }
                    continue
                }

                val netState = connectivity.refreshNow()
                val blocked = NodeServicePolicy.evaluateBlockingCondition(
                    isConfigured = settings.isConfigured,
                    isPaused = isPaused.get(),
                    networkState = netState,
                    allowWifi = settings.allowWifi,
                    allowCellular = settings.allowCellular,
                    onlyWhileCharging = settings.onlyWhileCharging,
                    isCharging = isCharging.get(),
                )

                if (blocked != null) {
                    val activeState = if (activeTasks.isNotEmpty()) NodeServiceState.RUNNING_TASK else blocked
                    tracker.update {
                        it.copy(
                            serviceState = activeState,
                            isCharging = isCharging.get(),
                        )
                    }
                    refreshNotification()
                    withTimeoutOrNull(5_000L) { wakeSignal.receive() }
                    continue
                }

                val toolsInfo = runCatching { toolsManager.getToolsVersions() }.getOrNull()
                val activeProviders = settings.activeProviders()
                if (activeProviders.isEmpty()) {
                    tracker.update {
                        it.copy(
                            serviceState = NodeServiceState.UNCONFIGURED,
                            lastError = "Enable at least one provider (YouTube or Instagram)",
                        )
                    }
                    refreshNotification()
                    withTimeoutOrNull(5_000L) { wakeSignal.receive() }
                    continue
                }

                tracker.update {
                    it.copy(
                        serviceState = if (activeTasks.isNotEmpty()) NodeServiceState.RUNNING_TASK else NodeServiceState.IDLE_POLLING,
                        isCharging = isCharging.get(),
                        lastError = null,
                    )
                }
                refreshNotification()

                val claimReq = ClaimRequest(
                    nodeId = settings.nodeId.ifBlank { "android-node" },
                    providers = activeProviders,
                    capacity = capacity,
                    networkClass = "residential",
                    features = NodeServicePolicy.buildNodeFeatures(settings.instagramSessionId),
                    transport = netState.transport.wireValue,
                    appVersion = BuildConfig.VERSION_NAME,
                    ytdlpVersion = toolsInfo?.ytdlpVersion,
                    ffmpegVersion = toolsInfo?.ffmpegVersion,
                )

                try {
                    val outcome = apiClient.claim(
                        baseUrl = settings.apiBaseUrl,
                        token = settings.nodeToken,
                        requestPayload = claimReq,
                        onActiveCall = { call -> activeClaimCall.set(call) },
                    )
                    consecutiveErrors = 0
                    authFailures = 0
                    tracker.update { it.copy(authFailureCount = 0, lastError = null) }

                    when (outcome) {
                        is ClaimOutcome.NoTask -> {
                            outcome.manifestHash?.let { hash ->
                                serviceScope.launch { updateCoordinator.onManifestHashObserved(hash) }
                            }
                            val sleepMs = NodeServicePolicy.shouldIdleSleepMs(outcome.elapsedMs)
                            if (sleepMs > 0L) {
                                withTimeoutOrNull(sleepMs) { wakeSignal.receive() }
                            }
                        }

                        is ClaimOutcome.Task -> {
                            outcome.manifestHash?.let { hash ->
                                serviceScope.launch { updateCoordinator.onManifestHashObserved(hash) }
                            }
                            launchTaskExecution(outcome.task, settings)
                        }
                    }
                } catch (cancelled: CancellationException) {
                    if (!isActive) throw cancelled
                    logStore.debug("NET", "Claim poll interrupted; re-evaluating connection")
                } catch (authError: FatalAuthException) {
                    authFailures += 1
                    logStore.error("NODE", "Token rejected (${authError.statusCode}), failure $authFailures/${NodeServicePolicy.MAX_AUTH_FAILURES}")
                    tracker.update {
                        it.copy(
                            serviceState = NodeServiceState.AUTH_ERROR,
                            authFailureCount = authFailures,
                            lastError = "Authentication rejected (${authError.statusCode}). Verify Node Token.",
                        )
                    }
                    refreshNotification()
                    if (authFailures >= NodeServicePolicy.MAX_AUTH_FAILURES) {
                        logStore.error("NODE", "Stopping node after repeated authentication rejections")
                        preferences.setServiceEnabled(enabled = false, explicitStop = false)
                        stopSelf()
                        break
                    }
                    withTimeoutOrNull(NodeServicePolicy.AUTH_BACKOFF_MS) { wakeSignal.receive() }
                } catch (error: Exception) {
                    consecutiveErrors += 1
                    val backoffMs = NodeServicePolicy.computeRetryBackoffMs(consecutiveErrors)
                    logStore.warn("NODE", "Claim error (${error.message}); retrying in ${backoffMs / 1000}s")
                    tracker.update {
                        it.copy(
                            serviceState = if (activeTasks.isNotEmpty()) NodeServiceState.RUNNING_TASK else NodeServiceState.RECONNECTING,
                            lastError = error.message ?: "Connection error",
                        )
                    }
                    refreshNotification()
                    withTimeoutOrNull(backoffMs) { wakeSignal.receive() }
                }
            }
        }
    }

    private fun launchTaskExecution(task: RemoteTask, settings: NodeSettings) {
        val logStore = ServiceLocator.logStore(this)
        val tracker = ServiceLocator.runtimeTracker()
        val apiClient = ServiceLocator.apiClient(this)
        val taskRunner = ServiceLocator.taskRunner(this)
        val preferences = ServiceLocator.preferences(this)
        val connectivity = ServiceLocator.connectivityMonitor(this)

        val job = serviceScope.launch {
            val workRoot = File(cacheDir, "work/${task.id}")
            val runtimeConfig = settings.toRuntimeConfig(workRoot.absolutePath)
            val currentPercent = AtomicReference(0.0)
            val currentStep = AtomicReference("Working")
            val currentBytesDown = AtomicReference<Long?>(null)
            val currentBytesTotal = AtomicReference<Long?>(null)
            val lastProgressSentAt = AtomicLong(0L)
            val cancelledByServer = AtomicBoolean(false)

            tracker.upsertTask(
                ActiveTaskInfo(
                    taskId = task.id,
                    kind = task.kind,
                    providerId = task.providerId,
                    step = "Working",
                    percent = 0.0,
                ),
            )
            tracker.update { it.copy(serviceState = NodeServiceState.RUNNING_TASK) }
            refreshNotification()
            logStore.info("NODE", "Claimed ${task.kind} task ${task.id.take(8)} (${task.providerId})")

            val selfJob = coroutineContext[Job]!!

            suspend fun pushProgressNow(
                percent: Double,
                step: String,
                bytesDown: Long?,
                bytesTotal: Long?,
            ): Boolean {
                if (cancelledByServer.get()) return false
                lastProgressSentAt.set(System.currentTimeMillis())
                val response = runCatching {
                    apiClient.reportProgress(
                        baseUrl = settings.apiBaseUrl,
                        token = settings.nodeToken,
                        taskId = task.id,
                        progress = ProgressRequest(
                            percent = percent.coerceIn(0.0, 100.0),
                            step = step.ifBlank { "Working" },
                            bytesDownloaded = bytesDown,
                            bytesTotal = bytesTotal,
                        ),
                    )
                }.getOrNull()

                if (response?.cancelled == true) {
                    cancelledByServer.set(true)
                    logStore.warn("NODE", "Server cancelled task ${task.id.take(8)}")
                    selfJob.cancel(CancellationException("Server cancelled task"))
                    return false
                }
                return true
            }

            val heartbeatJob = launch {
                while (isActive && !cancelledByServer.get()) {
                    delay(NodeServicePolicy.PROGRESS_HEARTBEAT_MS)
                    pushProgressNow(
                        currentPercent.get(),
                        currentStep.get(),
                        currentBytesDown.get(),
                        currentBytesTotal.get(),
                    )
                }
            }

            val onProgress: suspend (TaskProgress) -> Boolean = { update ->
                if (cancelledByServer.get()) {
                    false
                } else {
                    val prevStep = currentStep.getAndSet(update.step)
                    currentPercent.set(update.percent)
                    currentBytesDown.set(update.bytesDownloaded)
                    currentBytesTotal.set(update.bytesTotal)

                    tracker.upsertTask(
                        ActiveTaskInfo(
                            taskId = task.id,
                            kind = task.kind,
                            providerId = task.providerId,
                            step = update.step,
                            percent = update.percent,
                            bytesDownloaded = update.bytesDownloaded,
                            bytesTotal = update.bytesTotal,
                        ),
                    )
                    refreshNotification()

                    val now = System.currentTimeMillis()
                    if (prevStep != update.step || now - lastProgressSentAt.get() >= NodeServicePolicy.PROGRESS_THROTTLE_MS) {
                        pushProgressNow(update.percent, update.step, update.bytesDownloaded, update.bytesTotal)
                    } else {
                        true
                    }
                }
            }

            try {
                val hotConfig = preferences.current().cachedProviderHotConfig
                when (val outcome = taskRunner.executeTask(task, runtimeConfig, hotConfig, onProgress)) {
                    is TaskExecutionOutcome.Resolved -> {
                        apiClient.submitResolved(
                            baseUrl = settings.apiBaseUrl,
                            token = settings.nodeToken,
                            taskId = task.id,
                            media = outcome.media,
                        )
                        preferences.recordTaskCompleted()
                        tracker.update { it.copy(completedTasksSession = it.completedTasksSession + 1L) }
                        logStore.info("NODE", "Completed resolve task ${task.id.take(8)} (${outcome.media.items.size} items)")
                    }

                    is TaskExecutionOutcome.JobFiles -> {
                        try {
                            val totalBytes = outcome.files.sumOf { it.sizeBytes }
                            val uploadedCounter = AtomicLong(0L)
                            onProgress(TaskProgress(85.0, "Uploading", 0L, totalBytes))

                            val semaphore = Semaphore(2)
                            outcome.files.map { produced ->
                                async {
                                    semaphore.withPermit {
                                        uploadFileWithRetry(
                                            settings = settings,
                                            taskId = task.id,
                                            produced = produced,
                                            apiClient = apiClient,
                                            connectivity = connectivity,
                                            logStore = logStore,
                                            isCancelled = { cancelledByServer.get() },
                                        ) { delta ->
                                            val totalUploaded = uploadedCounter.addAndGet(delta)
                                            val frac = if (totalBytes > 0L) {
                                                totalUploaded.toDouble() / totalBytes.toDouble()
                                            } else {
                                                1.0
                                            }
                                            val pct = (85.0 + frac * 14.0).coerceIn(85.0, 99.0)
                                            currentPercent.set(pct)
                                            currentStep.set("Uploading")
                                            currentBytesDown.set(totalUploaded)
                                            currentBytesTotal.set(totalBytes)
                                        }
                                    }
                                }
                            }.awaitAll()

                            if (cancelledByServer.get()) throw TaskCancelledException()
                            apiClient.completeTask(settings.apiBaseUrl, settings.nodeToken, task.id)
                            preferences.recordTaskCompleted()
                            tracker.update { it.copy(completedTasksSession = it.completedTasksSession + 1L) }
                            logStore.info("NODE", "Completed job task ${task.id.take(8)} (${outcome.files.size} files)")
                        } finally {
                            outcome.cleanupDirPath?.let { path ->
                                runCatching { File(path).deleteRecursively() }
                            }
                        }
                    }

                    is TaskExecutionOutcome.Failed -> {
                        logStore.warn("NODE", "Task ${task.id.take(8)} failed (${outcome.code}): ${outcome.message}")
                        runCatching {
                            apiClient.failTask(
                                baseUrl = settings.apiBaseUrl,
                                token = settings.nodeToken,
                                taskId = task.id,
                                failure = FailedRequest(
                                    code = outcome.code,
                                    message = outcome.message,
                                    detail = outcome.detail,
                                ),
                            )
                        }
                        preferences.recordTaskFailed()
                    }

                    is TaskExecutionOutcome.Cancelled -> {
                        logStore.info("NODE", "Task ${task.id.take(8)} cancelled")
                        if (!cancelledByServer.get()) {
                            runCatching {
                                apiClient.failTask(
                                    baseUrl = settings.apiBaseUrl,
                                    token = settings.nodeToken,
                                    taskId = task.id,
                                    failure = FailedRequest(code = "CANCELLED", message = "Task cancelled"),
                                )
                            }
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                logStore.info("NODE", "Task ${task.id.take(8)} aborted")
                throw cancelled
            } catch (_: TaskCancelledException) {
                logStore.info("NODE", "Task ${task.id.take(8)} cancelled during upload")
            } catch (error: Exception) {
                logStore.error("NODE", "Task ${task.id.take(8)} threw error: ${error.message}")
                runCatching {
                    apiClient.failTask(
                        baseUrl = settings.apiBaseUrl,
                        token = settings.nodeToken,
                        taskId = task.id,
                        failure = FailedRequest(
                            code = "PROVIDER_UNAVAILABLE",
                            message = error.message ?: "Task failed",
                            detail = error.javaClass.simpleName,
                        ),
                    )
                }
                preferences.recordTaskFailed()
            } finally {
                heartbeatJob.cancel()
                runCatching { workRoot.deleteRecursively() }
                tracker.removeTask(task.id)
                activeTasks.remove(task.id)
                refreshNotification()
                signalLoopWake()
            }
        }

        activeTasks[task.id] = job
        signalLoopWake()
    }

    private suspend fun uploadFileWithRetry(
        settings: NodeSettings,
        taskId: String,
        produced: ProducedFile,
        apiClient: dev.sera.node.data.SeraNodeApiClient,
        connectivity: dev.sera.node.net.ConnectivityMonitor,
        logStore: dev.sera.node.data.NodeLogStore,
        isCancelled: () -> Boolean,
        onBytesDelta: (Long) -> Unit,
    ) {
        val file = File(produced.filePath)
        val fileSize = file.length()
        var lastError: Exception? = null
        var nextOffset = 0L
        var reportedUploaded = 0L

        for (attempt in 1..NodeServicePolicy.MAX_UPLOAD_RETRIES) {
            if (isCancelled()) throw TaskCancelledException()
            if (attempt > 1) {
                val status = runCatching {
                    apiClient.queryFileStatus(settings.apiBaseUrl, settings.nodeToken, taskId, produced.name)
                }.getOrNull()
                if (status != null) {
                    if (status.complete) {
                        val remaining = fileSize - reportedUploaded
                        if (remaining > 0L) onBytesDelta(remaining)
                        return
                    }
                    if (status.exists && status.sizeBytes in 1L until fileSize) {
                        nextOffset = status.sizeBytes
                        val deltaFix = nextOffset - reportedUploaded
                        if (deltaFix != 0L) {
                            onBytesDelta(deltaFix)
                            reportedUploaded += deltaFix
                        }
                    } else {
                        nextOffset = 0L
                    }
                }
            }

            try {
                apiClient.uploadFile(
                    baseUrl = settings.apiBaseUrl,
                    token = settings.nodeToken,
                    taskId = taskId,
                    file = file,
                    fileName = produced.name,
                    mimeType = produced.mimeType,
                    offsetBytes = nextOffset,
                    onBytesDelta = { delta ->
                        reportedUploaded += delta
                        onBytesDelta(delta)
                    },
                )
                return
            } catch (mismatch: UploadOffsetMismatchException) {
                lastError = mismatch
                nextOffset = mismatch.receivedBytes.coerceIn(0L, fileSize)
                val deltaFix = nextOffset - reportedUploaded
                if (deltaFix != 0L) {
                    onBytesDelta(deltaFix)
                    reportedUploaded += deltaFix
                }
                if (attempt >= NodeServicePolicy.MAX_UPLOAD_RETRIES) throw mismatch
            } catch (error: Exception) {
                lastError = error
                if (!NodeServicePolicy.isRetryableUploadFailure(error) || attempt >= NodeServicePolicy.MAX_UPLOAD_RETRIES) {
                    throw error
                }
                logStore.warn(
                    "NET",
                    "Upload of ${produced.name} interrupted (attempt $attempt/${NodeServicePolicy.MAX_UPLOAD_RETRIES}): ${error.message}",
                )
                withTimeoutOrNull(20_000L) {
                    connectivity.awaitAllowedNetwork(
                        allowWifi = { settings.allowWifi },
                        allowCellular = { settings.allowCellular },
                    )
                }
                delay(1_000L * attempt)
            }
        }
        throw lastError ?: IllegalStateException("Upload failed")
    }

    private fun refreshNotification() {
        serviceScope.launch {
            val prefs = runCatching { ServiceLocator.preferences(this@NodeForegroundService).current() }.getOrNull()
            val tracker = ServiceLocator.runtimeTracker()
            val total = (prefs?.completedTasksCount ?: 0L)
            ServiceLocator.notificationManager(this@NodeForegroundService)
                .updateStatusNotification(tracker.snapshot.value, total, isPaused.get())
        }
    }

    private fun signalLoopWake() {
        wakeSignal.trySend(Unit)
    }

    private fun registerBatteryObserver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        val sticky = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(batteryReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(batteryReceiver, filter)
        }
        batteryReceiverRegistered = true
        refreshChargingState(sticky)
    }

    private fun unregisterBatteryObserver() {
        if (batteryReceiverRegistered) {
            runCatching { unregisterReceiver(batteryReceiver) }
            batteryReceiverRegistered = false
        }
    }

    private fun refreshChargingState(intent: Intent?) {
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val chargingNow = batteryManager.isCharging ||
            status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL ||
            plugged != 0
        isCharging.set(chargingNow)
        ServiceLocator.runtimeTracker().update { it.copy(isCharging = chargingNow) }
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val lock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sera-node:worker")
        lock.setReferenceCounted(false)
        lock.acquire()
        wakeLock = lock
    }

    private fun releaseWakeLock() {
        runCatching {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        }
        wakeLock = null
    }

    private fun syncWifiLock(needed: Boolean) {
        if (needed) {
            if (wifiLock == null) {
                val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    @Suppress("DEPRECATION")
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifiLock = wifiManager.createWifiLock(mode, "sera-node:wifi").apply {
                    setReferenceCounted(false)
                }
            }
            if (wifiLock?.isHeld == false) {
                runCatching { wifiLock?.acquire() }
            }
        } else {
            releaseWifiLock()
        }
    }

    private fun releaseWifiLock() {
        runCatching {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
            }
        }
        wifiLock = null
    }

    companion object {
        const val ACTION_START = "dev.sera.node.action.START"
        const val ACTION_STOP = "dev.sera.node.action.STOP"
        const val ACTION_PAUSE = "dev.sera.node.action.PAUSE"
        const val ACTION_RESUME = "dev.sera.node.action.RESUME"
        const val ACTION_CHECK_UPDATES = "dev.sera.node.action.CHECK_UPDATES"

        fun start(context: Context) {
            val intent = Intent(context.applicationContext, NodeForegroundService::class.java).apply {
                action = ACTION_START
            }
            context.applicationContext.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context.applicationContext, NodeForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.applicationContext.startService(intent)
        }

        fun pause(context: Context) {
            val intent = Intent(context.applicationContext, NodeForegroundService::class.java).apply {
                action = ACTION_PAUSE
            }
            context.applicationContext.startService(intent)
        }

        fun resume(context: Context) {
            val intent = Intent(context.applicationContext, NodeForegroundService::class.java).apply {
                action = ACTION_RESUME
            }
            context.applicationContext.startService(intent)
        }
    }
}
