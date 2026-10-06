package io.orbitd.android.watch

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.*
import java.time.Instant
import kotlinx.serialization.json.*

/** Fixed Swift WatchProjection/WatchEditing vocabulary, including unknown v2 predicate fallback. */
object WatchProjection {
    val deadlines = listOf(3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000)
    private fun leaf(kind: String, name: String) = buildJsonObject { put("kind", kind); put("over", "ALL_TARGETS"); put("leaf", name) }
    val followConditions = listOf(leaf("ALL", "TASK_TERMINAL"), buildJsonObject {
        put("kind", "ANY_OF"); putJsonArray("operands") { add(leaf("ALL", "TASK_TERMINAL")); add(leaf("ANY", "TASK_FAILED")) }
    }, leaf("ALL", "TASK_DONE"), leaf("ANY", "TASK_FAILED"))
    fun deadlineTitle(seconds: Int): String = if (seconds % 86_400 == 0) "${seconds / 86_400} ${if (seconds == 86_400) "day" else "days"}"
        else "${seconds / 3_600} ${if (seconds == 3_600) "hour" else "hours"}"

    fun instant(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }
    fun span(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        return when {
            s < 60 -> "${s.coerceAtLeast(1)}s"
            s < 3_600 -> "${s / 60}m"
            s < 86_400 -> "${s / 3_600}h" + if (s / 3_600 < 6 && s % 3_600 / 60 > 0) " ${s % 3_600 / 60}m" else ""
            else -> "${s / 86_400}d" + if (s / 86_400 < 3 && s % 86_400 / 3_600 > 0) " ${s % 86_400 / 3_600}h" else ""
        }
    }
    fun relative(value: String?, now: Instant): String? = instant(value)?.let { "${span(now.epochSecond - it.epochSecond)} ago" }
    fun stale(watch: WatchRecord, now: Instant): Boolean = watch.state == "ACTIVE" &&
        (instant(watch.raw.text("lastEvaluatedAt")) ?: instant(watch.raw.text("createdAt")))?.let { now.epochSecond - it.epochSecond > 180 } == true
    fun staleLine(watch: WatchRecord, now: Instant): String? = if (!stale(watch, now)) null else {
        val checked = instant(watch.raw.text("lastEvaluatedAt")) ?: instant(watch.raw.text("createdAt")) ?: now
        "Not checked for ${span(now.epochSecond - checked.epochSecond)} — the resume may be late."
    }
    fun checked(watch: WatchRecord, now: Instant) = relative(watch.raw.text("lastEvaluatedAt"), now)?.let { "Last evaluated $it" } ?: "Not evaluated yet"
    fun deadline(watch: WatchRecord, now: Instant): String? {
        val whenAt = instant(watch.raw.text("expiresAt")) ?: return null
        return if (watch.live) if (whenAt > now) "Expires in ${span(whenAt.epochSecond - now.epochSecond)}" else "Expiring now"
        else if (watch.state == "EXPIRED") "Expired ${relative(watch.raw.text("expiresAt"), now)}" else null
    }
    fun headline(watch: WatchRecord): String = when (watch.state) {
        "ACTIVE" -> "Watching ${targetCount(watch.liveTargets.size)}"
        "PAUSED" -> "Paused · ${targetCount(watch.liveTargets.size)}"
        "MATCHED" -> "Matched"; "EXPIRED" -> "Expired"; "CANCELLED" -> "Stopped"
        "REVOKED" -> "Access revoked"; "UNRESOLVABLE" -> "Every target is gone"; else -> "Unknown state"
    }
    private fun targetCount(n: Int) = "$n ${if (n == 1) "target" else "targets"}"
    private val words = mapOf(
        "SESSION_TURN_SETTLED" to Triple("finishes its turn", "finish their turn", "finished their turn"),
        "SESSION_RUN_TERMINAL" to Triple("ends its run", "end their run", "ended"),
        "SESSION_LIFECYCLE_TERMINAL" to Triple("is completed or trashed", "are completed or trashed", "completed or trashed"),
        "SESSION_NEEDS_ATTENTION" to Triple("needs attention", "need attention", "need attention"),
        "TASK_TERMINAL" to Triple("finishes", "finish", "finished"),
        "TASK_DONE" to Triple("is done", "are done", "done"),
        "TASK_FAILED" to Triple("fails", "fail", "failed"),
    )
    private const val unknown = "a condition this version of Orbit can't show"
    fun condition(predicate: JsonObject, count: Int): String = sentence(predicate, count == 1).replaceFirstChar(Char::uppercase)
    private fun sentence(predicate: JsonObject, single: Boolean, nested: Boolean = false): String {
        return when (predicate.text("kind")) {
            "ALL", "ANY" -> {
                if (predicate.text("over") != "ALL_TARGETS") return unknown
                val name = predicate.text("leaf") ?: return unknown
                val verb = words[name] ?: return unknown
                val noun = if (name.startsWith("TASK_")) "task" else "session"
                if (single) "the $noun ${verb.first}"
                else if (predicate.text("kind") == "ALL") "all ${noun}s ${verb.second}" else "any $noun ${verb.first}"
            }
            "ALL_OF", "ANY_OF" -> {
                val operands = predicate.objects("operands")
                if (operands.isEmpty()) return unknown
                val text = operands.joinToString(if (predicate.text("kind") == "ALL_OF") " and " else ", or ") { sentence(it, single, true) }
                if (nested) "($text)" else text
            }
            else -> unknown
        }
    }
    private fun leaves(predicate: JsonObject): Set<String> = when (predicate.text("kind")) {
        "ALL", "ANY" -> if (predicate.text("over") == "ALL_TARGETS") setOfNotNull(predicate.text("leaf")) else emptySet()
        "ALL_OF", "ANY_OF" -> predicate.objects("operands").flatMap { leaves(it) }.toSet()
        else -> emptySet()
    }
    private fun known(predicate: JsonObject): Boolean = when (predicate.text("kind")) {
        "ALL", "ANY" -> predicate.text("over") == "ALL_TARGETS" && predicate.text("leaf") in words
        "ALL_OF", "ANY_OF" -> predicate.objects("operands").isNotEmpty() && predicate.objects("operands").all(::known)
        else -> false
    }
    fun progress(watch: WatchRecord): String {
        val condition = watch.predicate
        val singleKind = if (condition.text("kind") in setOf("ALL", "ANY") && condition.text("over") == "ALL_TARGETS") condition.text("leaf")?.takeIf { it in words }?.substringBefore('_') else null
        val live = watch.liveTargets.count { singleKind == null || it.text("targetKind") == singleKind }
        val needed = if (condition.text("kind") == "ANY" && live > 0) 1 else live
        val met = watch.targets.count { it.text("state") == "SATISFIED" }
        val terms = leaves(condition).let { if (it == setOf("TASK_TERMINAL", "TASK_FAILED")) setOf("TASK_TERMINAL") else it }
        val verb = terms.singleOrNull()?.let { words[it]?.third } ?: "met"
        val gone = watch.targets.size - watch.liveTargets.size
        return (if (needed == 1) "$met $verb" else "$met of $needed $verb") + if (gone > 0) " · $gone gone" else ""
    }
    fun action(watch: WatchRecord): String = when (watch.action) {
        "RESUME_SESSION" -> "Resume the waiting session"; "NOTIFY_USER" -> "Notify you"
        else -> "An action this version of Orbit can't show"
    }
    fun stopWarning(watch: WatchRecord): String = if (watch.action == "RESUME_SESSION")
        "The waiting session won't be resumed, and it isn't told the watch stopped." else "You won't be notified when the condition holds."
    fun deliveryNeedsAttention(delivery: JsonObject) = delivery.text("state") == "DEAD_LETTER" && !delivery.text("lastError").orEmpty().startsWith("WAKE_WITHDRAWN:")
    fun delivery(delivery: JsonObject): String? = when (delivery.text("state")) {
        "PENDING", "IN_FLIGHT" -> if ((delivery.number("attempts") ?: 0) > 0) "Delivery retrying · ${delivery.number("attempts")} of 8 attempts failed" else "Delivering"
        "DELIVERED" -> if (delivery.text("action") == "NOTIFY_USER") "Notification sent" else "Resume queued"
        "DEAD_LETTER" -> if (!deliveryNeedsAttention(delivery)) "Wake withdrawn" else
            "Delivery failed" + (delivery.text("lastError")?.takeIf(String::isNotEmpty)?.let { ": $it" } ?: "")
        else -> null
    }
    fun endTitle(kind: String?): String = when (kind) {
        "EXPIRY" -> "Expired before it matched"; "REVOKED" -> "Stopped: access to its targets was revoked"
        "UNRESOLVABLE" -> "Stopped: every target was deleted"; else -> "Ended"
    }
    fun attention(watch: WatchRecord, now: Instant): List<String> = buildList {
        watch.deliveries.lastOrNull(::deliveryNeedsAttention)?.let { delivery(it)?.let(::add) }
        watch.deliveries.lastOrNull { it.text("state") in setOf("PENDING", "IN_FLIGHT") && (it.number("attempts") ?: 0) > 0 }?.let { delivery(it)?.let(::add) }
        if (watch.state == "REVOKED") add(endTitle("REVOKED"))
        if (watch.state == "UNRESOLVABLE") add(endTitle("UNRESOLVABLE"))
        if (watch.state == "EXPIRED" && watch.action == "NOTIFY_USER") add("Expired before its condition held: no notification was sent")
        if (stale(watch, now)) add("Not evaluated recently")
    }
    fun group(watch: WatchRecord, now: Instant): String = if (attention(watch, now).isNotEmpty()) "Needs attention" else if (watch.live) "Active" else "History"
    fun observing(sessionId: String, watches: List<WatchRecord>) = watches.filter { it.live && it.action == "RESUME_SESSION" && ObjectId.same(it.observer, sessionId) }
    fun targetName(target: JsonObject): String = target.text("targetTitle")?.takeIf(String::isNotEmpty) ?: when (target.text("targetKind")) {
        "TASK" -> "Task ${target.text("targetResourceId").orEmpty().take(8)}"
        "SESSION" -> "Session ${target.text("targetResourceId").orEmpty().take(8)}"; else -> target.text("targetResourceId").orEmpty()
    }
    fun targetRoute(target: JsonObject): OrbitRoute? {
        if (target.text("state") == "GONE") return null
        val destination = when (target.text("targetKind")) { "TASK" -> Destination.TASK; "SESSION" -> Destination.SESSION; else -> return null }
        val id = target.text("targetResourceId") ?: return null
        return OrbitRoute(destination, id, origin = Origin.LINK)
    }
    fun targetState(target: JsonObject): String = when (target.text("state")) {
        "SATISFIED" -> "Met"; "OBSERVED" -> "Waiting"; "GONE" -> "Deleted"; else -> "Unknown"
    }
    fun standing(target: JsonObject): String? = target.obj("targetStatus")?.let {
        when { it.flag("running") -> "Running"; it.flag("queued") -> "Queued"
            target.text("targetKind") == "SESSION" && it.text("status") == "AWAITING_INPUT" -> "Waiting for your reply"
            else -> it.text("status")?.lowercase()?.replace('_', ' ')?.replaceFirstChar(Char::uppercase) }
    }
    private fun distinctTargets(watches: List<WatchRecord>) = watches.flatMap { it.liveTargets }.distinctBy {
        "${it.text("targetKind")}:${ObjectId.canonical(it.text("targetResourceId").orEmpty()) ?: it.text("targetResourceId")}" }
    fun summaryWord(watches: List<WatchRecord>): String {
        val active = watches.filter { it.state == "ACTIVE" }
        if (active.isEmpty()) return if (watches.size == 1) "Watch paused" else "${watches.size} watches paused"
        return "Watching ${targetCount(distinctTargets(active).size)}"
    }
    /** Swift's list row states when every watch is paused; the actual band header says Watching. */
    fun rowLine(watches: List<WatchRecord>): String =
        (if (watches.none { it.state == "ACTIVE" }) summaryWord(watches) + " · " else "Watching ") + stripWhat(watches)
    fun stripLine(watches: List<WatchRecord>): String = "Watching ${stripWhat(watches)}"
    private fun stripWhat(watches: List<WatchRecord>): String {
        val targets = distinctTargets(watches)
        if (watches.size == 1 && targets.size == 1) return targetName(targets.single())
        val kinds = watches.flatMap { it.targets }.map { it.text("targetKind") }.toSet()
        val noun = if (kinds.size != 1) "target" else if (kinds.single() == "TASK") "task" else "session"
        val predicate = watches.singleOrNull()?.predicate
        val kind = predicate?.takeIf { it.text("kind") in setOf("ALL", "ANY") && it.text("over") == "ALL_TARGETS" }
            ?.text("leaf")?.takeIf { it in words }?.substringBefore('_')
        val count = targets.count { kind == null || it.text("targetKind") == kind }
        val named = "$count $noun" + if (count == 1) "" else "s"
        val threshold = when {
            count == 0 -> "no ${noun}s"
            predicate == null || !known(predicate) -> named
            predicate.text("kind") == "ANY" && count > 1 -> "any 1 of $named"
            else -> "all $named"
        }
        return "$threshold · ${countLine(targets)}"
    }
    fun countLine(targets: List<JsonObject>): String {
        val running = targets.count { it.obj("targetStatus")?.flag("running") == true }
        val failed = targets.count { it.obj("targetStatus")?.text("status") == "FAILED" }
        val done = targets.count { target -> target.obj("targetStatus")?.let { status ->
            if (target.text("targetKind") == "TASK") status.text("status") == "DONE"
            else status.text("status") != "FAILED" && !status.flag("running") && !status.flag("queued") } == true }
        val counts = listOfNotNull("$running running".takeIf { running > 0 }, "$failed failed".takeIf { failed > 0 }, "$done/${targets.size} done")
        return counts.joinToString(" · ")
    }
}
