package io.orbitd.android.directory

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.tasks.OwnerConfirmationCopy
import io.orbitd.android.watch.WatchSessionSummary
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The line under a session's title (OrbitKit `SessionLine`, a port of web's `sessionLine`): for a live session that is
 * generating, what it is doing — the tool in flight, that it waits on you, the message you sent, or a bare "Running…" —
 * and otherwise the last reply flattened, falling back to the run's own state word, so the line is never empty. [tone]
 * drives the colour. A project row says one of these (A05-6), in these words.
 */
data class SessionLine(val text: String, val tone: Tone) {
    enum class Tone {
        /** Reply content: the default, secondary colour. */
        PREVIEW,
        /** Working. */
        RUNNING,
        /** Needs you. */
        APPROVAL,
        /** Waiting for a slot. */
        QUEUED,
        /** A process the agent left up: it outlives the turn, but isn't work. */
        BACKGROUND,
        /** Parked on a watch that will resume it: not a process, not waiting on you. */
        WATCHING,
        /** Its report is with its reviewer: drawn, not counted, never amber. */
        REVIEW,
    }

    companion object {
        /** The line for [s]. [live] is false in Trash. [watching] is the session as an observer, parked with a live watch
         * that will resume it. */
        internal fun make(s: DirectorySession, live: Boolean, watching: WatchSessionSummary? = null, now: Instant = Instant.now()): SessionLine {
            // Somebody waiting on YOU outranks everything else the row could say, outside the generating gate: an owner
            // decision is held open by no turn, so it sits on a parked conversation.
            if (live && s.pendingApprovals > 0) return SessionLine(SessionHeader.waitingWord(s), Tone.APPROVAL)
            // A run whose report is still with its reviewer: who has it, in the quiet tone.
            if (live && s.confirmationUnderReview != null) return SessionLine(SessionLineCopy.underReviewLine(s.reviewerTitle), Tone.REVIEW)
            if (live && s.isGenerating) {
                s.lastToolUse?.takeIf { it.isNotEmpty() }?.let { return SessionLine(SessionLineCopy.runningTool(fmtTool(it)), Tone.RUNNING) }
                // A sub-agent or workflow in flight: its launch cleared the tool line at once.
                s.runningSubagentCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.ongoing(SessionLineCopy.subagentRunning(it)), Tone.RUNNING) }
                // The agent hasn't answered yet: the message you sent, not the previous turn's reply.
                s.lastUserText?.takeIf { it.isNotEmpty() }?.let { return sentLine(it) }
                s.lastAssistantText?.takeIf { it.isNotEmpty() }?.let { return SessionLine(plainPreview(it), Tone.PREVIEW) }
                return SessionLine(SessionLineCopy.running, Tone.RUNNING)
            }
            if (live && s.effectiveRunState == RunState.QUEUED) return SessionLine(SessionLineCopy.queued, Tone.QUEUED)
            // Parked while a sub-agent or workflow it started works on: the workspace itself is still working.
            if (live) s.runningSubagentCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.ongoing(SessionLineCopy.subagentRunning(it)), Tone.RUNNING) }
            // Parked on a live watch that will resume it, in the Watching strip's own line.
            if (live && watching != null && s.effectiveRunState == RunState.AWAITING_INPUT) return SessionLine(watching.rowLine, Tone.WATCHING)
            // Parked, with a background process still up: not idle, not the agent working either.
            if (live) s.runningBgCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.ongoing(SessionLineCopy.bgRunning(it)), Tone.BACKGROUND) }
            // A message that never got an answer is newer than the reply before it, and what the session waits on.
            s.lastUserText?.takeIf { it.isNotEmpty() }?.let { return sentLine(it) }
            s.lastAssistantText?.takeIf { it.isNotEmpty() }?.let { return SessionLine(plainPreview(it), Tone.PREVIEW) }
            // Nothing to preview: the run's own state word, so the row still says what happened.
            return SessionLine(SessionHeader.statusWord(s, now = now), Tone.PREVIEW)
        }

        private fun sentLine(text: String) = SessionLine(SessionLineCopy.sent(plainPreview(text)), Tone.PREVIEW)
    }
}

/** Every word SessionLine.swift and SessionHeader.swift spell for a session's list line, held to those sources word for word by
 * SessionLineCopyParityTest. Words another surface owns stay that surface's: the confirmation card's, the start card's, the done
 * card's, the needs-you bar's and the review bar's. */
internal object SessionLineCopy {
    /** A turn running with nothing more to say. */
    const val running = "Running…"
    const val queued = "Queued"
    fun runningTool(tool: String) = "Running $tool…"
    /** A message of yours the agent hasn't answered yet: marked, since the line is otherwise the agent's voice. */
    fun sent(text: String) = "You: $text"
    /** Work still under way, as the line says it: the label and an ellipsis ("Running Agent…"). */
    fun ongoing(label: String) = "$label…"
    /** The runtime's own sub-agents and workflows (web `subagentRunningLabel`). */
    fun subagentRunning(n: Int) = if (n > 1) "Running $n agents" else "Running Agent"
    fun bgRunning(n: Int) = if (n > 1) "$n background processes running" else "Background process running"
    /** Who has a report under review: the review bar's word and its reviewer (`OwnerConfirmations.underReviewLine`). */
    fun underReviewLine(reviewerTitle: String?) = "${OwnerReview.underReview} · ${OwnerReview.reviewerName(reviewerTitle)}"

    // The run's own word (`SessionHeader.statusWord`), when there is nothing to preview.
    const val stateRunning = "Running"
    const val waitingForReply = "Waiting for your reply"
    const val succeeded = "Succeeded"
    const val retrying = "Retrying"
    const val disconnected = "Disconnected"
    const val failed = "Failed"
    const val interrupted = "Interrupted"
    const val ended = "Ended"
    /** Somebody waits on you, and the server named no kind this build has words for (`SessionHeader.unnamedWord`). */
    const val unnamedWord = "Waiting for approval"
}

/** OrbitKit `SessionHeader`'s two words the line falls back on. */
internal object SessionHeader {
    /** The run's short state word; where the session is filed is not consulted. [watching]: parked with a live watch that
     * will resume it, it reads the watch's word. */
    fun statusWord(s: DirectorySession, watching: WatchSessionSummary? = null, now: Instant = Instant.now()): String {
        if (s.pendingApprovals > 0) return waitingWord(s)
        if (s.confirmationUnderReview != null) return OwnerReview.underReview
        return when (s.effectiveRunState) {
            RunState.QUEUED -> SessionLineCopy.queued
            RunState.RUNNING -> SessionLineCopy.stateRunning
            RunState.AWAITING_INPUT -> when {
                // A turn the runtime started for itself keeps the run parked for its whole duration.
                s.isGenerating -> SessionLineCopy.stateRunning
                (s.runningSubagentCount ?: 0) > 0 -> SessionLineCopy.subagentRunning(s.runningSubagentCount ?: 0)
                watching != null -> watching.word
                (s.runningBgCount ?: 0) > 0 -> SessionLineCopy.bgRunning(s.runningBgCount ?: 0)
                else -> SessionLineCopy.waitingForReply
            }
            RunState.SUCCEEDED -> SessionLineCopy.succeeded
            // Not "Failed" while the server is still going to send it again.
            RunState.FAILED -> if (s.retryPending(now)) SessionLineCopy.retrying
                else if (s.error.orEmpty().lowercase().contains("offline")) SessionLineCopy.disconnected else SessionLineCopy.failed
            RunState.INTERRUPTED -> SessionLineCopy.interrupted
            RunState.ENDED, RunState.UNKNOWN -> SessionLineCopy.ended
        }
    }

    /** What a session waiting on you says, in the words of whatever is waiting: the kind the server named, when this build has
     * words for it, else the row's long-standing approval word. */
    fun waitingWord(s: DirectorySession): String = when (s.waitingKind) {
        "OWNER_CONFIRMATION" -> OwnerConfirmationCopy.waitingForConfirmation
        "OWNER_ITEM" -> NeedsYouLogic.oldestItemWord(NeedsYouLogic.ownerItems(s.ownerItems.orEmpty().filterIsInstance<JsonObject>()))
            ?: SessionLineCopy.unnamedWord
        "START_REQUEST" -> StartProjectCopy.readyToStart
        "DONE_REQUEST" -> ProjectDone.readyToClose
        "RECORD_AS_DONE" -> ProjectDone.recordAsDoneRow
        else -> SessionLineCopy.unnamedWord
    }
}

/** OrbitKit `SessionRunState`: what the run is doing or how it ended, apart from where the session is filed. */
internal enum class RunState { QUEUED, RUNNING, AWAITING_INPUT, INTERRUPTED, SUCCEEDED, FAILED, ENDED, UNKNOWN }

/** `SessionRunState.resolve`: the server's `runState` first, then its raw run status and end reason. */
internal val DirectorySession.effectiveRunState: RunState get() {
    RunState.entries.firstOrNull { it != RunState.UNKNOWN && it.name == runState }?.let { return it }
    return when (runStatus ?: status) {
        "PENDING" -> RunState.QUEUED
        "RUNNING" -> RunState.RUNNING
        "AWAITING_INPUT" -> RunState.AWAITING_INPUT
        "SUCCEEDED" -> RunState.SUCCEEDED
        "FAILED" -> RunState.FAILED
        // A bare INTERRUPTED is a stopped turn; a recorded reason means the session itself was ended.
        "INTERRUPTED" -> if (endReason.isNullOrEmpty()) RunState.INTERRUPTED else RunState.ENDED
        "CANCELLED" -> RunState.ENDED
        else -> RunState.UNKNOWN
    }
}

/** Whether to draw it as working: dispatched, or a turn the runtime started for itself while parked (`isGenerating`). */
internal val DirectorySession.isGenerating: Boolean get() = effectiveRunState.let { it == RunState.RUNNING || (it == RunState.AWAITING_INPUT && engineTurnActive == true) }

/** A failure the server is about to undo by itself: FAILED with a retry armed, and not more than two minutes past due (`retryPending`). */
internal fun DirectorySession.retryPending(now: Instant): Boolean {
    if (effectiveRunState != RunState.FAILED) return false
    val at = ProjectTime.parse(retryAt) ?: return false
    return ProjectTime.between(now, at) > -120.0
}

/** OPEN, COMPLETED or TRASH: the explicit field first (its old spelling ARCHIVED is Completed), then the timestamps an older server sends. */
internal val DirectorySession.effectiveLifecycleState: String get() = when {
    lifecycleState == "ARCHIVED" -> "COMPLETED"
    lifecycleState in setOf("OPEN", "COMPLETED", "TRASH") -> lifecycleState!!
    deletedAt != null -> "TRASH"
    completedAt != null -> "COMPLETED"
    else -> "OPEN"
}

/** Whether its glyph is the working spinner (`WorkspaceActivityLogic.isRunning`, read off `SessionStatusGlyph`); a watch it is
 * parked on never takes the spinner's place. */
internal fun DirectorySession.isRunning(): Boolean {
    if (pendingApprovals > 0 || confirmationUnderReview != null) return false
    return when (effectiveRunState) {
        RunState.RUNNING -> true
        RunState.AWAITING_INPUT -> engineTurnActive == true || (runningSubagentCount ?: 0) > 0
        else -> false
    }
}

/** Whether its glyph breathes (`WorkspaceActivityLogic.isRunningJob`): parked with a background job in flight, and nothing
 * louder — no spinner, and no watch, whose eye takes the place. */
internal fun DirectorySession.isRunningJob(watching: WatchSessionSummary? = null): Boolean {
    if (pendingApprovals > 0 || confirmationUnderReview != null || effectiveRunState != RunState.AWAITING_INPUT) return false
    if (engineTurnActive == true || (runningSubagentCount ?: 0) > 0 || watching != null) return false
    return (runningBgCount ?: 0) > 0 && runningBgJobCount > 0
}

private val DirectorySession.reviewerTitle get() = (confirmationUnderReview?.get("reviewerTitle") as? JsonPrimitive)?.contentOrNull

/** OrbitKit `SessionLine.plainPreview`: a reply flattened into one line of prose — code blocks dropped, a link down to its text
 * and an image to its alt, the common markdown markers gone, whitespace collapsed. ICU's `\s`, which the Swift matches with, is
 * spelled out so the JVM and the device read whitespace alike. */
internal fun plainPreview(md: String): String {
    val space = "\\t\\n\\f\\r\\p{Z}"
    var s = md
    s = s.replace(Regex("```[\\s\\S]*?```"), " ")
    // A code span is matched first and put back as it was, which leaves brackets inside it alone.
    s = s.replace(Regex("(`[^`]+`)|!\\[([^\\[\\]]*)\\]\\([^)]*\\)")) { it.groups[1]?.value ?: it.groups[2]?.value.orEmpty() }
    s = s.replace(Regex("(`[^`]+`)|\\[([^\\[\\]]*)\\]\\([^)]*\\)")) { it.groups[1]?.value ?: it.groups[2]?.value.orEmpty() }
    s = s.replace(Regex("`([^`]+)`")) { it.groupValues[1] }
    s = s.replace(Regex("(?m)^[#>\\-*$space]+"), "")
    s = s.replace(Regex("[*_~]"), "")
    s = s.replace(Regex("[$space]+"), " ")
    return s.trim()
}

/** A tool id shortened for the line: mcp__orbit__task_create reads task_create; Bash stays Bash. */
internal fun fmtTool(name: String) = name.replace(Regex("^mcp__[^_]+__"), "")
