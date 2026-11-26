package io.orbitd.android.reader

import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.taskprojects.SharePanelCopy
import java.time.Instant
import kotlinx.serialization.json.JsonObject

// A landing failure in the hands of the task's own work session (contract revision 42, §12.5 W4–W8, §12.7; board
// docs/mocks/landing-fix-own-session, ruled 2026-11-22): the Landings window's Fixing state and its hand-back, the three new lines of
// its record, the project page's `Being fixed by its session` and the task row's `Landing · fixing`. Every fact is the server's: an open
// item's `workSession` (`ProjectOpenItemRow.workSession`), the task's `integration.state = FIXING` and `workSessionId`, the session list's
// landing `state = FIXING`, and the timeline's `HANDED_TO_SESSION`, `FIXED_BY_SESSION` and `RETURNED_TO_COORDINATOR` lines.
//
// The words are Android's own for now, kept apart from `LandingSessionCopy` (which is held to the Swift source word for word): the Apple
// apps draw the same board in a task of their own. The buttons keep Android's landing window's sentence case (`Open task`), as its
// other doors do (board v4 07), where the iPhone board writes iOS's Title Case.

/** The words. */
object LandingFixWindowCopy {
    /** The head's word while the task's session has it (board ② c ①). */
    const val FIXING = "Fixing"
    const val ITS_OWN_SESSION_IS_ON_IT = "its own session is on it"
    const val THE_TASKS_SESSION = "The task's session"
    const val COORDINATOR = "Coordinator"
    const val OPEN_SESSION = "Open session"
    /** The rounds W8 allows a task's own session for one landing. */
    const val ROUNDS = 2
    fun round(n: Int) = "round $n of $ROUNDS"
    fun isFixingIt(age: String, round: Int) = "is fixing it · $age · ${round(round)}"
    fun hasIt(age: String) = "has it · $age"
    /** The footer's second sentence (board ② c ③): who decides, in the order they get the failure. */
    const val DECISIONS_SESSION_FIRST = "Decisions: the task's own session first, then the coordinator"
    /** The footer's whole sentence while a landing is with its task's own session (board ② c ③). */
    fun footer(orbitRunsTheseLandings: String) = "$orbitRunsTheseLandings $DECISIONS_SESSION_FIRST"

    /** The timeline's three lines (§12.7) as the board draws them. */
    const val HANDED_TO_THE_TASKS_SESSION = "Handed to the task's session"
    fun itWroteThisWork(round: Int) = "It wrote this work · ${round(round)}"
    const val FIXED_IN = "Fixed in"
    const val LANDING_AGAIN = "landing again"
    const val RETURNED_TO_THE_COORDINATOR = "Returned to the coordinator"

    /** Why the item came back (§12.4 `work_session_return_reason`), as the hand-back line says it — the server's own timeline words. */
    fun returnReason(reason: String?): String? = when (reason) {
        "NO_NEW_COMMIT" -> "no new commit"
        "TURN_FAILED" -> "its fix turn failed"
        "SESSION_ENDED" -> "the session ended"
        "ROUNDS_EXHAUSTED" -> "its rounds of fixes are used up"
        "TASK_MOVED_ON" -> "the task moved on"
        else -> null
    }

    /** What the hand-back says before the session's last words (board ② d ①); a sentence of its own when there are none to quote. */
    fun handBackLead(reason: String?, quoted: Boolean = true): String = handBackLeadWords(reason).let { if (quoted) it else it.removeSuffix(":") + "." }
    private fun handBackLeadWords(reason: String?): String = when (reason) {
        "NO_NEW_COMMIT" -> "The task's session ended its turn without a new commit:"
        "TURN_FAILED" -> "The task's session's fix turn failed:"
        "SESSION_ENDED" -> "The task's session was ended before it could land this:"
        "ROUNDS_EXHAUSTED" -> "The task's session used its rounds of fixes, and this one failed again:"
        else -> "The task's session handed this back:"
    }

    /** The project page (board ④ d, e). */
    const val BEING_FIXED_BY_ITS_SESSION = "Being fixed by its session"
    const val IS_ON_IT = "The task's session is on it"
    const val NOTHING_WAS_PUSHED = "nothing was pushed"
    const val PULL_REQUEST_NOT_MERGED = "pull request not merged"
    const val OPEN_SESSION_LINK = "Open session ›"
    const val LANDING_FIXING = "Landing · fixing"
    /** The sheet's line when every open item is being fixed by its session (board ④ d: `2 · none waiting on you`). */
    fun noneWaitingOnYou(open: Int) = "$open · none waiting on you"
}

/** An open item's `workSession` (§12.7): the session it went to, when, and — once handed back — when and why. */
data class LandingWorkSession(val sessionId: String, val offeredAt: String?, val returnedAt: String?, val returnReason: String?, val rounds: Int,
    /** What the session said last, as the hand-back froze it (`workSession.lastMessage`); null when it said nothing or still holds it. */
    val lastMessage: String? = null) {
    /** Still in the session's hands: offered and not handed back. */
    val held: Boolean get() = returnedAt == null
    /** The round the session is on while it holds the item: the generations it asked for, plus the one it is fixing now. */
    val round: Int get() = (rounds + 1).coerceAtMost(LandingFixWindowCopy.ROUNDS)
}

object LandingFix {
    /** `4m`, `just now` — how long ago, as the board's lines say it. */
    fun age(iso: String?, now: Instant): String {
        val at = ProjectTime.parse(iso) ?: return "just now"
        val seconds = (now.toEpochMilli() - at.toEpochMilli()) / 1_000.0
        return if (seconds < 60) "just now" else SharePanelCopy.span(seconds)
    }

    /** Last words as the hand-back quotes them: trimmed, and cut at 1,200 characters as the server already cuts them (apiserver
     *  `runLastWords`); null when there are none. */
    fun lastWords(text: String?): String? {
        val words = text?.trim().orEmpty()
        if (words.isEmpty()) return null
        return if (words.length > 1_200) "${words.take(1_200)}…" else words
    }

    /** An open item's `workSession`, or null for an item never handed to a task's session (and from an older server). */
    fun workSession(row: JsonObject?): LandingWorkSession? = row?.obj("workSession")?.let { w ->
        val session = w.text("sessionId")?.takeIf { it.isNotEmpty() } ?: return null
        LandingWorkSession(session, w.text("offeredAt"), w.text("returnedAt"), w.text("returnReason"), w.number("rounds") ?: 0,
            lastWords(w.text("lastMessage")))
    }

    /** The project's items a task's session has been handed, held first (`withWorkSession`), then the ones handed back. */
    private fun offered(items: JsonObject?): List<JsonObject> = listOf("withWorkSession", "needsYou", "withCoordinator")
        .flatMap { items?.objects(it).orEmpty() }.filter { workSession(it) != null }

    /** The landing item of [taskId] a task's session holds or last handed back: the one the window's card for that task is about. */
    fun itemForTask(items: JsonObject?, taskId: String?): JsonObject? {
        if (taskId.isNullOrEmpty()) return null
        val mine = offered(items).filter { ObjectId.same(it.text("taskId"), taskId) }
        return mine.firstOrNull { workSession(it)?.held == true }
            ?: mine.maxByOrNull { ProjectTime.parse(workSession(it)?.returnedAt)?.toEpochMilli() ?: Long.MIN_VALUE }
    }

    /** The items its task's session is fixing (board ④ d): `Being fixed by its session`. */
    fun beingFixed(items: JsonObject?): List<JsonObject> = items?.objects("withWorkSession").orEmpty().filter { workSession(it)?.held == true }

    /** `The task's session is on it · 4m · round 1 of 2 · nothing was pushed` (board ④ d ①). */
    fun beingFixedLine(row: JsonObject, now: Instant): String {
        val work = workSession(row) ?: return LandingFixWindowCopy.IS_ON_IT
        return listOf(LandingFixWindowCopy.IS_ON_IT, age(work.offeredAt, now), LandingFixWindowCopy.round(work.round),
            // A required check GitHub ran is one on a pull request: the commit was pushed there.
            if (row.obj("facts")?.obj("check")?.text("name") == "GITHUB_CHECK") LandingFixWindowCopy.PULL_REQUEST_NOT_MERGED
            else LandingFixWindowCopy.NOTHING_WAS_PUSHED).joinToString(" · ")
    }

    /** What stopped the newest attempt, as its own record says it: the server's sentence on its result line. */
    fun failureLine(view: LandingView): String? {
        val job = view.currentAttempt?.jobId ?: return null
        return view.timeline?.sections?.firstOrNull { it.jobId == job }?.entries
            ?.lastOrNull { it.kind == "RESULT" || it.kind == "RESULT_FALLBACK" }?.text?.takeIf { it.isNotBlank() }
    }

    /**
     * The words the hand-back quotes (board ② d ①): what the task's session said last, as the server froze them at the hand-back — the
     * newest `RETURNED_TO_COORDINATOR` line's `data.lastMessage`, else the item's `workSession.lastMessage`. Null when it said nothing:
     * then nothing is quoted. Never the session's words since, which can have moved on.
     */
    fun handBackWords(view: LandingView?, work: LandingWorkSession?): String? {
        val returned = view?.timeline?.sections.orEmpty().flatMap { it.entries }.lastOrNull { it.kind == "RETURNED_TO_COORDINATOR" }
        return lastWords(returned?.data?.text("lastMessage")) ?: work?.lastMessage
    }

    /** The three kinds of line §12.7 adds to a landing's record. */
    val KINDS = setOf("HANDED_TO_SESSION", "FIXED_BY_SESSION", "RETURNED_TO_COORDINATOR")

    /** Which hand-off this line is, counted over the whole record: the round it opened. */
    fun handOffRound(view: LandingView, entry: LandingEntry): Int {
        val handOffs = view.timeline?.sections.orEmpty().flatMap { it.entries }.filter { it.kind == "HANDED_TO_SESSION" }
        return (handOffs.indexOfFirst { it === entry } + 1).coerceIn(1, LandingFixWindowCopy.ROUNDS)
    }

    /** The commit a fix landed again with, short: the line's own `sourceSha`, else the one its sentence names. */
    fun fixedSha(entry: LandingEntry): String? = entry.data?.text("sourceSha")?.takeIf { it.isNotEmpty() }?.take(7)
        ?: Regex("Fixed in ([0-9a-f]{7})").find(entry.text)?.groupValues?.get(1)

    /** The task's session holds a failure of this landing: its last hand-off has not been handed back, nor a fix landed again after it. */
    fun handedOff(view: LandingView?): Boolean {
        val entries = view?.timeline?.sections.orEmpty().flatMap { it.entries }.filter { it.kind in KINDS }
        return entries.lastOrNull()?.kind == "HANDED_TO_SESSION"
    }

    /**
     * The commit this session's fix landed again with (board ② b ③): the first `FIXED_BY_SESSION` line its own session ([sessionId])
     * asked for after [after] — the card's turn. Null while there is none.
     */
    fun fixLandingAgain(view: LandingView?, sessionId: String?, after: String?): String? {
        val since = ProjectTime.parse(after)
        return view?.timeline?.sections.orEmpty().flatMap { it.entries }
            .filter { it.kind == "FIXED_BY_SESSION" && (sessionId == null || ObjectId.same(it.data?.text("sessionId"), sessionId)) }
            .filter { entry -> since == null || (ProjectTime.parse(entry.at)?.let { !it.isBefore(since) } ?: true) }
            .minByOrNull { ProjectTime.parse(it.at)?.toEpochMilli() ?: Long.MAX_VALUE }
            ?.let(::fixedSha)
    }
}
