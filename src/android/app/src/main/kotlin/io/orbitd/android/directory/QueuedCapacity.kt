package io.orbitd.android.directory

import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** A turn running over its runner's limit, as `GET /sessions` says it (web `RunningOverLimit`). */
data class RunningOverLimit(val active: Int, val limit: Int, val runnerName: String? = null) {
    companion object {
        /** Read leniently, as [QueuedRunnerUpdate.of]: a shape this build cannot read is no tag. */
        fun of(json: JsonElement?): RunningOverLimit? {
            val o = json as? JsonObject ?: return null
            fun int(key: String) = (o[key] as? JsonPrimitive)?.intOrNull
            return RunningOverLimit(int("active") ?: return null, int("limit") ?: return null,
                (o["runnerName"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull)
        }
    }
}

/**
 * A session queued behind a full runner, run or batch (queuedReason `runner_at_capacity`, `tree_at_capacity`, `batch_at_capacity`;
 * docs/mocks/queued-card-runner-full, approved as recommended): the list's and header's word, the foot-row tag `Queued · runner full` on
 * each turn still waiting for its own turn, drawn where `Queued · runner updating` is, and the popover that counts how the slots are
 * taken. A runner counts a session against its maxConcurrent while it runs a turn OR while a background job of its own still runs, so it
 * can be full with fewer turns than slots: the server reports those slots apart as `queuedHeldByJobs`. Every word a port of web
 * `queuedCapacity.ts`'s (OrbitKit `QueuedCapacity`), held to that source by QueuedCapacityCopyParityTest.
 */
internal object QueuedCapacity {
    val REASONS = setOf("runner_at_capacity", "tree_at_capacity", "batch_at_capacity")
    const val RUNNER_FULL_TITLE = "Runner full"
    const val RUNNER_FULL_TAG = "runner full"
    const val RUN_FULL_TITLE = "Run full"
    const val RUN_FULL_TAG = "run full"
    const val BATCH_FULL_TITLE = "Batch full"
    const val BATCH_FULL_TAG = "batch full"
    /** The session list's line for any of the three (board session-row-runner-full, the owner's pick C; web `CAPACITY_HELD_LINE`). The
     * row's own time already counts the wait, so the line adds no clock. */
    const val CAPACITY_HELD_LINE = "Waiting for a free slot"
    /** The popover's button on a held message (docs/mocks/queued-run-now): start this one turn over the limit. */
    const val RUN_NOW = "Run now"
    const val RUN_NOW_FAILED = "Couldn't run now"
    /** The runner setting that bounds how far over its limit Run now may take it. */
    const val EXTRA_SESSIONS_ON_DEMAND = "Extra sessions on demand"
    /** The ceiling the server enforces for `burstConcurrent` (web `MAX_EXTRA_SESSIONS`). */
    const val MAX_EXTRA_SESSIONS = 32

    /**
     * The line under Run now (web `runNowNote`): the server's refusal sentence where it cannot press, else what pressing does. Null,
     * which draws no button either, on a gate no slot holds and from a server that does not offer Run now. [runnerActive] and
     * [runnerLimit] are the runner's own slots, which a full run or batch counts from.
     */
    fun runNowNote(gate: QueuedGate, machine: String?, runnerActive: Int? = null, runnerLimit: Int? = null): String? {
        if (!isCapacityHeld(gate)) return null
        gate.runNowRefusal?.takeIf { it.isNotEmpty() }?.let { return it }
        if (!gate.runNowAvailable) return null
        val runnerFull = gate.queuedReason == "runner_at_capacity"
        val active = if (runnerFull) gate.queuedActive ?: runnerActive else runnerActive
        val limit = if (runnerFull) gate.queuedLimit ?: runnerLimit else runnerLimit
        if (active == null || limit == null) return "Starts this turn now. The limit stays the same."
        val next = active + 1
        val suffix = if (next % 100 in 11..13) "th" else when (next % 10) { 1 -> "st"; 2 -> "nd"; 3 -> "rd"; else -> "th" }
        val where = machine?.trim()?.takeIf { it.isNotEmpty() }?.let { "on $it" } ?: "on this runner"
        return "Starts it as the $next$suffix session $where. This turn only; the limit stays $limit."
    }

    /** The amber tag on a turn running over its runner's limit (web `runningOverLimitTag`). */
    fun overLimitTag(overflow: RunningOverLimit): String = "over limit · ${overflow.active}/${overflow.limit}"

    /** What the tag says when pressed (web `runningOverLimitHint`). */
    fun overLimitHint(overflow: RunningOverLimit): String {
        val runner = overflow.runnerName?.trim()?.takeIf { it.isNotEmpty() }
        return if (runner != null) "Started over $runner's limit by you" else "Started over the runner's limit by you"
    }

    /** Whether a full runner, run or batch holds this queued session (web `isCapacityHeld`). */
    fun isCapacityHeld(gate: QueuedGate?): Boolean = gate?.queuedReason in REASONS

    /** `Runner full`, `Run full` or `Batch full` (web `capacityHeldTitle`). */
    fun title(gate: QueuedGate): String = when (gate.queuedReason) {
        "tree_at_capacity" -> RUN_FULL_TITLE
        "batch_at_capacity" -> BATCH_FULL_TITLE
        else -> RUNNER_FULL_TITLE
    }

    /** The foot-row tag's words: `runner full`, `run full` or `batch full` (web `capacityHeldTag`). */
    fun tag(gate: QueuedGate): String = when (gate.queuedReason) {
        "tree_at_capacity" -> RUN_FULL_TAG
        "batch_at_capacity" -> BATCH_FULL_TAG
        else -> RUNNER_FULL_TAG
    }

    private fun counted(gate: QueuedGate): String {
        val active = gate.queuedActive ?: return ""
        val limit = gate.queuedLimit ?: return ""
        return " ($active/$limit)"
    }

    /** What the tag opens (board ③ and ⑤; web `capacityHeldMessageText`). */
    fun messageText(gate: QueuedGate, machine: String?): String {
        if (gate.queuedReason == "tree_at_capacity") {
            return "This run is already using all its slots${counted(gate)}. This message is sent as soon as one of its sessions finishes."
        }
        if (gate.queuedReason == "batch_at_capacity") {
            return "This batch is running its maximum${counted(gate)}. This message is sent as soon as one of its sessions finishes."
        }
        val who = machine?.trim()?.takeIf { it.isNotEmpty() } ?: RunnerUpdating.THE_RUNNER
        val active = gate.queuedActive
        val limit = gate.queuedLimit
        if (active == null || limit == null) return "$who is using all its slots. This message is sent as soon as one frees up."
        val held = gate.queuedHeldByJobs ?: 0
        if (held > 0) {
            val turns = maxOf(0, active - held)
            val running = if (turns == 1) "1 session is running a turn" else "$turns sessions are running a turn"
            return "$who is using all $limit slots: $running and $held ${if (held == 1) "holds" else "hold"} a slot with a background job. This message is sent as soon as one frees up."
        }
        val sessions = if (limit == 1) "1 session" else "$limit sessions"
        return "$who is running $active of $sessions. This message is sent as soon as one finishes."
    }

    /** The same gate's sentence, said of a scheduled run waiting for its first turn. */
    fun runText(gate: QueuedGate, machine: String?): String =
        messageText(gate, machine).replace("This message is sent", "The run starts")

    /** `Waiting 15 min`, from when the session went PENDING; null with no clock to read (web `capacityHeldWaited`). */
    fun waited(gate: QueuedGate, now: Instant): String? {
        val since = gate.since ?: return null
        val at = runCatching { Instant.parse(since) }.getOrNull() ?: return null
        if (at.isAfter(now)) return null
        val minutes = (now.toEpochMilli() - at.toEpochMilli()) / 60_000
        if (minutes < 1) return RunnerUpdating.LESS_THAN_A_MINUTE
        if (minutes < 60) return "Waiting $minutes min"
        val rest = minutes % 60
        return "Waiting ${minutes / 60} h${if (rest != 0L) " $rest min" else ""}"
    }
}
