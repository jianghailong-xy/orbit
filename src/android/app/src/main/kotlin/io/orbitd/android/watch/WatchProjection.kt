package io.orbitd.android.watch

import io.orbitd.android.core.auth.SessionChanged
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

// How a watch reads on a Following row, its detail and the session's Watching strip: who is being watched, for
// what, how fresh that reading is, and what happens when the condition holds. Transcribed from OrbitKit
// `App/WatchProjection.swift`; pure (`now` is injectable) and English, like the rest of the app's strings.
//
// None of the Background process vocabulary on purpose (contract §9.2): a watch is a row on the control plane,
// not a process, and a session waiting on one is "Watching".

/** Where a watch's targets stand. */
internal data class WatchProgress(
    /** Targets a leaf the condition names holds for (SATISFIED). */
    val met: Int,
    /** Targets still in the set: everything but GONE. */
    val live: Int,
    /** Targets whose rows were deleted — out of the set, never counted as met (contract §4). */
    val gone: Int,
) {
    companion object {
        fun of(targets: List<WatchTarget>): WatchProgress {
            val met = targets.count { it.state == WatchTargetState.SATISFIED }
            val gone = targets.count { it.state == WatchTargetState.GONE }
            return WatchProgress(met, targets.size - gone, gone)
        }
    }
}

/** How far to trust the progress a watch shows. */
internal enum class WatchFreshness {
    /** Looked at recently enough that evaluation is keeping up. */
    FRESH,
    /** ACTIVE and not looked at for longer than a working evaluator ever leaves it. */
    STALE,
    /** ACTIVE, just created, and not looked at yet. */
    PENDING,
    /** Not evaluated by design: paused or ended. */
    IDLE;

    companion object {
        /** Three minutes without a look means evaluation isn't happening rather than that it's slow. */
        const val STALE_AFTER = 180.0

        fun of(watch: Watch, now: Instant): WatchFreshness {
            if (watch.state != WatchState.ACTIVE) return IDLE
            val looked = WatchTime.parse(watch.lastEvaluatedAt)
            if (looked == null) {
                val created = WatchTime.parse(watch.createdAt) ?: now
                return if (WatchTime.seconds(created, now) > STALE_AFTER) STALE else PENDING
            }
            return if (WatchTime.seconds(looked, now) > STALE_AFTER) STALE else FRESH
        }
    }
}

/** Why a watch belongs under Needs attention. */
internal sealed interface WatchAttention {
    val text: String

    /** A delivery gave up, with the error it kept. */
    data class DeliveryFailed(val error: String?) : WatchAttention {
        override val text get() = if (error.isNullOrEmpty()) "Delivery failed" else "Delivery failed: $error"
    }
    /** A delivery failed and is being retried; how many attempts have failed so far. */
    data class DeliveryRetrying(val failedAttempts: Int) : WatchAttention {
        override val text get() = "Delivery retrying · $failedAttempts of ${WatchLimits.MAX_DELIVERY_ATTEMPTS} attempts failed"
    }
    data object Revoked : WatchAttention { override val text get() = "Stopped: access to its targets was revoked" }
    data object Unresolvable : WatchAttention { override val text get() = "Stopped: every target was deleted" }
    data object ExpiredUnheard : WatchAttention { override val text get() = "Expired before its condition held: no notification was sent" }
    data object Stale : WatchAttention { override val text get() = "Not evaluated recently" }
}

/** The Following page's sections, in display order. */
internal enum class WatchGroup(val title: String) { NEEDS_ATTENTION("Needs attention"), ACTIVE("Active"), HISTORY("History") }

/** One non-empty section of the Following page. */
internal data class WatchSection(val group: WatchGroup, val watches: List<Watch>)

internal object WatchProjection {
    // MARK: grouping

    /** Every delivery the watch caused: its Matches', then its end's. */
    fun deliveries(watch: Watch): List<WatchDelivery> = watch.matches.flatMap { it.deliveries } + watch.expiryDeliveries.map { it.delivery }

    /** Why this watch is somebody's to look at, in the order the row says it. */
    fun attention(watch: Watch, now: Instant): List<WatchAttention> = buildList {
        val all = deliveries(watch)
        all.lastOrNull(WatchDeadLetter::needsAttention)?.let { add(WatchAttention.DeliveryFailed(it.lastError)) }
        all.lastOrNull { (it.state == WatchDeliveryState.PENDING || it.state == WatchDeliveryState.IN_FLIGHT) && it.attempts > 0 }
            ?.let { add(WatchAttention.DeliveryRetrying(it.attempts)) }
        if (watch.state == WatchState.REVOKED) add(WatchAttention.Revoked)
        if (watch.state == WatchState.UNRESOLVABLE) add(WatchAttention.Unresolvable)
        if (watch.state == WatchState.EXPIRED && watch.action in WatchAttentionRule.expiredActions) add(WatchAttention.ExpiredUnheard)
        if (WatchFreshness.of(watch, now) == WatchFreshness.STALE) add(WatchAttention.Stale)
    }

    fun group(watch: Watch, now: Instant): WatchGroup = when {
        attention(watch, now).isNotEmpty() -> WatchGroup.NEEDS_ATTENTION
        WatchStateMachine.isLive(watch.state) -> WatchGroup.ACTIVE
        else -> WatchGroup.HISTORY
    }

    /** The non-empty sections in display order, each keeping the order `watches` came in. */
    fun sections(watches: List<Watch>, now: Instant): List<WatchSection> {
        val grouped = watches.groupBy { group(it, now) }
        return WatchGroup.entries.mapNotNull { g -> grouped[g]?.takeIf { it.isNotEmpty() }?.let { WatchSection(g, it) } }
    }

    // MARK: copy

    /** "Watching 7 targets" — what a session waiting on a watch reads as. */
    fun watchingLabel(targets: Int) = "Watching ${targetCount(targets)}"

    fun targetCount(n: Int) = if (n == 1) "1 target" else "$n targets"

    /** The noun a set of targets counts in: the one kind every target shares, "targets" for a mix. */
    fun targetNoun(watches: List<Watch>, count: Int): String {
        val kinds = watches.flatMap { w -> w.targets.map { it.targetKind } }.toSet()
        val noun = if (kinds.size != 1) "target" else if (WatchTargetKind.TASK in kinds) "task" else "session"
        return if (count == 1) noun else "${noun}s"
    }

    private fun aggregatedKind(predicate: WatchPredicate): WatchTargetKind? = when (predicate) {
        is WatchPredicate.All -> predicate.leaf.targetKind
        is WatchPredicate.Any -> predicate.leaf.targetKind
        else -> null
    }

    /** What one watch's condition asks for, over the targets its leaf can read: "all 4 tasks", "any 1 of 4 tasks".
     * A condition this build cannot read states no threshold: the line counts the targets it can see instead. */
    fun thresholdLabel(predicate: WatchPredicate, targets: List<WatchTarget>, watches: List<Watch>): String {
        val kind = aggregatedKind(predicate)
        val of = kind?.let { k -> targets.count { it.targetKind == k } } ?: targets.size
        val noun = targetNoun(watches, of)
        if (of == 0) return "no $noun"
        if (!predicate.isKnown) return "$of $noun"
        var needed = of
        if (predicate is WatchPredicate.Any && of > 0) needed = 1
        if (needed == of) return "all $of $noun"
        if (needed == 1) return "any 1 of $of $noun"
        return "$needed of $of $noun"
    }

    /** The row's and the detail's first line. */
    fun headline(watch: Watch): String {
        val live = WatchProgress.of(watch.targets).live
        return when (watch.state) {
            WatchState.ACTIVE -> watchingLabel(live)
            WatchState.PAUSED -> "Paused · ${targetCount(live)}"
            WatchState.MATCHED -> "Matched"
            WatchState.EXPIRED -> "Expired"
            WatchState.CANCELLED -> "Stopped"
            WatchState.REVOKED -> "Access revoked"
            WatchState.UNRESOLVABLE -> "Every target is gone"
            WatchState.UNKNOWN -> "Unknown state"
        }
    }

    /** "3 of 7 finished", plus " · 1 gone" when a target was deleted. The denominator is the threshold the
     * condition sets, and the count is left off when one is all it takes. */
    fun progress(watch: Watch): String {
        val p = WatchProgress.of(watch.targets)
        val needed = threshold(watch.predicate, watch.targets.filter { it.state != WatchTargetState.GONE }).first
        val verb = metWord(watch.predicate)
        val text = if (needed == 1) "${p.met} $verb" else "${p.met} of $needed $verb"
        return if (p.gone > 0) "$text · ${p.gone} gone" else text
    }

    /** The threshold the condition itself sets, over the targets it can read: (needed, of). */
    fun threshold(predicate: WatchPredicate, targets: List<WatchTarget>): Pair<Int, Int> {
        val kind = aggregatedKind(predicate)
        val of = kind?.let { k -> targets.count { it.targetKind == k } } ?: targets.size
        if (predicate is WatchPredicate.Any && of > 0) return 1 to of
        return of to of
    }

    fun metWord(predicate: WatchPredicate): String {
        var leaves = predicate.leaves.toSet()
        // "All of these finish, or any one fails": a failed task has finished, so it counts in the same verb.
        if (leaves == setOf(WatchLeaf.TASK_TERMINAL, WatchLeaf.TASK_FAILED)) leaves = setOf(WatchLeaf.TASK_TERMINAL)
        val leaf = leaves.singleOrNull() ?: return "met"
        return when (leaf) {
            WatchLeaf.SESSION_TURN_SETTLED -> "finished their turn"
            WatchLeaf.SESSION_RUN_TERMINAL -> "ended"
            WatchLeaf.SESSION_LIFECYCLE_TERMINAL -> "completed or trashed"
            WatchLeaf.SESSION_NEEDS_ATTENTION -> "need attention"
            WatchLeaf.TASK_TERMINAL -> "finished"
            WatchLeaf.TASK_FAILED -> "failed"
            WatchLeaf.TASK_DONE -> "done"
            WatchLeaf.UNKNOWN -> "met"
        }
    }

    /** The condition as a sentence: "All tasks finish, or any task fails". A watch over one target says "The
     * task finishes" instead. */
    fun condition(predicate: WatchPredicate, targetCount: Int): String {
        val text = sentence(predicate, targetCount == 1, false)
        return text.take(1).uppercase() + text.drop(1)
    }

    private fun sentence(predicate: WatchPredicate, single: Boolean, nested: Boolean): String = when (predicate) {
        is WatchPredicate.All -> clause("all", predicate.leaf, single)
        is WatchPredicate.Any -> clause("any", predicate.leaf, single)
        is WatchPredicate.AllOf -> predicate.operands.joinToString(" and ") { sentence(it, single, true) }.let { if (nested) "($it)" else it }
        is WatchPredicate.AnyOf -> predicate.operands.joinToString(", or ") { sentence(it, single, true) }.let { if (nested) "($it)" else it }
        is WatchPredicate.Unknown -> UNKNOWN_CONDITION
    }

    private const val UNKNOWN_CONDITION = "a condition this version of Orbit can't show"

    private fun clause(quantifier: String, leaf: WatchLeaf, single: Boolean): String {
        val noun = when (leaf.targetKind) {
            WatchTargetKind.TASK -> "task"
            WatchTargetKind.SESSION -> "session"
            WatchTargetKind.UNKNOWN, null -> return UNKNOWN_CONDITION
        }
        // One target: ALL and ANY say the same thing about it.
        if (single) return "the $noun ${verb(leaf, true)}"
        return if (quantifier == "all") "all ${noun}s ${verb(leaf, false)}" else "any $noun ${verb(leaf, true)}"
    }

    private fun verb(leaf: WatchLeaf, singular: Boolean): String = when (leaf) {
        WatchLeaf.SESSION_TURN_SETTLED -> if (singular) "finishes its turn" else "finish their turn"
        WatchLeaf.SESSION_RUN_TERMINAL -> if (singular) "ends its run" else "end their run"
        WatchLeaf.SESSION_LIFECYCLE_TERMINAL -> if (singular) "is completed or trashed" else "are completed or trashed"
        WatchLeaf.SESSION_NEEDS_ATTENTION -> if (singular) "needs attention" else "need attention"
        WatchLeaf.TASK_TERMINAL -> if (singular) "finishes" else "finish"
        WatchLeaf.TASK_FAILED -> if (singular) "fails" else "fail"
        WatchLeaf.TASK_DONE -> if (singular) "is done" else "are done"
        WatchLeaf.UNKNOWN -> UNKNOWN_CONDITION
    }

    /** What happens when the condition holds. `observerTitle` names the session a RESUME_SESSION watch resumes. */
    fun action(watch: Watch, observerTitle: String?): String = when (watch.action) {
        WatchAction.NOTIFY_USER -> "Notify you"
        WatchAction.RESUME_SESSION -> if (observerTitle.isNullOrEmpty()) "Resume the waiting session" else "Resume $observerTitle"
        WatchAction.UNKNOWN -> "An action this version of Orbit can't show"
    }

    /** "Last evaluated 4m ago", from the watch's own last look — never the last turn. */
    fun lastEvaluated(watch: Watch, now: Instant): String =
        WatchTime.format(watch.lastEvaluatedAt, now)?.let { "Last evaluated $it" } ?: "Not evaluated yet"

    /** "Expires in 23h" while the watch is live, "Expired 2h ago" once it did, null otherwise. */
    fun deadline(watch: Watch, now: Instant): String? {
        val expiresAt = WatchTime.parse(watch.expiresAt) ?: return null
        if (WatchStateMachine.isLive(watch.state)) {
            val left = WatchTime.seconds(now, expiresAt)
            return if (left > 0) "Expires in ${duration(left)}" else "Expiring now"
        }
        if (watch.state == WatchState.EXPIRED) WatchTime.format(watch.expiresAt, now)?.let { return "Expired $it" }
        return null
    }

    /** A span short enough for a row: "45s", "12m", "3h 20m", "23h", "2d 4h", "12d" (the browser's `formatSpan`). */
    fun duration(seconds: Double): String {
        val s = maxOf(0.0, seconds).toInt()
        if (s < 60) return "${maxOf(1, s)}s"
        if (s < 3_600) return "${s / 60}m"
        if (s < 86_400) {
            val h = s / 3_600
            val m = (s % 3_600) / 60
            return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h"
        }
        val d = s / 86_400
        val h = (s % 86_400) / 3_600
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }

    /** The watch's latest delivery in words; null until there is one. */
    fun deliveryStatus(watch: Watch): String? = deliveries(watch).lastOrNull()?.let(::deliveryStatus)

    /** One delivery in words. A RESUME_SESSION delivery is done once its turn is queued (§6). */
    fun deliveryStatus(delivery: WatchDelivery): String? = when (delivery.state) {
        WatchDeliveryState.PENDING, WatchDeliveryState.IN_FLIGHT ->
            if (delivery.attempts > 0) WatchAttention.DeliveryRetrying(delivery.attempts).text else "Delivering"
        WatchDeliveryState.DELIVERED -> if (delivery.action == WatchAction.NOTIFY_USER) "Notification sent" else "Resume queued"
        // Taken back on purpose before it ran, which is no failure.
        WatchDeliveryState.DEAD_LETTER -> if (!WatchDeadLetter.needsAttention(delivery)) "Wake withdrawn"
            else WatchAttention.DeliveryFailed(delivery.lastError).text
        WatchDeliveryState.UNKNOWN -> null
    }

    /** How a RESUME_SESSION watch that never matched ended, as its history names it. */
    fun endTitle(kind: WatchEndDelivery.Kind): String = when (kind) {
        WatchEndDelivery.Kind.EXPIRY -> "Expired before it matched"
        WatchEndDelivery.Kind.REVOKED -> "Stopped: access to its targets was revoked"
        WatchEndDelivery.Kind.UNRESOLVABLE -> "Stopped: every target was deleted"
        WatchEndDelivery.Kind.UNKNOWN -> "Ended"
    }

    /** What Stop costs, said before it happens: CANCELLED is the one end nobody is told about (§3). */
    fun stopWarning(watch: Watch): String = when (watch.action) {
        WatchAction.RESUME_SESSION -> "The waiting session won't be resumed, and it isn't told the watch stopped."
        WatchAction.NOTIFY_USER, WatchAction.UNKNOWN -> "You won't be notified when the condition holds."
    }

    // MARK: the console strip's words (the browser's `STRIP_*`, held by `watch-strip.fixture.json`)

    const val STRIP_LABEL = "Watching"
    /** The strip's old way to the Following page; iOS dropped the footer that said it, and so does this client. */
    const val STRIP_MANAGE = "Manage in Watches ›"
    const val STRIP_OPEN_TASK = "Open task ›"
    const val STRIP_OPEN_SESSION = "Open session ›"
    const val STRIP_RESUMES = "Resumes this session when"
    const val STRIP_PAUSED = "Paused · resumes this session when"
    const val STRIP_UNREAD = "its condition is met"
    const val STRIP_NOT_CHECKED = "Not checked for"
    const val STRIP_MAY_BE_LATE = "the resume may be late."

    /** What an opened strip says about one watch, in one sentence — "Resumes this session when it finishes, or in
     * 13d at the latest." The browser's `stripSentence`. (The iOS strip no longer draws it; it is held to the
     * shared fixture so the words stay one sentence at both ends.) */
    fun stripSentence(watch: Watch, now: Instant): String {
        val live = watch.targets.filter { it.state != WatchTargetState.GONE }
        val clause = if (live.size <= 1) oneTargetVerbs(watch.predicate)?.let { "it $it" } else manyTargetsClause(watch.predicate)
        val expiresAt = WatchTime.parse(watch.expiresAt)
        val tail = if (expiresAt != null) {
            val left = WatchTime.seconds(now, expiresAt)
            if (left > 0) ", or in ${duration(left)} at the latest." else ", or any moment now."
        } else "."
        val lead = if (watch.state == WatchState.PAUSED) STRIP_PAUSED else STRIP_RESUMES
        return "$lead ${clause ?: STRIP_UNREAD}$tail"
    }

    /** The line an opened strip adds under a watch nobody is checking — "Not checked for 12m — the resume may be
     * late." */
    fun stripStaleLine(watch: Watch, now: Instant): String? {
        if (WatchFreshness.of(watch, now) != WatchFreshness.STALE) return null
        val looked = WatchTime.parse(watch.lastEvaluatedAt) ?: WatchTime.parse(watch.createdAt) ?: now
        return "$STRIP_NOT_CHECKED ${duration(WatchTime.seconds(looked, now))} — $STRIP_MAY_BE_LATE"
    }

    /** A leaf in the browser's words for it (`LEAF_COPY`'s `one` and `many`). */
    fun stripVerb(leaf: WatchLeaf, many: Boolean): String? = when (leaf) {
        WatchLeaf.SESSION_TURN_SETTLED -> if (many) "finish their turns" else "finishes its turn"
        WatchLeaf.SESSION_RUN_TERMINAL -> if (many) "end" else "ends"
        WatchLeaf.SESSION_LIFECYCLE_TERMINAL -> if (many) "are moved to Completed or Trash" else "is moved to Completed or Trash"
        WatchLeaf.SESSION_NEEDS_ATTENTION -> if (many) "ask for an approval" else "asks for an approval"
        WatchLeaf.TASK_TERMINAL -> if (many) "finish" else "finishes"
        WatchLeaf.TASK_DONE -> if (many) "are done" else "is done"
        WatchLeaf.TASK_FAILED -> if (many) "fail" else "fails"
        WatchLeaf.UNKNOWN -> null
    }

    /** What a condition says of one target, each fact once. Failing is one way of finishing, so an ANY_OF naming
     * both says the one. */
    private fun oneTargetVerbs(predicate: WatchPredicate): String? = when (predicate) {
        is WatchPredicate.All -> stripVerb(predicate.leaf, false)
        is WatchPredicate.Any -> stripVerb(predicate.leaf, false)
        is WatchPredicate.AllOf, is WatchPredicate.AnyOf -> {
            val operands = if (predicate is WatchPredicate.AllOf) predicate.operands else (predicate as WatchPredicate.AnyOf).operands
            val parts = operands.map(::oneTargetVerbs)
            if (parts.isEmpty() || parts.any { it == null }) null else {
                val verbs = parts.filterNotNull().distinct().toMutableList()
                if (predicate !is WatchPredicate.AnyOf) verbs.joinToString(" and ") else {
                    if (stripVerb(WatchLeaf.TASK_TERMINAL, false) in verbs) verbs.removeAll { it == stripVerb(WatchLeaf.TASK_FAILED, false) }
                    verbs.joinToString(" or ")
                }
            }
        }
        is WatchPredicate.Unknown -> null
    }

    /** What a condition says of several targets: "all of them finish or any of them fails". */
    private fun manyTargetsClause(predicate: WatchPredicate): String? = when (predicate) {
        is WatchPredicate.All -> stripVerb(predicate.leaf, true)?.let { "all of them $it" }
        is WatchPredicate.Any -> stripVerb(predicate.leaf, false)?.let { "any of them $it" }
        is WatchPredicate.AllOf, is WatchPredicate.AnyOf -> {
            val operands = if (predicate is WatchPredicate.AllOf) predicate.operands else (predicate as WatchPredicate.AnyOf).operands
            val parts = operands.map(::manyTargetsClause)
            if (parts.isEmpty() || parts.any { it == null }) null
            else parts.filterNotNull().joinToString(if (predicate is WatchPredicate.AnyOf) " or " else " and ")
        }
        is WatchPredicate.Unknown -> null
    }

    /** A task target's pill, where it itself stands in the task list's words. Null for a session and for a target
     * the watch carries no standing for. */
    fun stripPill(target: WatchTarget): WatchTaskPill? {
        val standing = target.targetStatus?.takeIf { target.targetKind == WatchTargetKind.TASK } ?: return null
        return WatchTaskPill.overlay(standing.running, standing.queued) ?: WatchTaskPill.of(standing.status)
    }

    /** A session target's standing: the glyph its own header draws for its run state. */
    fun stripGlyph(target: WatchTarget): WatchSessionGlyph? {
        val standing = target.targetStatus?.takeIf { target.targetKind == WatchTargetKind.SESSION } ?: return null
        return WatchSessionGlyph.of(standing.status)
    }

    /** The targets an opened strip lists for one watch: the live ones, what the condition has already met first. */
    fun stripTargets(watch: Watch): List<WatchTarget> {
        val live = watch.targets.filter { it.state != WatchTargetState.GONE }
        return live.filter { it.state == WatchTargetState.SATISFIED } + live.filter { it.state != WatchTargetState.SATISFIED }
    }

    data class StripCounts(val running: Int, val failed: Int, val done: Int, val total: Int)

    /** The numbers the folded line writes about several targets, each counted from where the target itself stands:
     * a task is done when its status is DONE, a session when its turn is over. A target nobody could read is only
     * counted. */
    fun stripCounts(targets: List<WatchTarget>): StripCounts {
        var running = 0; var failed = 0; var done = 0
        for (target in targets) {
            val standing = target.targetStatus ?: continue
            if (standing.running) running += 1
            if (standing.status == "FAILED") failed += 1
            else if (if (target.targetKind == WatchTargetKind.TASK) standing.status == "DONE" else !standing.running && !standing.queued) done += 1
        }
        return StripCounts(running, failed, done, targets.size)
    }

    /** A target by the name this client holds for it, and by kind and short id when it holds none. */
    fun targetTitle(kind: WatchTargetKind, id: String, name: String?): String {
        if (!name.isNullOrEmpty()) return name
        return when (kind) {
            WatchTargetKind.SESSION -> "Session ${id.take(8)}"
            WatchTargetKind.TASK -> "Task ${id.take(8)}"
            WatchTargetKind.UNKNOWN -> id
        }
    }

    /** A target's own state word. */
    fun targetStateWord(state: WatchTargetState): String = when (state) {
        WatchTargetState.OBSERVED -> "Waiting"
        WatchTargetState.SATISFIED -> "Met"
        WatchTargetState.GONE -> "Deleted"
        WatchTargetState.UNKNOWN -> "Unknown"
    }

    /** A control or a Follow that didn't go through, as one sentence. `verb` is the control's own ("pause",
     * "stop", "follow"). A 404 is this surface's own reading — a watch that is gone is gone. */
    fun failureMessage(error: Throwable, verb: String): String {
        val reason = if (error is ApiError && error.status == 404) "it no longer exists" else failureReason(error)
        return "Couldn't $verb the watch — $reason."
    }

    /** OrbitKit `APIClient.failureReason`: what the server said, else what went wrong in this client's words. */
    fun failureReason(error: Throwable): String = when (error) {
        is ApiError -> if (error.status == 401) "you're signed out" else serverMessage(error) ?: "the server returned ${error.status}"
        is SessionChanged -> "you're signed out"
        is NetworkException -> "the connection dropped"
        is ProtocolException -> "the server's reply couldn't be read"
        else -> error.message ?: error.toString()
    }

    /** OrbitKit `ComposerLogic.serverMessage`: the body's `message` (or its lines), else its `error`, else the body. */
    private fun serverMessage(error: ApiError): String? {
        if (error.messages.any(String::isNotEmpty)) return error.messages.joinToString("\n")
        val body: JsonElement = error.body ?: return null
        ((body as? JsonObject)?.get("error") as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() }?.let { return it.content }
        return if (body is JsonObject || body is JsonArray) body.toString() else null
    }
}

/** A session as an observer: the live watches that resume it when they match (OrbitKit `WatchSessionSummary`). */
internal data class WatchSessionSummary(
    /** Live RESUME_SESSION watches whose observer is the session. Never empty. */
    val watches: List<Watch>,
) {
    private val active get() = watches.filter { it.state == WatchState.ACTIVE }

    /** "Watching 7 targets" — the targets still in the set, each counted once across the ACTIVE watches — or
     * "Watch paused" when every one of them is paused. */
    val word: String get() {
        if (active.isEmpty()) return if (watches.size == 1) "Watch paused" else "${watches.size} watches paused"
        val seen = active.flatMap { it.targets }.filter { it.state != WatchTargetState.GONE }
            .map { "${it.targetKind.name}:${watchKey(it.targetResourceId)}" }.toSet()
        return WatchProjection.watchingLabel(seen.size)
    }

    /** One watch's progress, or how many watches there are when there are several. */
    val progress: String get() = if (watches.size == 1) WatchProjection.progress(watches[0]) else "${watches.size} watches"

    /** The distinct targets still in the set, each counted once across every watch. */
    private val lineTargets: List<WatchTarget> get() {
        val seen = mutableSetOf<String>()
        return watches.flatMap { it.targets }.filter { it.state != WatchTargetState.GONE }
            .filter { seen.add("${it.targetKind.name}:${watchKey(it.targetResourceId)}") }
    }

    /** The one target a lone watch over one target that still exists names; null when the line counts instead. */
    val lineTarget: WatchTarget? get() = lineTargets.takeIf { watches.size == 1 && it.size == 1 }?.single()

    val lineTargetCount: Int get() = lineTargets.size

    /** The line's middle when it names no lone target: one watch states its own threshold, several count the
     * targets they cover. */
    val lineTargetWord: String get() {
        if (watches.size != 1) return "$lineTargetCount ${WatchProjection.targetNoun(watches, lineTargetCount)}"
        return WatchProjection.thresholdLabel(watches[0].predicate, lineTargets, watches)
    }

    /** Tasks created here's sentence over the distinct live targets (`2 running · 1 failed · 4/8 done`). */
    val lineParts: List<WatchCountCopy.Part> get() {
        val counts = WatchProjection.stripCounts(lineTargets)
        return WatchCountCopy.parts(counts.running, counts.failed, counts.done, counts.total)
    }

    /** The strip's one line in one string, as a session list row says it. */
    val rowLine: String get() {
        val target = lineTarget
        val what = if (target != null) WatchProjection.targetTitle(target.targetKind, target.targetResourceId, target.targetTitle)
            else (listOf(lineTargetWord) + lineParts.map { it.text }).joinToString(WatchCountCopy.SEPARATOR)
        return if (active.isEmpty()) word + WatchCountCopy.SEPARATOR + what else "${WatchProjection.STRIP_LABEL} $what"
    }

    /** The oldest last look among the ACTIVE watches; null while they're all paused. */
    fun lastEvaluated(now: Instant): String? {
        if (active.isEmpty()) return null
        val oldest = active.minBy { WatchTime.parse(it.lastEvaluatedAt) ?: Instant.MIN }
        return WatchProjection.lastEvaluated(oldest, now)
    }

    companion object {
        /** Null when nothing live will resume the session. */
        fun of(sessionId: String, watches: List<Watch>): WatchSessionSummary? =
            WatchIndex.observing(sessionId, watches).takeIf { it.isNotEmpty() }?.let(::WatchSessionSummary)
    }
}

/** Finding watches in a fetched list (OrbitKit `WatchIndex`). */
internal object WatchIndex {
    /** The live RESUME_SESSION watches that will resume this session. */
    fun observing(sessionId: String, watches: List<Watch>): List<Watch> {
        val key = watchKey(sessionId)
        return watches.filter { resumes(it) && it.observerSessionId?.let(::watchKey) == key }
    }

    /** Every observed session's summary, keyed by [watchKey] of its id. */
    fun summariesByObserver(watches: List<Watch>): Map<String, WatchSessionSummary> {
        val observing = linkedMapOf<String, MutableList<Watch>>()
        for (watch in watches) {
            if (!resumes(watch)) continue
            val observer = watch.observerSessionId ?: continue
            observing.getOrPut(watchKey(observer)) { mutableListOf() }.add(watch)
        }
        return observing.mapValues { WatchSessionSummary(it.value) }
    }

    /** Still live, and resumes its observer when it matches. */
    private fun resumes(watch: Watch) = WatchStateMachine.isLive(watch.state) && watch.action == WatchAction.RESUME_SESSION

    /** A watch by either spelling of its id: a push names its UUID, the API its public id. */
    fun find(id: String, watches: List<Watch>): Watch? {
        val key = watchKey(id)
        return watches.firstOrNull { watchKey(it.id) == key }
    }

    /** Several fetched lists as one: each watch once (the first copy wins), newest first. */
    fun merge(lists: List<List<Watch>>): List<Watch> {
        val seen = mutableSetOf<String>()
        return lists.flatten().filter { seen.add(watchKey(it.id)) }
            .sortedByDescending { WatchTime.parse(it.createdAt) ?: Instant.MIN }
    }

    /** `watches` with `updated` in place of its older copy, or added at the front if it wasn't there. */
    fun replacing(updated: Watch, watches: List<Watch>): List<Watch> {
        val key = watchKey(updated.id)
        val index = watches.indexOfFirst { watchKey(it.id) == key }
        if (index < 0) return listOf(updated) + watches
        return watches.toMutableList().also { it[index] = updated }
    }
}
