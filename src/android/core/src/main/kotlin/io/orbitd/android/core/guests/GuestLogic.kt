package io.orbitd.android.core.guests

import io.orbitd.android.core.realtime.RunEvent
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

/** The tone of the status pill, as the public page colours it (web `RUN_TONE`, plus `done` for a session filed Completed). */
enum class GuestTone { QUEUED, RUNNING, AWAITING, DONE, FAILED, CANCELLED }

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
val GuestState.live: Boolean get() = resolvedRunState.isLive && !completed

/** Waiting on its owner — a permission card or a question pending — which only the owner answers. */
val GuestState.waiting: Boolean get() = live && waitingOnOwner

/** Queued or running: the conversation is moving now. */
val GuestState.busy: Boolean get() = resolvedRunState.let { it == GuestRunState.QUEUED || it == GuestRunState.RUNNING }

/** The status word (web `sessionStateWord`): `Completed` once filed, else the run's own word. */
val GuestState.word: String get() = if (completed) "Completed" else when (resolvedRunState) {
    GuestRunState.QUEUED -> "Queued"
    GuestRunState.RUNNING -> "Running"
    GuestRunState.AWAITING_INPUT -> "Awaiting reply"
    GuestRunState.SUCCEEDED -> "Succeeded"
    GuestRunState.FAILED -> "Failed"
    GuestRunState.INTERRUPTED -> "Interrupted"
    GuestRunState.ENDED -> "Ended"
}

val GuestState.tone: GuestTone get() = if (completed) GuestTone.DONE else when (resolvedRunState) {
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
        moved || state.busy -> WORKING_MS
        state.resolvedRunState.isLive && !state.completed -> WAITING_MS
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

    /** The row's second line: who shared it and how it stands, `Ana · Running`. */
    fun subtitle(session: GuestSessionSummary) = "${session.ownerName} · ${session.state.word}"

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
