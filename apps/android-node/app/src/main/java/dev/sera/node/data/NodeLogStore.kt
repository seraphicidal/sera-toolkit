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

class NodeLogStore(
    private val maxEntries: Int = 1000,
    private val maxMessageLength: Int = 2_000,
) {
    private val nextId = AtomicLong(1L)
    private val lock = Any()
    private val buffer = ArrayDeque<LogEntry>(maxEntries)
    private val _entries = MutableStateFlow<List<LogEntry>>(emptyList())
    val entries: StateFlow<List<LogEntry>> = _entries.asStateFlow()

    private val timeFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

    fun append(level: LogLevel, tag: String, message: String) {
        val now = System.currentTimeMillis()
        val boundedMessage = if (message.length > maxMessageLength) {
            message.take(maxMessageLength - 3) + "..."
        } else {
            message
        }
        val formattedTime = Instant.ofEpochMilli(now)
            .atZone(ZoneId.systemDefault())
            .format(timeFormatter)
        val entry = LogEntry(
            id = nextId.getAndIncrement(),
            timestampMs = now,
            formattedTime = formattedTime,
            level = level,
            tag = tag.take(32),
            message = boundedMessage,
        )
        val snapshot = synchronized(lock) {
            while (buffer.size >= maxEntries) {
                buffer.removeFirst()
            }
            buffer.addLast(entry)
            ArrayList(buffer)
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

    fun clearAndSnapshot(): List<LogEntry> {
        val previous = synchronized(lock) {
            val copy = ArrayList(buffer)
            buffer.clear()
            copy
        }
        _entries.value = emptyList()
        return previous
    }

    fun restore(entries: List<LogEntry>) {
        if (entries.isEmpty()) return
        val snapshot = synchronized(lock) {
            val merged = LinkedHashMap<Long, LogEntry>(entries.size + buffer.size)
            for (item in entries) {
                merged[item.id] = item
            }
            for (item in buffer) {
                merged[item.id] = item
            }
            val ordered = merged.values.sortedBy { it.id }
            val trimmed = if (ordered.size > maxEntries) {
                ordered.subList(ordered.size - maxEntries, ordered.size)
            } else {
                ordered
            }
            buffer.clear()
            buffer.addAll(trimmed)
            val maxId = trimmed.maxOfOrNull { it.id } ?: 0L
            nextId.updateAndGet { current -> maxOf(current, maxId + 1L) }
            ArrayList(buffer)
        }
        _entries.value = snapshot
    }

    fun exportText(): String {
        val current = _entries.value
        val sb = StringBuilder(current.size * 80)
        for (index in current.indices) {
            val entry = current[index]
            if (index > 0) sb.append('\n')
            sb.append('[').append(entry.formattedTime).append("] [")
                .append(entry.level.label).append("] [")
                .append(entry.tag).append("] ")
                .append(entry.message)
        }
        return sb.toString()
    }
}
