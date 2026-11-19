package io.orbitd.android.reader

import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.LandingCheckCopy

// A landing's timeline read as the session chat reads a turn (owner 2026-11-11, docs/mocks/landings-chat-tools-native): one attempt's
// lines gathered into a few steps — the queue, the claim, the sync onto the line, each check, and the push (or the merge into main) —
// each drawn as one of the chat's tool rows. Every line stays the server's own sentence; a step only groups them, and its summary is
// one of its own lines. A direct port of `src/web/src/lib/landingSteps.ts` and OrbitKit's `LandingSteps`, held to the web's words by
// LandingStepsTest.

/** The words, as the web's `LANDING_STEP_COPY` and the window's `WINDOW_COPY` write them. */
internal object LandingStepCopy {
    const val QUEUE = "Queue"
    const val CLAIM = "Claim"
    const val SYNC = "Sync"
    const val PUSH = "Push"
    const val MERGE = "Merge"
    const val RESULT = "Result"
    const val CHECK = "check"
    const val DETAILS = "Details"
    const val WORKING_FOR = "Working for"
}

/** One step: [key] is `queue`, `claim`, `sync`, `check:TASK_ACCEPTANCE`, `check:MERGE_CHECK` or `push`; [entries] its lines with their
 *  index in the section; [summary] the line its folded row says; [at] its newest line's instant. */
internal data class LandingStep(val key: String, val name: String, val entries: List<IndexedValue<LandingEntry>>,
    val summary: LandingEntry, val at: String)

internal object LandingSteps {
    private val ORDER = listOf("queue", "claim", "sync", "check:TASK_ACCEPTANCE", "check:LANDING_CHECK", "check:BASELINE", "check:MERGE_CHECK", "push")

    /** The kinds a step's folded row prefers to say: how it ended. */
    private val VERDICTS = setOf("CHECK_FINISHED", "SKIPPED_CHECK", "RESULT", "RESULT_FALLBACK", "PUSH_REFUSED",
        "CANCELLED", "TIMED_OUT", "ABANDONED", "STOP_REQUESTED", "HANDED_TO")

    /** Results that mean the push (or the merge into main) happened, or that nothing needed one. */
    private val PUSHED_STATES = setOf("LANDED", "ALREADY_LANDED", "NOTHING_TO_LAND", "READY", "OBSERVED")

    /** The lines that say a step stopped short. */
    private val FAILURES = setOf("STOP_REQUESTED", "CANCELLED", "ABANDONED", "TIMED_OUT", "PUSH_REFUSED")

    private fun checkKey(entry: LandingEntry) = if (entry.data?.text("scope") == "BASELINE") "check:BASELINE" else if (entry.checkName == "LANDING_CHECK") "check:LANDING_CHECK" else if (entry.checkName == "TASK_ACCEPTANCE") "check:TASK_ACCEPTANCE" else "check:MERGE_CHECK"

    /** Which step a line belongs to; [current] is the step the attempt was last in. */
    private fun stepOf(entry: LandingEntry, current: String?): String = when (entry.kind) {
        "ENQUEUED", "REQUEUED", "NEXT_GENERATION", "FIX_TASK", "RETRY", "AUTOMATIC_ATTEMPT", "CONFIRMATION", "HANDLING" -> current ?: "queue"
        "CLAIMED", "TAKEN_OVER", "RELEASED" -> "claim"
        "ROUND", "RECHECK_ON_MOVED_MAIN" -> "sync"
        "CHECK_STARTED", "CHECK_FINISHED" -> checkKey(entry)
        "SKIPPED_CHECK" -> checkKey(entry)
        "PUSH_REFUSED" -> "push"
        // A result that landed or merged belongs to the push; one that stopped (a failed check, a conflict, an error) to the step it
        // stopped in, so no Push row says it failed to push.
        "RESULT", "RESULT_FALLBACK" -> if (entry.data?.text("state") in PUSHED_STATES) "push" else current ?: "push"
        "STEP" -> when (entry.phase) {
            "FETCH", "MAIN_SYNC", "REBASE", "MERGE" -> "sync"
            "CHECK" -> current?.takeIf { it.startsWith("check:") } ?: "check:MERGE_CHECK"
            "VERIFY", "PUSH", "OBSERVE" -> "push"
            else -> current ?: "claim"
        }
        // A stop, a cancel, a timeout, a hand-off: where the attempt was when it happened.
        else -> current ?: "queue"
    }

    private fun name(key: String, kind: String) = when (key) {
        "queue" -> LandingStepCopy.QUEUE
        "claim" -> LandingStepCopy.CLAIM
        "sync" -> LandingStepCopy.SYNC
        "check:TASK_ACCEPTANCE" -> LandingSessionModel.checkLabel("TASK_ACCEPTANCE")
        "check:LANDING_CHECK", "check:BASELINE" -> LandingCheckCopy.label
        "check:MERGE_CHECK" -> LandingSessionModel.checkLabel("MERGE_CHECK")
        else -> when (kind) {
            "LAND_TASK" -> LandingStepCopy.PUSH
            "LAND_PROMOTION" -> LandingStepCopy.MERGE
            else -> LandingStepCopy.RESULT
        }
    }

    /** One attempt's lines as its steps, in the order a landing goes through them. */
    fun steps(entries: List<LandingEntry>, kind: String): List<LandingStep> {
        val groups = mutableMapOf<String, MutableList<IndexedValue<LandingEntry>>>()
        var current: String? = null
        entries.forEachIndexed { index, entry ->
            val key = stepOf(entry, current)
            current = key
            groups.getOrPut(key) { mutableListOf() }.add(IndexedValue(index, entry))
        }
        return ORDER.mapNotNull { key ->
            val group = groups[key] ?: return@mapNotNull null
            val verdict = group.lastOrNull { it.value.kind in VERDICTS }?.value
            val summary = verdict ?: if (key == "queue" || key == "claim") group.first().value else group.last().value
            LandingStep(key, name(key, kind), group, summary, group.last().value.at)
        }
    }

    /** A step stopped short: one of its lines is a stop or a refusal, or a check or result that did not end well. */
    fun failed(step: LandingStep, kind: String): Boolean = step.entries.any { (_, entry) ->
        entry.data?.text("skipped") != "PATHS_EXEMPT" && (entry.kind in FAILURES || (entry.kind in setOf("CHECK_FINISHED", "RESULT", "RESULT_FALLBACK") && !LandingSessionModel.entryOk(entry, kind)))
    }

    /** How long a landing's checks took together; null when none recorded a duration. */
    fun checksDurationMs(durations: List<Int?>): Int? = durations.sumOf { it ?: 0 }.takeIf { it > 0 }
}
