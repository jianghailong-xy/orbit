package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/**
 * A turn a watch queued into its observer, as the conversation draws it (A08-14; OrbitKit `WatchWakeCard`, web `WatchWakeCard.tsx`):
 * one line in the agent's stream in the grammar a background job's news uses — the watch's eye (a red mark when a target it saw
 * failed), what happened, which target moved, how it came out, when, and "Details" — and folded under it why the watch fired, every
 * target that moved, who queued the turn, the way to the watch, and what the agent received. The source is [watchWake]'s projection
 * of the server's message. No anchor for the sticky bar: it is a line inside an answer, not the head of one.
 */
object WatchWakeCard {
    /** How many changed targets the line names before "+N more". */
    const val shownChanges = 5
    const val details = "Details"
    const val undelivered = "The session has not confirmed it received this."
    const val viewWatch = "View watch"
    const val rawSummary = "What the agent received"

    fun targets(wake: JsonObject): List<JsonObject> = wake.objects("changedTargets").filter { it.text("kind") != null && it.text("id") != null }

    fun title(state: String?): String = when (state) {
        "MATCHED" -> "Watch triggered"
        "EXPIRED" -> "Watch expired"
        "REVOKED" -> "Watch stopped: access lost"
        else -> "Watch stopped: every target is gone"
    }

    /** Why the watch queued this turn: a Match's reason in words, and for each of the three ends the sentence saying it will not
     * wake this session again. */
    fun why(wake: JsonObject): String = when (wake.text("state")) {
        "MATCHED" -> wake.text("reason")?.takeIf { it.isNotEmpty() }?.let(::describeReason) ?: "Its condition held."
        "EXPIRED" -> "Its deadline passed before its condition held. It will not wake this session again."
        "REVOKED" -> "This account can no longer read one of its targets, so it reports nothing about them."
        else -> "Every target it watched was deleted, so its condition can never be decided."
    }

    /** A Match's `ALL TASK_DONE 2/2` in words: "2 of 2 done · 1 of 7 failed"; a reason in any other shape is returned as it is. */
    fun describeReason(reason: String): String {
        val parts = mutableListOf<String>()
        for (match in Regex("\\b(?:ALL|ANY) ([A-Z_]+) (\\d+)/(\\d+)").findAll(reason)) {
            val word = when (match.groupValues[1]) {
                "SESSION_TURN_SETTLED" -> "finished their turn"; "SESSION_RUN_TERMINAL" -> "ended"
                "SESSION_LIFECYCLE_TERMINAL" -> "filed away"; "SESSION_NEEDS_ATTENTION" -> "asked for approval"
                "TASK_TERMINAL" -> "finished"; "TASK_DONE" -> "done"; "TASK_FAILED" -> "failed"
                else -> return reason
            }
            parts += "${match.groupValues[2]} of ${match.groupValues[3]} $word"
        }
        return if (parts.isEmpty()) reason else parts.joinToString(" · ")
    }

    private fun noun(target: JsonObject) = if (target.text("kind") == "SESSION") "Session" else "Task"

    /** The status its evaluation read, when the payload carries one. */
    fun status(target: JsonObject): String? = target.obj("observed")?.text("status")?.takeIf { it.isNotEmpty() }

    /** One changed target's row: "Task Land the redirect fix is now DONE", by its name, or the last eight of its id where this client
     * holds none — the first eight of a UUIDv7 are its creation time. */
    fun changedLine(target: JsonObject, name: String? = null): String {
        val shown = name?.takeIf { it.isNotEmpty() } ?: target.text("id").orEmpty().takeLast(8)
        return status(target)?.let { "${noun(target)} $shown is now $it" } ?: "${noun(target)} $shown"
    }

    /** The targets the fold names, and how many it leaves to "+N more". */
    fun changes(wake: JsonObject): Pair<List<JsonObject>, Int> = targets(wake).let { it.take(shownChanges) to maxOf(0, it.size - shownChanges) }

    /** A target the line draws in its error tone: one the watch saw fail. */
    fun targetFailed(target: JsonObject) = status(target) == "FAILED"

    /** Whether the line takes the error tone: a target the watch saw fail. A watch that ran out or lost its targets is no failure. */
    fun isFailed(wake: JsonObject) = targets(wake).any(::targetFailed)

    /** What the line names after its title: the one target that moved, by its name or its kind and short id, or how many moved in
     * the noun the Watching strip counts in; null when none did. */
    fun lineName(wake: JsonObject, name: String? = null): String? {
        val changed = targets(wake)
        if (changed.size == 1) return name?.takeIf { it.isNotEmpty() } ?: "${noun(changed.single())} ${changed.single().text("id").orEmpty().takeLast(8)}"
        if (changed.isEmpty()) return null
        val kinds = changed.map { it.text("kind") }.toSet()
        val counted = if (kinds.size != 1) "target" else if ("TASK" in kinds) "task" else "session"
        return "${changed.size} ${counted}s"
    }

    /** The word the line closes on: the one target's status, or how many of several failed. */
    fun lineStatus(wake: JsonObject): String? {
        val changed = targets(wake)
        if (changed.size == 1) status(changed.single())?.let { return it }
        val failed = changed.filter(::targetFailed)
        return if (failed.isEmpty()) null else "${failed.size} of ${changed.size} failed"
    }

    /** The failures that stay out of the fold where several targets moved — a lone one is the line itself. */
    fun failures(wake: JsonObject): Pair<List<JsonObject>, Int> {
        val changed = targets(wake)
        if (changed.size <= 1) return emptyList<JsonObject>() to 0
        val failed = changed.filter(::targetFailed)
        return failed.take(shownChanges) to maxOf(0, failed.size - shownChanges)
    }

    /** "+2 more". */
    fun moreTargets(hidden: Int) = "+$hidden more"

    /** "Queued by a watch, not typed by you · generation 1" — who queued the turn, said in the fold. */
    fun meta(wake: JsonObject): String = "Queued by a watch, not typed by you" + (wake.number("generation")?.let { " · generation $it" } ?: "")
}

/**
 * A wake still waiting behind the running turn: the same line, dashed, with the queue's own line under it. Withdrawing it is not
 * Cancel — nobody typed these words, so nothing folds back into the composer, and the server dead-letters the watch's delivery — so
 * it asks first, and [consequence] is what the asking says.
 */
object WatchWakeQueue {
    const val status = "Queued for next turn"
    const val withdraw = "Withdraw wake"
    const val consequence = "If withdrawn, this session is not woken this time, and the watch won't send it again."
    const val confirmTitle = "Withdraw this wake?"
    const val keep = "Keep it queued"
}
