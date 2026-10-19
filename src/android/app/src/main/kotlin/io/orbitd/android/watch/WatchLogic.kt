package io.orbitd.android.watch

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

/** Contract §3's watch state machine as a client acts on it (OrbitKit `WatchStateMachine`): which states are
 * terminal, which moves are legal, and so which controls a watch offers. */
internal object WatchStateMachine {
    val terminal = setOf(WatchState.MATCHED, WatchState.EXPIRED, WatchState.CANCELLED, WatchState.REVOKED, WatchState.UNRESOLVABLE)

    /** Every legal move, in the contract's order. */
    val transitions: List<Pair<WatchState, WatchState>> = listOf(
        WatchState.ACTIVE to WatchState.PAUSED,
        WatchState.PAUSED to WatchState.ACTIVE,
        WatchState.ACTIVE to WatchState.MATCHED,
        WatchState.ACTIVE to WatchState.EXPIRED,
        WatchState.PAUSED to WatchState.EXPIRED,
        WatchState.ACTIVE to WatchState.CANCELLED,
        WatchState.PAUSED to WatchState.CANCELLED,
        WatchState.ACTIVE to WatchState.REVOKED,
        WatchState.ACTIVE to WatchState.UNRESOLVABLE,
    )

    fun canTransition(from: WatchState, to: WatchState) = transitions.any { it.first == from && it.second == to }

    /** Still watching, so still pausable, resumable and stoppable — the server's `LIVE_STATES`. */
    fun isLive(state: WatchState) = state == WatchState.ACTIVE || state == WatchState.PAUSED

    /** The controls a watch in this state offers, in display order. View is always there: an ended watch is
     * still its own audit record. */
    fun controls(state: WatchState): List<WatchControl> = when (state) {
        WatchState.ACTIVE -> listOf(WatchControl.VIEW, WatchControl.EDIT, WatchControl.PAUSE, WatchControl.STOP)
        WatchState.PAUSED -> listOf(WatchControl.VIEW, WatchControl.EDIT, WatchControl.RESUME, WatchControl.STOP)
        else -> listOf(WatchControl.VIEW)
    }
}

/** One thing the owner can do to a watch. `raw` is the verb a refusal names ("Couldn't stop the watch — …"). */
internal enum class WatchControl(val raw: String, val title: String) {
    VIEW("view", "View"), EDIT("edit", "Edit"), PAUSE("pause", "Pause"), RESUME("resume", "Resume"), STOP("stop", "Stop");

    /** Where the server's machine moves the watch, or null for the controls that don't move it. Stop is the
     * contract's CANCELLED: the one unmatched end that wakes nobody (§3). */
    val resultingState: WatchState? get() = when (this) {
        PAUSE -> WatchState.PAUSED
        RESUME -> WatchState.ACTIVE
        STOP -> WatchState.CANCELLED
        VIEW, EDIT -> null
    }
}

/** Why a delivery is a dead letter: the code heading its `lastError` (contract `deliveryGuards.deadLetterCodes`). */
internal object WatchDeadLetter {
    /** The codes whose dead letter nobody has to act on (`needsAttention: false`). */
    val quietCodes = setOf("WAKE_WITHDRAWN")

    /** Whether `delivery` is a dead letter somebody has to look at: every one but a quiet one. */
    fun needsAttention(delivery: WatchDelivery): Boolean {
        if (delivery.state != WatchDeliveryState.DEAD_LETTER) return false
        val error = delivery.lastError.orEmpty()
        return quietCodes.none { error.startsWith("$it:") }
    }
}

/** The ends a watch needs attention for by its state alone (contract `attention`). */
internal object WatchAttentionRule {
    val states = setOf(WatchState.REVOKED, WatchState.UNRESOLVABLE)
    val expiredActions = setOf(WatchAction.NOTIFY_USER)
}

/** OrbitKit `RelativeTime`, the parts the watch pages read: ISO-8601 instants and the transcript's "4m ago". */
internal object WatchTime {
    fun parse(iso: String?): Instant? {
        if (iso.isNullOrEmpty()) return null
        return try { OffsetDateTime.parse(iso).toInstant() } catch (_: DateTimeParseException) {
            try { Instant.parse(iso) } catch (_: DateTimeParseException) { null }
        }
    }

    fun seconds(from: Instant, to: Instant): Double = (to.toEpochMilli() - from.toEpochMilli()) / 1000.0

    /** "just now", "5m ago", "3h ago", "2d ago", "1w ago"; older than about four weeks the day, `M/d`. */
    fun format(iso: String?, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String? {
        val date = parse(iso) ?: return null
        val diff = seconds(date, now)
        val min = 60.0; val hour = 3_600.0; val day = 86_400.0; val week = 604_800.0
        return when {
            diff < min -> "just now"
            diff < hour -> "${(diff / min).toInt()}m ago"
            diff < day -> "${(diff / hour).toInt()}h ago"
            diff < week -> "${(diff / day).toInt()}d ago"
            diff < 4 * week -> "${(diff / week).toInt()}w ago"
            else -> date.atZone(zone).let { "${it.monthValue}/${it.dayOfMonth}" }
        }
    }
}

/** A task's pill as the task list draws it (OrbitKit `TaskPill`). */
internal data class WatchTaskPill(val kind: Kind, val label: String) {
    enum class Kind { RUNNING, QUEUED, DONE, IN_PROGRESS, OPEN, FAILED, CANCELLED }

    companion object {
        /** A run going or queued outranks the lifecycle (`TaskListLogic.overlayPill`). */
        fun overlay(running: Boolean, queued: Boolean): WatchTaskPill? = when {
            running -> WatchTaskPill(Kind.RUNNING, "Running")
            queued -> WatchTaskPill(Kind.QUEUED, "Queued")
            else -> null
        }

        /** The lifecycle pill in the browser's words; a status neither knows is drawn under its own name
         * (`ReferencedTaskNote.pill(status:)`). */
        fun of(status: String): WatchTaskPill = when (status) {
            "DONE" -> WatchTaskPill(Kind.DONE, "Done")
            "IN_PROGRESS" -> WatchTaskPill(Kind.IN_PROGRESS, "In progress")
            "OPEN" -> WatchTaskPill(Kind.OPEN, "Open")
            "FAILED" -> WatchTaskPill(Kind.FAILED, "Failed")
            "CANCELLED" -> WatchTaskPill(Kind.CANCELLED, "Cancelled")
            else -> WatchTaskPill(Kind.OPEN, status)
        }
    }
}

/** A session's glyph for its run state, as its header draws it (OrbitKit `SessionStatusGlyph.make(runState:)` with
 * nothing else known about the session). `symbol` is the SF Symbol iOS draws; null is the working spinner. */
internal data class WatchSessionGlyph(val symbol: String?, val tone: Tone, val label: String) {
    enum class Tone { BRAND, SUCCESS, WARNING, ERROR, NEUTRAL }

    companion object {
        fun of(runState: String): WatchSessionGlyph = when (runState) {
            "QUEUED" -> WatchSessionGlyph("clock", Tone.NEUTRAL, "Queued")
            "RUNNING" -> WatchSessionGlyph(null, Tone.BRAND, "Running")
            "AWAITING_INPUT" -> WatchSessionGlyph("message", Tone.NEUTRAL, "Waiting for your reply")
            "SUCCEEDED" -> WatchSessionGlyph("checkmark.circle.fill", Tone.SUCCESS, "Succeeded")
            "FAILED" -> WatchSessionGlyph("xmark.circle.fill", Tone.ERROR, "Failed")
            "INTERRUPTED" -> WatchSessionGlyph("minus.circle", Tone.NEUTRAL, "Interrupted")
            // ENDED, and a run state this build doesn't know: the safe terminal glyph.
            else -> WatchSessionGlyph("checkmark.circle", Tone.NEUTRAL, "Ended")
        }
    }
}

/** Tasks created here's sentence (OrbitKit `SessionCreatedTasksCopy`), which the strip's folded line borrows. */
internal object WatchCountCopy {
    const val SEPARATOR = " · "

    /** One part of the sentence. A failed count is the one part drawn in red. */
    data class Part(val text: String, val failed: Boolean)

    /** `N running`, `N failed` and `done/total done`: a zero running or failed is left out. */
    fun parts(running: Int, failed: Int, done: Int, total: Int): List<Part> = buildList {
        if (running > 0) add(Part("$running running", false))
        if (failed > 0) add(Part("$failed failed", true))
        add(Part("$done/$total done", false))
    }
}
