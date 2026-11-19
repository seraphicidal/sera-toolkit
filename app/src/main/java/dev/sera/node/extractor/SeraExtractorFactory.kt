package dev.sera.node.extractor

import android.content.Context
import dev.sera.node.model.ExtractionToolsManager
import dev.sera.node.model.NodeTaskRunner
import okhttp3.OkHttpClient
import java.io.File

object SeraExtractorFactory {
    fun createToolsManager(context: Context): ExtractionToolsManager {
        return SeraToolsManager(context.applicationContext)
    }

    fun createTaskRunner(
        context: Context,
        toolsManager: ExtractionToolsManager,
        httpClient: OkHttpClient,
    ): NodeTaskRunner {
        val appContext = context.applicationContext
        val resolvedManager = (toolsManager as? SeraToolsManager) ?: SeraToolsManager(appContext, httpClient)
        val executor = AndroidMediaExecutor(resolvedManager)
        val httpFetcher = OkHttpFetcher(httpClient)
        val workRoot = File(appContext.cacheDir, "sera-work")
        return SeraNodeTaskRunner(
            toolsManager = resolvedManager,
            executor = executor,
            httpFetcher = httpFetcher,
            defaultWorkRoot = workRoot,
        )
    }
}
