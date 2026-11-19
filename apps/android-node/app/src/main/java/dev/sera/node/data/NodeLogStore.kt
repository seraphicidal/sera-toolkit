package dev.sera.node.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicLong

enum class LogLevel(val label: String) {
    DEBUG("DEBUG"),
    INFO("INFO"),
    WARN("WARN"),
    ERROR("ERROR"),
}

data class LogEntry(
    val id: Long,
    val timestampMs: Long,
    val formattedTime: String,
    val level: LogLevel,
    val tag: String,
    val message: String,
)

class NodeLogStore(private val maxEntries: Int = 1000) {
    private val nextId = AtomicLong(1L)
    private val lock = Any()
    private val buffer = ArrayDeque<LogEntry>(maxEntries)
    private val _entries = MutableStateFlow<List<LogEntry>>(emptyList())
    val entries: StateFlow<List<LogEntry>> = _entries.asStateFlow()

    private val timeFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

    fun append(level: LogLevel, tag: String, message: String) {
        val now = System.currentTimeMillis()
        val entry = LogEntry(
            id = nextId.getAndIncrement(),
            timestampMs = now,
            formattedTime = timeFormatter.format(Instant.ofEpochMilli(now)),
            level = level,
            tag = tag,
            message = message,
        )
        val snapshot = synchronized(lock) {
            if (buffer.size >= maxEntries) {
                buffer.removeFirst()
            }
            buffer.addLast(entry)
            buffer.toList()
        }
        _entries.value = snapshot
    }

    fun debug(tag: String, message: String) = append(LogLevel.DEBUG, tag, message)

    fun info(tag: String, message: String) = append(LogLevel.INFO, tag, message)

    fun warn(tag: String, message: String) = append(LogLevel.WARN, tag, message)

    fun error(tag: String, message: String) = append(LogLevel.ERROR, tag, message)

    fun clear() {
        synchronized(lock) {
            buffer.clear()
        }
        _entries.value = emptyList()
    }

    fun exportText(): String {
        return _entries.value.joinToString("\n") { entry ->
            "[${entry.formattedTime}] [${entry.level.label}] [${entry.tag}] ${entry.message}"
        }
    }
}
