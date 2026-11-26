package io.orbitd.android.core.guests

import io.orbitd.android.core.protocol.SessionFacts
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionDisplayState
import io.orbitd.android.directory.SessionMark
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// The guest view's and Shared with me's words and states, OrbitKit's GuestSession.swift and the web's
// (src/web/src/components/SharedWithMe.tsx, src/web/src/pages/GuestSessionPage.tsx), in the web's words.

/** The guest view's and Shared with me's words. */
object GuestCopy {
    /** The drawer's group. */
    const val SHARED_WITH_ME = "Shared with me"
    /** The badge beside the status in the guest view's head. */
    const val GUEST_BADGE = "Guest"
    /** Where a filed session is filed, said after its state and marks (web `sessionLifecycleLabel`). */
    const val COMPLETED = "Completed"
    /** What the guest door answers for every session the caller cannot reply in: removed, left, Trash or deleted. */
    const val NOT_SHARED = "This conversation is no longer shared with you."
    const val NOT_SHARED_DETAIL = "Ask the person who shared it if you need it again."
    const val LOADING = "Loading…"
    const val WAITS_ITS_TURN = "Your message waits its turn"
    const val LOAD_EARLIER = "Load earlier messages"
    const val COULD_NOT_LOAD = "Couldn't load this conversation"

    fun sharedBy(owner: String) = "Shared by $owner"
    fun placeholder(owner: String) = "Message $owner’s agent…"
    fun runsOn(owner: String) = "Runs on $owner’s machine"
    fun waiting(owner: String) = "Waiting for $owner to approve"
    fun restarts(owner: String) = "Send to continue — this restarts the session on $owner’s machine."
}

/** OrbitKit `SessionRunState`: what the run is doing or how it ended. */
enum class GuestRunState { QUEUED, RUNNING, AWAITING_INPUT, INTERRUPTED, SUCCEEDED, FAILED, ENDED;
    /** Still in a run: a message joins it rather than restarting it. */
    val isLive get() = this == QUEUED || this == RUNNING || this == AWAITING_INPUT || this == INTERRUPTED
}

/** The tone of the status pill, as the public page colours it (web `sharedStateTone`): from the facts, the state alone (QUEUED,
 * RUNNING or IDLE); from an older server, `RUN_TONE`, plus `done` for a session filed Completed. */
enum class GuestTone { QUEUED, RUNNING, IDLE, AWAITING, DONE, FAILED, CANCELLED }

/** The run state, resolved the way every other surface resolves it: the new field first, then the raw run status, then the legacy
 * mixed state (`SessionRunState.resolveOptional`). Nothing at all reads as Ended. */
val GuestState.resolvedRunState: GuestRunState get() {
    GuestRunState.entries.firstOrNull { it.name == runState }?.let { return it }
    when (runStatus) {
        "PENDING" -> return GuestRunState.QUEUED
        "RUNNING" -> return GuestRunState.RUNNING
        "AWAITING_INPUT" -> return GuestRunState.AWAITING_INPUT
        "SUCCEEDED" -> return GuestRunState.SUCCEEDED
        "FAILED" -> return GuestRunState.FAILED
        // The head carries no end reason: a bare INTERRUPTED is a stopped turn.
        "INTERRUPTED" -> return GuestRunState.INTERRUPTED
        "CANCELLED" -> return GuestRunState.ENDED
    }
    return when (sessionState) {
        "QUEUED" -> GuestRunState.QUEUED
        "RUNNING" -> GuestRunState.RUNNING
        "AWAITING_INPUT" -> GuestRunState.AWAITING_INPUT
        "COMPLETED" -> GuestRunState.SUCCEEDED
        "FAILED" -> GuestRunState.FAILED
        "INTERRUPTED" -> GuestRunState.INTERRUPTED
        else -> GuestRunState.ENDED
    }
}

/** Filed Completed by its owner (`ARCHIVED` is the old spelling). */
val GuestState.completed: Boolean get() = lifecycleState?.uppercase().let { it == "COMPLETED" || it == "ARCHIVED" }

/** The agent is still in a run — and the conversation is not filed away — so a message joins it rather than restarting it. */
val GuestState.live: Boolean get() = (released?.not() ?: resolvedRunState.isLive) && !completed

/** Waiting on its owner — a permission card or a question pending — which only the owner answers. */
val GuestState.waiting: Boolean get() = live && waitingOnOwner

/** Queued or running: the conversation is moving now. */
/** What the release establishes, once the payload carries enough to say: a guest head historically omitted the end reason, so until
 * it carries `workFinished` or one, the terminal wording stays on the old path (OrbitKit `GuestSessionState.releasedRunState`). */
private val GuestState.releasedRunState: GuestRunState? get() {
    if (released != true || (workFinished == null && endReason == null)) return null
    return when (SessionFacts.afterRelease(endReason, lastTurnOutcome, workFinished)) {
        "FINISHED" -> GuestRunState.SUCCEEDED
        "FAILED" -> GuestRunState.FAILED
        else -> GuestRunState.ENDED
    }
}

private val GuestState.displayRunState: GuestRunState get() {
    releasedRunState?.let { return it }
    if (SessionFacts.endingAfterInterrupt(released, endReason, lastTurnOutcome)) return GuestRunState.INTERRUPTED
    return resolvedRunState
}

val GuestState.busy: Boolean get() = resolvedRunState.let { it == GuestRunState.QUEUED || it == GuestRunState.RUNNING }

/** What [SessionDisplay]'s two functions read of a guest head or Shared with me row. */
val GuestState.displayFacts: SessionDisplay.Facts get() = SessionDisplay.Facts(phase, released, lastTurnOutcome, waitingOn, endReason,
    workFinished, activity, pendingApprovals, runningBgCount)

/** The marks drawn after the state word ([SessionDisplay.marks]); null from an older server. */
val GuestState.marks: List<SessionMark>? get() = SessionDisplay.marks(displayFacts)

/** The status word (web `sessionStateWord`). With the facts it is the state ([SessionDisplay.state]) alone, and a filed session says
 * Completed after it and its marks. From an older server: `Completed` once filed, else the run's own word. */
val GuestState.word: String get() = SessionDisplay.state(displayFacts)?.word ?: if (completed) GuestCopy.COMPLETED else when (displayRunState) {
    GuestRunState.QUEUED -> if (waitingOn == "HOLD") "On hold" else "Queued"
    GuestRunState.RUNNING -> "Running"
    GuestRunState.AWAITING_INPUT -> "Awaiting reply"
    GuestRunState.SUCCEEDED -> if (releasedRunState == GuestRunState.SUCCEEDED) "Finished" else "Succeeded"
    GuestRunState.FAILED -> "Failed"
    GuestRunState.INTERRUPTED -> "Interrupted"
    GuestRunState.ENDED -> "Ended"
}

val GuestState.tone: GuestTone get() = when (SessionDisplay.state(displayFacts)) {
    SessionDisplayState.QUEUED -> GuestTone.QUEUED
    SessionDisplayState.RUNNING -> GuestTone.RUNNING
    SessionDisplayState.IDLE -> GuestTone.IDLE
    null -> legacyTone
}

private val GuestState.legacyTone: GuestTone get() = if (completed) GuestTone.DONE else when (displayRunState) {
    GuestRunState.QUEUED -> GuestTone.QUEUED
    GuestRunState.RUNNING -> GuestTone.RUNNING
    GuestRunState.AWAITING_INPUT -> GuestTone.AWAITING
    GuestRunState.SUCCEEDED -> GuestTone.DONE
    GuestRunState.FAILED -> GuestTone.FAILED
    GuestRunState.INTERRUPTED, GuestRunState.ENDED -> GuestTone.CANCELLED
}

/** The line under the composer: where a message runs, that it waits its turn behind the owner's approval, or that sending restarts
 * an ended session. */
fun GuestState.hint(owner: String): String = when {
    !live -> GuestCopy.restarts(owner)
    waiting -> GuestCopy.WAITS_ITS_TURN
    else -> GuestCopy.runsOn(owner)
}

/** What a guest may attach to a message: the owner's composer's inline images and limit, which the guest door enforces too
 * (`POST /guest-sessions/:id/attachments`), refused here in the door's own words before anything is sent. */
object GuestImages {
    const val MAX_BYTES = 5 * 1024 * 1024
    val TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    const val WRONG_TYPE = "A guest can attach PNG, JPEG, WebP or GIF images only."
    const val TOO_LARGE = "Image exceeds the 5MB limit"
    const val EMPTY = "File is empty"
    const val FAILED_UPLOADS = "Remove the images that failed to upload before sending."

    fun rejection(mime: String, size: Int): String? = when {
        mime !in TYPES -> WRONG_TYPE
        size == 0 -> EMPTY
        size > MAX_BYTES -> TOO_LARGE
        else -> null
    }
}

/** How the guest view follows the conversation — the public page's cadence (web `followDelay`): every 4 s while it works or has just
 * moved, every 30 s while it waits, and not at all once over. */
object GuestFollow {
    const val WORKING_MS = 4_000L
    const val WAITING_MS = 30_000L
    /** How many events the first read and each follow read ask for. */
    const val TAIL_PAGE = 200
    const val PAGE_SIZE = 200

    /** The wait before the next read, after an answer that did ([moved]) or did not bring anything new; null once the conversation
     * has stopped and gone quiet. [expecting]: a message was just sent and the run it starts has not been seen yet. */
    fun delay(state: GuestState, moved: Boolean, expecting: Boolean = false): Long? = when {
        moved || (state.released != true && (state.phase?.let { it == "PENDING" || it == "RUNNING" } ?: state.busy)) -> WORKING_MS
        state.live -> WAITING_MS
        expecting -> WORKING_MS
        else -> null
    }
}

/** The guest's own words read as theirs: a `user` event the door attributes to this account (`ORBIT_GUEST` under its name) is
 * attributed to the reader instead (`ORBIT_READER`), so it is headed `You` where the transcript would say `From <name>` — the web's
 * `sentByReader`, OrbitKit's `GuestTranscript.ownMessages`. Anyone else's keep theirs. */
object GuestTranscript {
    const val GUEST_SOURCE = "ORBIT_GUEST"
    const val READER_SOURCE = "ORBIT_READER"

    fun ownMessages(events: List<RunEvent>, myName: String?): List<RunEvent> {
        val me = myName?.trim()?.takeIf { it.isNotEmpty() } ?: return events
        return events.map { event ->
            val payload = event.payload as? JsonObject ?: return@map event
            val from = payload["externalSender"] as? JsonObject ?: return@map event
            fun field(key: String) = (from[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            if (event.type != "user" || field("source") != GUEST_SOURCE || field("name")?.trim() != me) event
            else event.copy(payload = JsonObject(payload + ("externalSender" to JsonObject(mapOf("source" to JsonPrimitive(READER_SOURCE))))))
        }
    }
}

/** Shared with me: the rows, and whether the group is drawn at all. */
object SharedWithMe {
    /** How often the list is read again: a session can be shared with you, or stop being, at any time. */
    const val REFRESH_MS = 60_000L

    /** No group while there is none. */
    fun showsGroup(sessions: List<GuestSessionSummary>) = sessions.isNotEmpty()

    /** The row's second line: who shared it and how it stands, `Ana · Idle · Finished` — the state, its marks and, once filed,
     * Completed (web `sharedWithMeStateText`); from an older server, `Ana · Running`. */
    fun subtitle(session: GuestSessionSummary): String {
        val state = session.state
        val shown = SessionDisplay.text(state.displayFacts) ?: return "${session.ownerName} · ${state.word}"
        return "${session.ownerName} · $shown" + if (state.completed) " · ${GuestCopy.COMPLETED}" else ""
    }

    /** The row's title: the first non-blank line of the session's title (web `titleFirstLine`). */
    fun title(session: GuestSessionSummary) = firstLine(session.title)

    fun firstLine(title: String): String =
        title.split("\n").map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: title.trim()

    /** How long ago it last moved, in the list's shortest words: `now`, `2m`, `1h`, `2d`. */
    fun ago(session: GuestSessionSummary, now: Instant = Instant.now()): String {
        val at = runCatching { Instant.parse(session.lastTurnAt ?: session.addedAt) }.getOrNull() ?: return ""
        val minutes = Duration.between(at, now).toMinutes()
        return when {
            minutes < 1 -> "now"
            minutes < 60 -> "${minutes}m"
            minutes < 24 * 60 -> "${minutes / 60}h"
            else -> "${minutes / (24 * 60)}d"
        }
    }
}
