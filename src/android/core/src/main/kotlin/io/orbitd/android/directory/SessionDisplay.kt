package io.orbitd.android.directory

import io.orbitd.android.core.protocol.SessionFacts
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * What every Android surface draws for a session's state (the approved board, docs/mocks/session-display-three-states,
 * capture/rules.mjs minus its Disconnected mark: the owner's approval of 2026-11-25; web `lib/sessionDisplay.ts`). Two functions:
 *
 * - [SessionDisplay.state]: the state icon and word, from `phase` alone. Exactly three.
 * - [SessionDisplay.marks]: everything that is not activity, one mark per fact the server sends, in drawing order.
 *
 * In `core`, so the guest view's states (core/guests) call the same two functions the app's surfaces do.
 *
 * Both answer null for a payload from a control plane too old to send `phase` and `released`: the surface then draws exactly what it
 * drew before (pinned by LegacyBaselineTest).
 */
enum class SessionDisplayState(val word: String, val icon: Icon) {
    QUEUED("Queued", Icon.CLOCK), RUNNING("Running", Icon.SPINNER), IDLE("Idle", Icon.CIRCLE);

    enum class Icon { CLOCK, SPINNER, CIRCLE }
}

/** One mark per fact. [tone] is the only colour a mark may carry: amber = the person has to act, red = a failure nobody is retrying,
 * green = the work finished, grey = everything else. */
enum class SessionMark(val word: String, val tone: Tone) {
    NEEDS_YOU("Needs you", Tone.AMBER),
    FAILED("Failed", Tone.RED),
    RETRYING("Retrying", Tone.GREY),
    ON_HOLD("On hold", Tone.GREY),
    INTERRUPTED("Interrupted", Tone.GREY),
    BACKGROUND("Background", Tone.GREY),
    WILL_RESUME("Will resume", Tone.GREY),
    FINISHED("Finished", Tone.GREEN),
    ENDED("Ended", Tone.GREY);

    enum class Tone { AMBER, RED, GREEN, GREY }
}

object SessionDisplay {
    /** The six facts (contracts/session-state.contract.json) and the two counts beside them that a mark reads, as the payload sent them. */
    data class Facts(val phase: String?, val released: Boolean?, val lastTurnOutcome: String? = null, val waitingOn: String? = null,
        val endReason: String? = null, val workFinished: Boolean? = null, val activity: String? = null, val pendingApprovals: Int = 0,
        val runningBgCount: Int = 0)

    private fun phaseOf(f: Facts): SessionDisplayState? = when (f.phase) {
        "PENDING" -> SessionDisplayState.QUEUED
        "RUNNING" -> SessionDisplayState.RUNNING
        "IDLE" -> SessionDisplayState.IDLE
        else -> null
    }

    /** The state: `phase` alone. Null from an older control plane (no known `phase`, or no `released`). */
    fun state(f: Facts): SessionDisplayState? = phaseOf(f)?.takeIf { f.released != null }

    /** A release the server counts as a failure (decision D9): released, the last turn failed, and nobody asked for an end. */
    private fun releasedByFailure(f: Facts) = f.released == true && f.endReason.isNullOrEmpty() && f.lastTurnOutcome == "FAILED"

    /** The marks of one session, in the order they are drawn after the state word. Each reads one fact as the server sent it. A released
     * failure is red Failed whatever its error says (no client matches error text); one the server will retry (`waitingOn` WAKE) is grey
     * Retrying instead. Null from an older control plane. */
    fun marks(f: Facts): List<SessionMark>? {
        val state = state(f) ?: return null
        val released = f.released == true
        val failure = releasedByFailure(f)
        return buildList {
            if (f.waitingOn == "PERSON" || f.pendingApprovals > 0) add(SessionMark.NEEDS_YOU)
            if (failure) add(if (f.waitingOn == "WAKE") SessionMark.RETRYING else SessionMark.FAILED)
            if (f.waitingOn == "HOLD") add(SessionMark.ON_HOLD)
            if (!released && state == SessionDisplayState.IDLE && f.lastTurnOutcome == "INTERRUPTED") add(SessionMark.INTERRUPTED)
            if (!released && (f.activity == "BACKGROUND_JOB" || f.runningBgCount > 0)) add(SessionMark.BACKGROUND)
            // An idle session a watch or wake-up will resume is just Idle: no mark (the owner, 2026-11-27).
            if (!released && f.waitingOn == "WAKE" && phaseOf(f) != SessionDisplayState.IDLE) add(SessionMark.WILL_RESUME)
            if (released && f.workFinished == true) add(SessionMark.FINISHED)
            if (released && f.workFinished != true && !failure && !SessionFacts.releasedByMove(f.released, f.endReason)) add(SessionMark.ENDED)
        }
    }

    /** The state word and the marks as one line, [separator] between them: " · " in Markdown (`Idle · Finished`), ", " where a
     * screen reader says them. Null from an older control plane. */
    fun text(f: Facts, separator: String = " · "): String? {
        val state = state(f) ?: return null
        return (listOf(state.word) + marks(f).orEmpty().map { it.word }).joinToString(separator)
    }

    /** The facts of a session ref as a task or a link carries it. */
    fun facts(o: JsonObject): Facts = Facts(SessionFacts.phase(o), SessionFacts.released(o), SessionFacts.lastTurnOutcome(o), SessionFacts.waitingOn(o),
        SessionFacts.endReason(o), SessionFacts.workFinished(o), (o["activity"] as? JsonPrimitive)?.contentOrNull,
        (o["pendingApprovals"] as? JsonPrimitive)?.intOrNull ?: 0, (o["runningBgCount"] as? JsonPrimitive)?.intOrNull ?: 0)
}
