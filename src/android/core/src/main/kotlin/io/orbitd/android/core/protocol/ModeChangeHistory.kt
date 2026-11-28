package io.orbitd.android.core.protocol

import java.time.Instant

/** A page of a session's older mode changes (GET /sessions/:id/permission-mode-changes): oldest first, and whether older remain. */
data class ModeChangePage(val changes: List<PermissionModeChange>, val hasMore: Boolean)

/**
 * Every mode change a transcript holds, not only the detail's newest fifty (web `permissionModeChangeHistory`, iOS
 * `ModeChangeHistory`): the detail's, and the older pages read as the transcript pages back, until the oldest held is older
 * than the oldest event loaded or, once the window reaches the session's start, until none are left. Each change once, by its
 * seq, in the order it was recorded. A change that falls out of the detail's fifty stays; a detail that no longer reaches what
 * is held (more than a page recorded since the last read) starts it again, so no change in between is missed.
 */
data class ModeChangeHistory(val changes: List<PermissionModeChange> = emptyList(), val hasMore: Boolean = false) {
    /** With the detail's read taken in: this same object when it adds nothing. A change with no seq (an older server) is held as
     * the detail says, alone. */
    fun adopt(detail: List<PermissionModeChange>, detailHasMore: Boolean): ModeChangeHistory {
        if (detail.any { it.seq == null }) return if (changes == detail && !hasMore) this else ModeChangeHistory(detail, false)
        if (changes.isEmpty()) return if (detail.isEmpty() && hasMore == detailHasMore) this else ModeChangeHistory(detail, detailHasMore)
        if (detail.isEmpty()) return this
        val known = changes.mapTo(HashSet()) { it.seq }
        if (detailHasMore && detail.first().seq !in known) return ModeChangeHistory(detail, true)
        if (detail.all { it.seq in known } && (detailHasMore || !hasMore)) return this
        return ModeChangeHistory(joined(changes, detail), detailHasMore && hasMore)
    }

    /** With a page read for [before], when it is still the oldest held: another start since makes the page not this one's. */
    fun withOlder(before: Long, page: ModeChangePage): ModeChangeHistory =
        if (changes.firstOrNull()?.seq != before) this else ModeChangeHistory(joined(page.changes, changes), page.hasMore)

    /** Whether to read the page before the oldest held, for a window whose oldest event is at [oldestEventTs] (none loaded: not yet),
     * and which reaches the session's start when [reachesStart]. */
    fun needsOlder(oldestEventTs: String?, reachesStart: Boolean): Boolean {
        val oldest = changes.firstOrNull()
        if (!hasMore || oldest?.seq == null || oldestEventTs == null) return false
        if (reachesStart) return true
        val at = parse(oldest.at) ?: return false
        val event = parse(oldestEventTs) ?: return false
        // A change at the same moment as the oldest event may have older ones beside it.
        return !at.isBefore(event)
    }

    private companion object {
        fun joined(older: List<PermissionModeChange>, newer: List<PermissionModeChange>) =
            (older + newer).associateBy { it.seq }.values.sortedBy { it.seq }
        fun parse(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()
    }
}
