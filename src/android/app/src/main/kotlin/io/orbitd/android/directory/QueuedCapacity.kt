package io.orbitd.android.directory

import java.time.Instant

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
