package dev.sera.toolkit.domain

import dev.sera.toolkit.model.HealthCheckStatus
import dev.sera.toolkit.model.HealthReport
import dev.sera.toolkit.model.HealthStatus

enum class HealthLight {
    UNKNOWN,
    GREEN,
    AMBER,
    RED,
}

data class HealthState(
    val light: HealthLight = HealthLight.UNKNOWN,
    val report: HealthReport? = null,
    val failures: Int = 0,
)

sealed interface HealthObservation {
    data class Ok(val report: HealthReport) : HealthObservation
    data object Failed : HealthObservation
}

data class HealthLine(
    val label: String,
    val ok: Boolean,
    val note: String,
)

object HealthModel {
    const val FAILURES_BEFORE_DOWN = 2

    private data class CheckDescriptor(
        val label: String,
        val ok: String,
        val error: String,
    )

    private val knownChecks = mapOf(
        "yt-dlp" to CheckDescriptor("Media extractor", "Reading links normally", "Most sources will fail"),
        "ffmpeg" to CheckDescriptor("Converter", "Converting normally", "Conversions will fail"),
        "storage" to CheckDescriptor("Storage", "Available", "Downloads cannot be saved"),
        "queue" to CheckDescriptor("Download queue", "Accepting downloads", "Downloads cannot start"),
        "extraction-nodes" to CheckDescriptor("YouTube", "Available through a home connection", "Unavailable right now"),
    )

    fun nextHealth(state: HealthState, observation: HealthObservation): HealthState {
        return when (observation) {
            is HealthObservation.Ok -> HealthState(
                light = when (observation.report.status) {
                    HealthStatus.OK -> HealthLight.GREEN
                    HealthStatus.DEGRADED -> HealthLight.AMBER
                    HealthStatus.ERROR -> HealthLight.RED
                },
                report = observation.report,
                failures = 0,
            )
            HealthObservation.Failed -> {
                val failures = state.failures + 1
                if (failures < FAILURES_BEFORE_DOWN) {
                    state.copy(failures = failures)
                } else {
                    HealthState(light = HealthLight.RED, report = state.report, failures = failures)
                }
            }
        }
    }

    fun describeHealth(state: HealthState): List<HealthLine> {
        val serverOk = state.failures < FAILURES_BEFORE_DOWN
        val serverNote = when {
            !serverOk -> "Not answering"
            state.report != null -> "Answering"
            else -> "Checking…"
        }
        val lines = mutableListOf(HealthLine("Server", serverOk, serverNote))
        val report = state.report
        if (report == null || !serverOk) return lines

        for (check in report.checks) {
            val descriptor = knownChecks[check.name]
            val ok = check.status == HealthCheckStatus.OK
            val label = descriptor?.label ?: check.name
            val note = when {
                descriptor != null -> if (ok) descriptor.ok else descriptor.error
                else -> if (ok) "OK" else "Not working"
            }
            lines.add(HealthLine(label = label, ok = ok, note = note))
        }
        return lines
    }

    fun headlineHealth(state: HealthState): String = when (state.light) {
        HealthLight.GREEN -> "Everything is working"
        HealthLight.AMBER -> "Partly working"
        HealthLight.RED -> if (state.failures >= FAILURES_BEFORE_DOWN) "Not reachable" else "Not working"
        HealthLight.UNKNOWN -> "Checking"
    }

    fun summarizeHealth(state: HealthState): String {
        return "Service status: ${headlineHealth(state).lowercase()}"
    }
}
