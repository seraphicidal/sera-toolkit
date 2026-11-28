package dev.sera.toolkit.domain

import dev.sera.toolkit.model.DownloadOption
import dev.sera.toolkit.model.MediaInfo
import dev.sera.toolkit.model.MediaItem
import dev.sera.toolkit.model.MediaKind
import dev.sera.toolkit.model.SUBTITLE_EMBED_CONTAINERS
import dev.sera.toolkit.model.SubtitleFormat
import dev.sera.toolkit.model.SubtitleRequest
import dev.sera.toolkit.model.SubtitleTrack
import kotlin.math.max
import kotlin.math.min

data class ResolvedSelection(
    val optionIds: List<String>,
    val totalBytes: Long? = null,
    val anyApproximate: Boolean = false,
    val fileCount: Int = 0,
)

data class SubtitleChoices(
    val tracks: List<SubtitleTrack>,
    val canEmbed: Boolean,
)

object SelectionLogic {
    private val selectableOrder = listOf(
        MediaKind.VIDEO,
        MediaKind.AUDIO,
        MediaKind.IMAGE,
        MediaKind.GIF,
        MediaKind.FILE,
    )

    fun availableKinds(info: MediaInfo, selectedIds: Set<String> = emptySet()): List<MediaKind> {
        val present = HashSet<MediaKind>()
        for (item in info.items) {
            if (selectedIds.isNotEmpty() && item.id !in selectedIds) continue
            for (option in item.options) {
                if (option.kind != MediaKind.UNKNOWN) present.add(option.kind)
            }
        }
        return selectableOrder.filter { it in present }
    }

    fun kindDisplayLabel(info: MediaInfo, kind: MediaKind): String {
        if (kind == MediaKind.IMAGE && info.items.none { it.kind == MediaKind.IMAGE }) {
            return "Thumbnail"
        }
        return Formatters.kindLabel(kind)
    }

    fun optionsOfKind(item: MediaItem, kind: MediaKind): List<DownloadOption> {
        return item.options.filter { it.kind == kind }
    }

    fun defaultOption(item: MediaItem, kind: MediaKind): DownloadOption? {
        val candidates = optionsOfKind(item, kind)
        return candidates.firstOrNull { it.recommended } ?: candidates.firstOrNull()
    }

    fun optionForItem(
        item: MediaItem,
        preferredKind: MediaKind?,
        preferredLabel: String? = null,
    ): DownloadOption? {
        if (preferredKind != null) {
            val matched = if (!preferredLabel.isNullOrEmpty()) {
                optionsOfKind(item, preferredKind).firstOrNull { it.label == preferredLabel }
            } else {
                null
            }
            val chosen = matched ?: defaultOption(item, preferredKind)
            if (chosen != null) return chosen
        }
        return item.options.firstOrNull { it.recommended } ?: item.options.firstOrNull()
    }

    fun initialKind(info: MediaInfo): MediaKind {
        val first = info.items.firstOrNull()
        val recommended = first?.options?.firstOrNull { it.recommended }
        return recommended?.kind ?: availableKinds(info).firstOrNull() ?: MediaKind.VIDEO
    }

    fun preferredLabelForKind(
        info: MediaInfo,
        kind: MediaKind,
        selectedIds: Set<String> = emptySet(),
    ): String? {
        for (item in info.items) {
            if (selectedIds.isNotEmpty() && item.id !in selectedIds) continue
            val recommended = optionsOfKind(item, kind).firstOrNull { it.recommended }
            if (recommended != null) return recommended.label
        }
        return qualityLabels(info, kind, selectedIds).firstOrNull()
    }

    fun qualityLabels(
        info: MediaInfo,
        kind: MediaKind,
        selectedIds: Set<String>,
    ): List<String> {
        val labels = LinkedHashSet<String>()
        for (item in info.items) {
            if (selectedIds.isNotEmpty() && item.id !in selectedIds) continue
            for (option in optionsOfKind(item, kind)) {
                labels.add(option.label)
            }
        }
        return labels.toList()
    }

    fun resolveSelection(
        info: MediaInfo,
        selectedIds: Set<String>,
        kind: MediaKind?,
        label: String?,
    ): ResolvedSelection {
        val optionIds = mutableListOf<String>()
        var totalBytes = 0L
        var everySizeKnown = true
        var anyApproximate = false

        for (item in info.items) {
            if (item.id !in selectedIds) continue
            val option = optionForItem(item, kind, label) ?: continue
            optionIds.add(option.id)
            if (option.filesizeBytes == null) {
                everySizeKnown = false
            } else {
                totalBytes += option.filesizeBytes
            }
            if (option.filesizeIsApproximate == true) {
                anyApproximate = true
            }
        }

        return ResolvedSelection(
            optionIds = optionIds,
            totalBytes = if (everySizeKnown && optionIds.isNotEmpty()) totalBytes else null,
            anyApproximate = anyApproximate,
            fileCount = optionIds.size,
        )
    }

    fun filterMediaItems(items: List<MediaItem>, query: String): List<MediaItem> {
        val normalized = query.trim().lowercase()
        if (normalized.isEmpty()) return items
        return items.filter { item ->
            val indexStr = item.index.toString()
            val kindStr = Formatters.kindLabel(
                if (item.kind == MediaKind.UNKNOWN) MediaKind.VIDEO else item.kind,
            ).lowercase()
            val titleStr = (item.title ?: "").lowercase()
            indexStr.contains(normalized) ||
                titleStr.contains(normalized) ||
                kindStr.contains(normalized)
        }
    }

    fun selectItemsUpToMax(
        itemsToSelect: List<MediaItem>,
        maxItems: Int? = null,
        baseSelected: Set<String> = emptySet(),
    ): Set<String> {
        val limit = if (maxItems != null && maxItems > 0) maxItems else Int.MAX_VALUE
        val next = LinkedHashSet(baseSelected)
        for (item in itemsToSelect) {
            if (next.size >= limit) break
            next.add(item.id)
        }
        return next
    }

    fun selectItemRange(
        items: List<MediaItem>,
        fromIndex: Int,
        toIndex: Int,
        maxItems: Int? = null,
    ): Set<String> {
        val start = min(fromIndex, toIndex)
        val end = max(fromIndex, toIndex)
        val inRange = items.filter { it.index in start..end }
        return selectItemsUpToMax(inRange, maxItems)
    }

    fun subtitleChoices(item: MediaItem?, option: DownloadOption?): SubtitleChoices? {
        val tracks = item?.subtitles
        if (tracks.isNullOrEmpty() || option == null) return null
        if (option.kind != MediaKind.VIDEO && option.kind != MediaKind.AUDIO) return null
        return SubtitleChoices(
            tracks = tracks,
            canEmbed = option.kind == MediaKind.VIDEO && option.container in SUBTITLE_EMBED_CONTAINERS,
        )
    }

    fun trackValue(track: SubtitleTrack): String {
        return if (track.auto) "${track.lang}:auto" else track.lang
    }

    fun subtitleRequest(
        choices: SubtitleChoices?,
        value: String,
        format: SubtitleFormat,
        only: Boolean,
    ): SubtitleRequest? {
        if (choices == null || value.isEmpty()) return null
        val track = choices.tracks.firstOrNull { trackValue(it) == value } ?: return null
        val effective =
            if (format == SubtitleFormat.EMBED && !choices.canEmbed) SubtitleFormat.SRT else format
        return SubtitleRequest(
            lang = track.lang,
            auto = if (track.auto) true else null,
            format = effective,
            only = if (only && effective != SubtitleFormat.EMBED) true else null,
        )
    }
}
