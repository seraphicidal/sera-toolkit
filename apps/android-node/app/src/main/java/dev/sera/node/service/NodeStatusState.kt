package dev.sera.node.service

import dev.sera.node.model.NetworkTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class NodeServiceState(val label: String) {
    STOPPED("Stopped"),
    STARTING("Starting"),
    PAUSED("Paused"),
    UNCONFIGURED("Setup Required"),
    WAITING_NETWORK("Waiting for Network"),
    WAITING_CHARGING("Waiting for Charger"),
    IDLE_POLLING("Online • Idle"),
    RUNNING_TASK("Running Task"),
    UPDATING("Updating"),
    RECONNECTING("Reconnecting"),
    AUTH_ERROR("Auth Error"),
}

data class ActiveTaskInfo(
    val taskId: String,
    val kind: String,
    val providerId: String,
    val step: String,
    val percent: Double,
    val bytesDownloaded: Long? = null,
    val bytesTotal: Long? = null,
)

data class NodeRuntimeSnapshot(
    val serviceState: NodeServiceState = NodeServiceState.STOPPED,
    val transport: NetworkTransport = NetworkTransport.NONE,
    val isConnected: Boolean = false,
    val isCharging: Boolean = false,
    val activeTasks: List<ActiveTaskInfo> = emptyList(),
    val lastError: String? = null,
    val authFailureCount: Int = 0,
    val completedTasksSession: Long = 0L,
    val startedAtMs: Long? = null,
)

class NodeRuntimeTracker {
    private val _snapshot = MutableStateFlow(NodeRuntimeSnapshot())
    val snapshot: StateFlow<NodeRuntimeSnapshot> = _snapshot.asStateFlow()

    fun update(transform: (NodeRuntimeSnapshot) -> NodeRuntimeSnapshot) {
        _snapshot.update(transform)
    }

    fun upsertTask(task: ActiveTaskInfo) {
        _snapshot.update { current ->
            val filtered = current.activeTasks.filterNot { it.taskId == task.taskId }
            current.copy(activeTasks = filtered + task)
        }
    }

    fun removeTask(taskId: String) {
        _snapshot.update { current ->
            current.copy(activeTasks = current.activeTasks.filterNot { it.taskId == taskId })
        }
    }

    fun resetStopped() {
        _snapshot.value = NodeRuntimeSnapshot(serviceState = NodeServiceState.STOPPED)
    }
}
