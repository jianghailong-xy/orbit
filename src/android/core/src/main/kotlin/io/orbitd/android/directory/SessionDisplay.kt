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
 * grey = everything else. */
enum class SessionMark(val word: String, val tone: Tone) {
    NEEDS_YOU("Needs you", Tone.AMBER),
    FAILED("Failed", Tone.RED),
    RETRYING("Retrying", Tone.GREY),
    ON_HOLD("On hold", Tone.GREY);

    enum class Tone { AMBER, RED, GREY }
}

/** A fact a list row draws as an icon at the end of its title line instead of a chip (the owner, 2026-11-27; web `sessionRowIcons`): a
 * release by a failure (Failed, or Retrying when the server will retry it) and a held queued turn (On hold), which every other surface
 * still draws as marks; and background work still running and a wake (a watch, a scheduled wake-up or an armed retry) that will resume
 * a held session, which no other surface draws. [tip] is its label; [red] is Failed's colour. Interrupted, Finished and Ended are not
 * drawn at all. */
enum class SessionRowIcon(val tip: String, val red: Boolean = false) {
    FAILED(SessionMark.FAILED.word, red = true),
    RETRYING(SessionMark.RETRYING.word),
    ON_HOLD(SessionMark.ON_HOLD.word),
    BACKGROUND("Background work running"),
    WILL_RESUME("Will resume");

    companion object {
        /** The icon a list row draws for [mark] instead of its chip, if any. */
        fun of(mark: SessionMark): SessionRowIcon? = when (mark) {
            SessionMark.FAILED -> FAILED
            SessionMark.RETRYING -> RETRYING
            SessionMark.ON_HOLD -> ON_HOLD
            else -> null
        }
    }
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
        if (state(f) == null) return null
        val failure = releasedByFailure(f)
        return buildList {
            if (f.waitingOn == "PERSON" || f.pendingApprovals > 0) add(SessionMark.NEEDS_YOU)
            if (failure) add(if (f.waitingOn == "WAKE") SessionMark.RETRYING else SessionMark.FAILED)
            if (f.waitingOn == "HOLD") add(SessionMark.ON_HOLD)
        }
    }

    /** The chips a list row draws after its line: the marks less those it draws as title-line icons, so Needs you alone. Null from an
     * older control plane. */
    fun rowMarks(f: Facts): List<SessionMark>? = marks(f)?.filter { SessionRowIcon.of(it) == null }

    /** The title-line icons of a list row, in drawing order: Failed / Retrying and On hold (the marks of those names), then Background and
     * Will resume for a held session. */
    fun rowIcons(f: Facts): List<SessionRowIcon> = buildList {
        marks(f).orEmpty().mapNotNullTo(this) { SessionRowIcon.of(it) }
        if (state(f) == null || f.released == true) return@buildList
        if (f.activity == "BACKGROUND_JOB" || f.runningBgCount > 0) add(SessionRowIcon.BACKGROUND)
        if (f.waitingOn == "WAKE") add(SessionRowIcon.WILL_RESUME)
    }

    /** The state word and the marks as one line, [separator] between them: " · " in Markdown (`Idle · Needs you`), ", " where a
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
