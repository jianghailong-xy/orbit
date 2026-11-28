package io.orbitd.android.directory

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.cards.OwnerItem
import io.orbitd.android.core.cards.ClaudeRegion
import io.orbitd.android.core.protocol.SessionFacts
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.tasks.OwnerConfirmationCopy
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.watch.WatchSessionSummary
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The line under a session's title (OrbitKit `SessionLine`, a port of web's `sessionLine`): for a live session that is
 * generating, what it is doing — the tool in flight, that it waits on you, the message you sent, or a bare "Running…" —
 * and otherwise the server's recap of the session, falling back to the last reply flattened and then to the run's own state
 * word, so the line is never empty. [tone] drives the colour. A project row says one of these (A05-6), in these words.
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
        /** Amber words for a fact that asks nothing: a landing the server judged timed out, a runner updating. */
        WARNING,
    }

    companion object {
        /** The line for [s]. [live] is false in Trash. [watching] is the session as an observer, parked with a live watch
         * that will resume it. [recaps] is the account's Session recaps switch (Settings): on unless turned off, and off means
         * the line falls through to the raw reply exactly as it did before the recap existed — it gates that one line and
         * nothing else. [machine] is the runner it runs on, by name: a session held for the Claude region says Anthropic is
         * unavailable there, where it is known. */
        internal fun make(s: DirectorySession, live: Boolean, watching: WatchSessionSummary? = null,
                          recaps: Boolean = true, now: Instant = Instant.now(), machine: String? = null,
                          cloneProgress: Int? = null): SessionLine {
            // Somebody waiting on YOU outranks everything else the row could say, outside the generating gate: an owner
            // decision is held open by no turn, so it sits on a parked conversation.
            if (live && s.pendingApprovals > 0) return SessionLine(SessionHeader.waitingWord(s), Tone.APPROVAL)
            // A run whose report is still with its reviewer: who has it, in the quiet tone.
            if (live && s.confirmationUnderReview != null) return SessionLine(SessionLineCopy.underReviewLine(s.reviewerTitle), Tone.REVIEW)
            if (live && s.isGenerating) {
                // A sub-agent launch still in flight (a synchronous Agent, a foreground delegate) names the sub-agent's work.
                if (s.lastToolUse?.let { fmtTool(it) in SUBAGENT_LAUNCH_TOOLS } == true && (s.runningSubagentCount ?: 0) > 0)
                    return SessionLine(SessionLineCopy.subagentRunningLine(s.runningSubagentCount ?: 0, s.runningSubagentTitle), Tone.RUNNING)
                s.lastToolUse?.takeIf { it.isNotEmpty() }?.let { return SessionLine(SessionLineCopy.runningTool(fmtTool(it)), Tone.RUNNING) }
                // A sub-agent or workflow in flight: its launch cleared the tool line at once.
                s.runningSubagentCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.subagentRunningLine(it, s.runningSubagentTitle), Tone.RUNNING) }
                // The agent hasn't answered yet: the message it was sent, not the previous turn's reply.
                s.lastUserText?.takeIf { it.isNotEmpty() }?.let { return orbitLine(it, OrbitMessageFrom.of(s.lastUserFromOrbit)) ?: externalLine(it, ExternalSender.parse(s.lastUserFromExternal)) ?: sentLine(it, s.lastUserFrom) }
                s.lastAssistantText?.takeIf { it.isNotEmpty() }?.let { return SessionLine(plainPreview(it), Tone.PREVIEW) }
                return SessionLine(SessionLineCopy.running, Tone.RUNNING)
            }
            if (live && s.effectiveRunState == RunState.QUEUED) {
                val held = ClaudeRegion.heldWords(s.regionHeld, machine)
                // A runner draining for its update is the one queue word in the warning colour (board 2 ①): it can last hours, and
                // only the owner can shorten it.
                if (held == null && RunnerUpdating.isRunnerUpdating(s.queuedGate)) return SessionLine(RunnerUpdating.runnerUpdatingTitle(s.queuedGate), Tone.WARNING)
                // A full runner, run or batch reads in plain words, in the queue's own colour (board session-row-runner-full, web `sessionLine`).
                if (held == null && QueuedCapacity.isCapacityHeld(s.queuedGate)) return SessionLine(QueuedCapacity.CAPACITY_HELD_LINE, Tone.QUEUED)
                // Keep Free holds a new session on a runner short of disk (web `queuedLabel`).
                if (held == null && QueuedDiskLow.isDiskHeld(s.queuedGate)) return SessionLine(QueuedDiskLow.TITLE, Tone.QUEUED)
                // Held by its clone: git's percentage once this app has heard one (board clone-progress-wait-card ④).
                if (held == null && QueuedClone.isCloning(s.queuedGate)) return SessionLine(cloneProgress?.let(QueuedClone::rowLabel) ?: QueuedClone.TITLE, Tone.QUEUED)
                if (held == null && QueuedClone.isFailed(s.queuedGate)) return SessionLine(QueuedClone.FAILED_TITLE, Tone.QUEUED)
                return SessionLine(held ?: s.queueWord, Tone.QUEUED)
            }
            // Parked while a sub-agent or workflow it started works on: the workspace itself is still working.
            if (live) s.runningSubagentCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.subagentRunningLine(it, s.runningSubagentTitle), Tone.RUNNING) }
            // Parked on a live watch that will resume it, in the Watching strip's own line. Not for a session the server calls
            // IDLE: a wake to come needs no words of its own (the owner, 2026-11-27; web `resumeWords`).
            val idle = SessionDisplay.state(s.displayFacts) == SessionDisplayState.IDLE
            if (live && !idle && watching != null && s.effectiveRunState == RunState.AWAITING_INPUT) return SessionLine(watching.rowLine, Tone.WATCHING)
            // The same place for a wait the server reports and this caller holds no watch for (OrbitKit `resumesOnItsOwn`).
            if (live && !idle && s.resumesOnItsOwn) return SessionLine(SessionLineCopy.waitingToResume, Tone.WATCHING)
            // A message that never got an answer is newer than the reply before it, and what the session waits on.
            s.lastUserText?.takeIf { it.isNotEmpty() }?.let { return orbitLine(it, OrbitMessageFrom.of(s.lastUserFromOrbit)) ?: externalLine(it, ExternalSender.parse(s.lastUserFromExternal)) ?: sentLine(it, s.lastUserFrom) }
            // The rolling recap (0418) takes the place of the reply preview it used to show, below every live line above and
            // above the raw reply. Off with the account's Session recaps switch, the line falls through to the reply exactly
            // as it did before the recap existed. Unlabelled (the owner, 2026-10-22): the whole line is the sentence, and when
            // it was written is the Recap card's to say, at the conversation's end ([RecapCard]).
            if (recaps) s.recapText?.trim()?.takeIf { it.isNotEmpty() }?.let { return SessionLine(it, Tone.PREVIEW) }
            s.lastAssistantText?.takeIf { it.isNotEmpty() }?.let { return SessionLine(plainPreview(it), Tone.PREVIEW) }
            // Parked, with a background process still up. It never takes the line from the unanswered message, the recap or the
            // reply (the owner, 2026-11-16; OrbitKit parity): the glyph already says a process is up.
            if (live) s.runningBgCount?.takeIf { it > 0 }?.let { return SessionLine(SessionLineCopy.ongoing(SessionLineCopy.bgRunning(it)), Tone.BACKGROUND) }
            // Nothing to preview: the run's own state word, so the row still says what happened.
            return SessionLine(SessionHeader.statusWord(s, now = now), Tone.PREVIEW)
        }

        private fun sentLine(text: String, from: SessionMessageFrom?) = SessionLine(SessionLineCopy.sent(sender(from), plainPreview(text)), Tone.PREVIEW)

        /** The line for a message somebody other than the owner sent — a connected Feishu group's member (OrbitKit
         * `SessionLine.externalLine`, web `sentBy`; docs/feishu-bot-design.md §8.2) or a guest the owner invited
         * (docs/session-guests-design.md §3) — or null for anybody else's: named as the conversation names them over their words,
         * `From Feishu · <name>` or `From <name>`, never "You". */
        internal fun externalLine(text: String, from: ExternalMessageFrom?): SessionLine? =
            from?.let { SessionLine(SessionLineCopy.sent(ExternalSender.label(it), plainPreview(text)), Tone.PREVIEW) }

        /** Who sent a message the agent hasn't answered (OrbitKit `SessionLine.sender`, web `sentBy`): [SessionLineCopy.you] only for the
         * owner's own words — and for every message from an older server, which names no sender. A message another Orbit session sent
         * names that session as the conversation's card names it: its title, or what an untitled one is called (design §3.5, owner
         * 2026-11-07). A coordinator's unanswered message is usually a task's report, which "You:" put in the owner's mouth. */
        internal fun sender(from: SessionMessageFrom?): String =
            if (from == null) SessionLineCopy.you else from.title?.trim()?.takeIf { it.isNotEmpty() } ?: TaskDetailCopy.untitledSession

        /** The line for a message Orbit wrote itself (OrbitKit `SessionLine.orbitLine`, web `orbitLine`; design §3.5, owner 2026-11-07),
         * or null for anybody else's: Orbit says it, never "You", which put "You: From Orbit · project …" on a coordinator's row while it
         * read the notification. A notification the conversation draws as a line says that line's own sentence
         * ([CoordinatorDeliveryLine.sentence]); any other says its first line, flattened like a preview — the rest is written for the
         * agent. */
        internal fun orbitLine(text: String, mark: OrbitMessageFrom?): SessionLine? {
            mark ?: return null
            val said = mark.coordinatorDelivery?.let { CoordinatorDeliveryLine.sentence(it) }
                ?: plainPreview(text.split('\n').firstOrNull { it.isNotBlank() }.orEmpty())
            return SessionLine(SessionLineCopy.sent(SessionLineCopy.orbit, said), Tone.PREVIEW)
        }
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
    /** A message the agent hasn't answered yet, marked with who sent it ([SessionLine.sender]), since the line is otherwise the agent's voice. */
    fun sent(sender: String, text: String) = "$sender: $text"
    /** The owner, as the sender of their own message (web `SENT_BY_YOU`). */
    const val you = "You"
    /** Orbit, as the sender of its own messages (web `SENT_BY_ORBIT`). */
    const val orbit = "Orbit"
    /** Work still under way, as the line says it: the label and an ellipsis ("Running Agent…"). */
    fun ongoing(label: String) = "$label…"
    /** The runtime's own sub-agents and workflows (web `subagentRunningLabel`). */
    fun subagentRunning(n: Int) = if (n > 1) "Running $n agents" else "Running Agent"
    /** The row's words for the same, naming what the newest one is doing when the server knows (`runningSubagentTitle`):
     *  "Agent: Deploy …" for one, "Running 2 agents · Deploy …" for several, the bare label without a title (web `subagentRunningLine`). */
    fun subagentRunningLine(n: Int, title: String?): String {
        val t = title?.trim().orEmpty()
        if (t.isEmpty()) return ongoing(subagentRunning(n))
        return if (n > 1) ongoing("${subagentRunning(n)} · $t") else ongoing("Agent: $t")
    }
    fun bgRunning(n: Int) = if (n > 1) "$n background processes running" else "Background process running"
    /** Who has a report under review: the review bar's word and its reviewer (`OwnerConfirmations.underReviewLine`). */
    fun underReviewLine(reviewerTitle: String?) = "${OwnerReview.underReview} · ${OwnerReview.reviewerName(reviewerTitle)}"

    // The run's own word (`SessionHeader.statusWord`), when there is nothing to preview.
    const val stateRunning = "Running"
    const val waitingForReply = "Waiting for your reply"
    /** A wait the server reports that will resume the session by itself (OrbitKit `Session.waitingToResume`). */
    const val waitingToResume = "Waiting to resume"
    const val succeeded = "Succeeded"
    const val finished = "Finished"
    const val onHold = "On hold"
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
     * will resume it, it reads the watch's word. Where the server sends the session facts, the word is the state's, from `phase` alone
     * ([SessionDisplay.state]); the marks beside it are the caller's to draw. What follows is the reading for an older control plane. */
    fun statusWord(s: DirectorySession, watching: WatchSessionSummary? = null, now: Instant = Instant.now()): String {
        SessionDisplay.state(s.displayFacts)?.let { return it.word }
        if (s.pendingApprovals > 0) return waitingWord(s)
        if (s.confirmationUnderReview != null) return OwnerReview.underReview
        return when (s.displayRunState) {
            RunState.QUEUED -> if (RunnerUpdating.isRunnerUpdating(s.queuedGate)) RunnerUpdating.runnerUpdatingTitle(s.queuedGate)
                else if (QueuedCapacity.isCapacityHeld(s.queuedGate)) QueuedCapacity.title(s.queuedGate)
                else if (QueuedDiskLow.isDiskHeld(s.queuedGate)) QueuedDiskLow.TITLE
                else if (QueuedClone.isCloning(s.queuedGate)) QueuedClone.TITLE
                else if (QueuedClone.isFailed(s.queuedGate)) QueuedClone.FAILED_TITLE else s.queueWord
            RunState.RUNNING -> SessionLineCopy.stateRunning
            RunState.AWAITING_INPUT -> when {
                // A turn the runtime started for itself keeps the run parked for its whole duration.
                s.isGenerating -> SessionLineCopy.stateRunning
                (s.runningSubagentCount ?: 0) > 0 -> SessionLineCopy.subagentRunning(s.runningSubagentCount ?: 0)
                watching != null -> watching.word
                // Something else will resume it — a wake-up, a retry, a watch this caller holds none of.
                s.resumesOnItsOwn -> SessionLineCopy.waitingToResume
                (s.runningBgCount ?: 0) > 0 -> SessionLineCopy.bgRunning(s.runningBgCount ?: 0)
                else -> SessionLineCopy.waitingForReply
            }
            RunState.SUCCEEDED -> if (s.releasedRunState == RunState.SUCCEEDED) SessionLineCopy.finished else SessionLineCopy.succeeded
            // Not "Failed" while the server is still going to send it again.
            RunState.FAILED -> if (s.retryPending(now)) SessionLineCopy.retrying
                else if (s.error.orEmpty().lowercase().contains("offline")) SessionLineCopy.disconnected else SessionLineCopy.failed
            RunState.INTERRUPTED -> SessionLineCopy.interrupted
            RunState.ENDED, RunState.UNKNOWN -> SessionLineCopy.ended
        }
    }

    /** What a session waiting on you says, in the words of whatever is waiting: the kind the server named, when this build has
     * words for it, else the row's long-standing approval word. */
    fun waitingWord(s: DirectorySession): String =
        waitingWord(s.waitingKind, NeedsYouLogic.ownerItems(s.ownerItems.orEmpty().filterIsInstance<JsonObject>()), s.ownerRequests, s.taskMoves)

    /** The same words from the wire's own fields, for a reader holding the raw row (the needs-you notice). */
    fun waitingWord(waitingKind: String?, ownerItems: List<OwnerItem>, ownerRequests: JsonArray? = null,
        taskMoves: JsonArray? = null): String = when (waitingKind) {
        "OWNER_CONFIRMATION" -> OwnerConfirmationCopy.waitingForConfirmation
        "OWNER_ITEM" -> NeedsYouLogic.oldestItemWord(ownerItems) ?: SessionLineCopy.unnamedWord
        "START_REQUEST" -> StartProjectCopy.readyToStart
        "DONE_REQUEST" -> ProjectDone.readyToClose
        "RECORD_AS_DONE" -> ProjectDone.recordAsDoneRow
        "OWNER_REQUEST", "MOVE_REQUEST" -> OwnerRequestRowWords.word(waitingKind, ownerRequests, taskMoves) ?: SessionLineCopy.unnamedWord
        else -> SessionLineCopy.unnamedWord
    }
}

/** What a row waiting on a session's own question says (`@orbit/shared` `ownerRequestRowWord`, held to it word for word by
 * SessionLineTest): an open owner request by its kind, and task moves by how many wait. A row the server calls `OWNER_REQUEST` holds
 * requests of one kind only; two kinds are a mix, which the server sends under another kind and the row keeps "Waiting for approval". */
internal object OwnerRequestRowWords {
    val requestWords = mapOf("DECISION" to "Decision for you", "SECRET" to "Key needed", "MANUAL_STEP" to "Steps for you",
        "CONFIRM" to "Confirm for you", "WIKI_CREATE" to "Create wiki")
    fun taskMoves(moves: Int) = if (moves == 1) "Approve task move" else "Approve $moves task moves"

    /** The word, or null when the kind is neither or the list it needs is missing or empty (an older control plane). */
    fun word(kind: String?, ownerRequests: JsonArray?, taskMoves: JsonArray?): String? = when (kind) {
        "OWNER_REQUEST" -> ((ownerRequests?.firstOrNull() as? JsonObject)?.get("kind") as? JsonPrimitive)?.contentOrNull?.let(requestWords::get)
        "MOVE_REQUEST" -> taskMoves.orEmpty().sumOf { ((it as? JsonObject)?.get("count") as? JsonPrimitive)?.intOrNull ?: 0 }
            .takeIf { it > 0 }?.let(::taskMoves)
        else -> null
    }
}

/** OrbitKit `SessionRunState`: what the run is doing or how it ended, apart from where the session is filed. */
internal enum class RunState { QUEUED, RUNNING, AWAITING_INPUT, INTERRUPTED, SUCCEEDED, FAILED, ENDED, UNKNOWN }

private val KNOWN_RUN_STATUSES = setOf("PENDING", "RUNNING", "AWAITING_INPUT", "SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELLED")

/** `SessionRunState.resolve`: the server's `runState` first, then its raw run status and end reason. */
internal val DirectorySession.effectiveRunState: RunState get() {
    // A held session whose status word this build does not know reads the phase, as web does (a release is worded by [displayRunState]).
    // A known status keeps its reading: a parked turn with a background job says so, which the phase alone cannot.
    if (released == false && (runStatus ?: status) !in KNOWN_RUN_STATUSES && RunState.entries.none { it != RunState.UNKNOWN && it.name == runState }) when (phase) {
        "PENDING" -> return RunState.QUEUED
        // `activity` is TURN on every queued or running row; only another one (a background job, a wait) is a parked session.
        "RUNNING" -> return if (activity.isNullOrEmpty() || activity == "TURN") RunState.RUNNING else RunState.AWAITING_INPUT
        "IDLE" -> return if (lastTurnOutcome == "INTERRUPTED") RunState.INTERRUPTED else RunState.AWAITING_INPUT
    }
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

/** What the session's release establishes, for the words and marks drawn from it (OrbitKit `Session.releasedRunState`): null until
 * released, and null when the payload carries no `released` (an older server). */
internal val DirectorySession.releasedRunState: RunState? get() {
    if (released != true) return null
    // A move let it go: to its reader it is the idle session it was (SessionFacts.releasedByMove).
    if (SessionFacts.releasedByMove(released, endReason)) return RunState.AWAITING_INPUT
    return when (SessionFacts.afterRelease(endReason, lastTurnOutcome, workFinished, isLanding)) {
        "FINISHED" -> RunState.SUCCEEDED
        "FAILED" -> RunState.FAILED
        else -> RunState.ENDED
    }
}

/** The run state a row draws its word and mark from (OrbitKit `Session.displayRunState`): what the release established, an
 * interrupted session that is being ended staying Interrupted until the release lands, else [effectiveRunState]. */
internal val DirectorySession.displayRunState: RunState get() {
    releasedRunState?.let { return it }
    if (SessionFacts.endingAfterInterrupt(released, endReason, lastTurnOutcome)) return RunState.INTERRUPTED
    return effectiveRunState
}

/** The queued word: "On hold" while the server says the turn is held (OrbitKit `Session.queueWord`). */
internal val DirectorySession.queueWord: String get() = if (waitingOn == "HOLD") SessionLineCopy.onHold else SessionLineCopy.queued

/** Held for its runner's Claude region (docs/claude-region-check-contract.md §10, §11; web `claudeRegionHeld`): queued, with a region
 * refusal as its error. Its message waits, and nothing is working on it. */
internal val DirectorySession.regionHeld: Boolean get() = effectiveRunState == RunState.QUEUED && ClaudeRegion.isRegionError(error)

/** Whether to draw it as working: dispatched, or a turn the runtime started for itself while parked (`isGenerating`). */
internal val DirectorySession.isGenerating: Boolean get() = effectiveRunState.let { it == RunState.RUNNING || (it == RunState.AWAITING_INPUT && engineTurnActive == true) }

/** Parked, and something will resume it by itself — a watch it observes, a scheduled wake-up, an armed auto-retry (the server's
 * `activity` WAITING; OrbitKit `Session.resumesOnItsOwn`). Not waiting for your reply. */
internal val DirectorySession.resumesOnItsOwn: Boolean get() = effectiveRunState == RunState.AWAITING_INPUT && activity == "WAITING"

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

/** Whether its row draws the working spinner (`WorkspaceActivityLogic.isRunning`): with the session facts, `phase` RUNNING alone, as
 * [SessionLiveMark] draws it — a background job or SubAgent between turns too, quiet job or not; else read off `SessionStatusGlyph`,
 * where a watch it is parked on never takes the spinner's place. A folder, a project and the drawer's workspace read this, so none of
 * them sits idle over a row that spins. */
internal fun DirectorySession.isRunning(): Boolean {
    SessionDisplay.state(displayFacts)?.let { return it == SessionDisplayState.RUNNING }
    if (pendingApprovals > 0 || confirmationUnderReview != null) return false
    return when (effectiveRunState) {
        RunState.RUNNING -> true
        RunState.AWAITING_INPUT -> engineTurnActive == true || (runningSubagentCount ?: 0) > 0
        else -> false
    }
}

/** Whether its glyph is the terminal (`SessionStatusGlyph`'s `terminal`): parked with a background process up, and nothing
 * louder — no spinner, and no watch, whose eye takes the place. */
internal fun DirectorySession.hasBackgroundProcess(watching: WatchSessionSummary? = null): Boolean {
    if (pendingApprovals > 0 || confirmationUnderReview != null || effectiveRunState != RunState.AWAITING_INPUT) return false
    if (engineTurnActive == true || (runningSubagentCount ?: 0) > 0 || watching != null || resumesOnItsOwn) return false
    return (runningBgCount ?: 0) > 0
}

/** Whether that terminal breathes (`WorkspaceActivityLogic.isRunningJob`): at least one of those processes is a job in flight. */
internal fun DirectorySession.isRunningJob(watching: WatchSessionSummary? = null): Boolean =
    // With the session facts no row breathes: a job in flight is `phase` RUNNING, the spinner of [isRunning].
    SessionDisplay.state(displayFacts) == null && hasBackgroundProcess(watching) && runningBgJobCount > 0

private val DirectorySession.reviewerTitle get() = (confirmationUnderReview?.get("reviewerTitle") as? JsonPrimitive)?.contentOrNull

/** OrbitKit `SessionLine.plainPreview`: a reply flattened into one line of prose — code blocks dropped, a link down to its text
 * and an image to its alt, only what Markdown would draw as a mark gone, whitespace collapsed. The `_` and `*` of
 * `tea_user_*_cnch`, the `~` of `~/.orbit`, the `--` of `--force` and the `#` of `#123` are words someone wrote. ICU's `\s`, which
 * the Swift matches with, is spelled out so the JVM and the device read whitespace alike. */
internal fun plainPreview(md: String): String {
    val space = "\\t\\n\\f\\r\\p{Z}"
    var s = md
    s = s.replace(Regex("```[\\s\\S]*?```"), " ")
    // Inline code is held out of every rule and put back at the end, which leaves the brackets and marks inside it alone. A span
    // closes on a run of backticks as long as the one that opened it.
    val code = mutableListOf<String>()
    s = s.replace(Regex("(?<!`)(`+)(?!`)([\\s\\S]*?[^`])\\1(?!`)")) { code += it.groupValues[2]; "\uE000${code.size - 1}\uE000" }
    s = s.replace(Regex("!\\[([^\\[\\]]*)\\]\\([^)]*\\)")) { it.groupValues[1] }
    s = s.replace(Regex("\\[([^\\[\\]]*)\\]\\([^)]*\\)")) { it.groupValues[1] }
    s = s.replace(Regex("(?m)^[ \\t]*([-*_])[ \\t]*(?:\\1[ \\t]*){2,}$"), "")
    s = s.replace(Regex("(?m)^(?:[ \\t]*(?:>|(?:#{1,6}|[-*])(?=[ \\t]|$)))+"), "")
    // Underscores before stars: whether a `_` is a mark depends on what stands beside it as written.
    s = s.replace(Regex("(?<![\\p{L}\\p{N}_])(_{1,3})(?=[^${space}_])(.*?[^${space}_])\\1(?![\\p{L}\\p{N}_])")) { it.groupValues[2] }
    s = s.replace(Regex("(\\*{2,3})(?=[^$space*])(.*?[^$space*])\\1")) { it.groupValues[2] }
    s = s.replace(Regex("\\*(?=[^$space*])(.*?[^$space*])\\*")) { it.groupValues[1] }
    s = s.replace(Regex("~~(?=[^$space~])(.*?[^$space~])~~")) { it.groupValues[1] }
    code.forEachIndexed { index, span -> s = s.replace("\uE000$index\uE000", span) }
    s = s.replace(Regex("[$space]+"), " ")
    return s.trim()
}

/** A tool id shortened for the line: mcp__orbit__task_create reads task_create; Bash stays Bash. */
internal fun fmtTool(name: String) = name.replace(Regex("^mcp__[^_]+__"), "")

/** The calls that launch a sub-agent (the server's RUNTIME_SUBAGENT_TOOLS, shortened by [fmtTool]). */
internal val SUBAGENT_LAUNCH_TOOLS = setOf("Task", "Agent", "Workflow", "delegate")
