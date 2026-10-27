package io.orbitd.android.reader

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.RunSettings
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// One landing in a project's Landings window (contract §2.9 LS1, LS6, LS7; design §3; mockups v4
// docs/mocks/landing-session/v4/05-landing-session-page and 07-android, and since revision 28 the window of
// docs/mocks/landings-one-window): what a LANDING session's card and its record say, and the conditions its owner doors
// appear under. The single landing page these were drawn on is now the window focused on that landing. A port of
// OrbitKit's `LandingPageCopy` (App/LandingSessionPage.swift), itself a port of the web's
// `src/web/src/lib/landingSession.ts`; LandingSessionCopyParityTest holds every word to the Swift source.
//
// Everything here is read from `GET /sessions/:id`'s landing view — the subject, its newest attempt, the
// phase/round/check facts the runner reported, and the timeline the server already wrote in English. The one exception
// is the merge round's own sentence (`onPass`) and the receipt a settled round shows: those are the promotion row's,
// read beside the landing the way the merge card reads it.

/**
 * A landing's own words. Everything the landing view does not write itself — the head's clauses, the timeout sentences,
 * the menu and the receipt — is here, so the three clients say the same thing. The menu's labels are the board's
 * sentence case (v4 07: `Open task`, `Stop landing`), unlike iOS's title case; the parity test compares those six
 * ignoring case and says why.
 */
object LandingSessionCopy {
    /** The page's own word for the subject, beside the title (the board's `Landing` chip). */
    const val CHIP = "Landing"
    const val RUN_BY_ORBIT = "Run by Orbit"

    /** A TASK subject's title when no session row exists yet and the task is not read. */
    const val LAND = "Land"
    /** A PROMOTION subject's title while its row does not exist: `Merge project/<id> → main · #n`. */
    const val MERGE_ROUND = "Merge project"
    const val INTO_MAIN = "main"

    const val LANDED = "Landed"
    const val ALREADY_LANDED = "Already landed"
    const val NOTHING_TO_LAND = "Nothing to land"
    const val HANDLED = "Handled"
    const val DECLINED = "Declined"
    const val CANCELLED = "Cancelled"
    const val DELETED = "Deleted"
    const val MERGED_INTO = "Merged into"
    const val NOW_ON = "Now on"
    const val LANDED_ON = "Landed on"
    const val ALREADY_ON = "Already on"
    const val NOT_LANDED = "Not landed"
    const val NOT_MERGED = "Not merged"
    const val READY = "Ready"
    const val PASSED_CHECK = "Passed the check · waiting for the owner"
    const val PASSED_ON_THE_TREE = "✓ Passed on the combined tree"
    const val LANDED_EXACTLY = "Landed exactly the tested tree"
    const val AS_A_MERGE_COMMIT = "as a merge commit"
    const val BY_FAST_FORWARD = "by fast-forward"
    const val AUTOMATICALLY = "automatically"
    const val BY_YOU = "by you"

    const val QUEUED = "queued"
    const val CANCELLING = "Cancelling"
    const val TIMED_OUT = "Timed out"
    const val UPDATE_UNAVAILABLE = "Update unavailable"
    const val TASK_ACCEPTANCE = "Task acceptance"
    const val MERGE_CHECK = "Merge check"
    const val RUNNING = "running"
    const val CHECKS_FAILED = "checks failed"
    const val EXIT = "exit"
    const val AFTER = "after"
    const val ON_THE_COMBINED_TREE = "on the combined tree"
    const val NOTHING_PUSHED_CLAUSE = "nothing was pushed"
    const val STOPPED_WITH_AN_ERROR = "Stopped with an error"
    const val COULD_NOT_MERGE = "Could not merge"
    const val CONFLICT = "conflict"
    const val STOPPED_NOT_LANDED = "Stopped · not landed"
    fun taskAcceptanceExited(code: String, expected: String) = "Task acceptance exited $code (expected $expected) on the combined tree"
    const val CHECKS_TIMED_OUT = "A check timed out on the combined tree"

    /** The timed-out card's one line about the claim: who took it, when, and where it stopped. */
    const val TOOK_IT_AT = "took it at"
    const val STOPPED_AT = "stopped at"
    const val THE_RUNNER = "The runner"
    const val RUNNER = "Runner"
    const val NO_REPORT_FOR = "No report for"
    const val NO_REPORT_FROM = "No report from"
    const val SINCE = "since"
    const val LIMIT = "limit"
    const val NOTHING_WAS_PUSHED = "Nothing was pushed"
    const val MAY_HAVE_BEEN_PUSHED = "May have been pushed"
    const val NOTHING_PUSHED_SENTENCE = "Nothing was pushed — the runner reports before it pushes, and it never did."
    const val MAY_HAVE_PUSHED_SENTENCE =
        "May have been pushed — an older runner reports only between steps, so Orbit can’t rule it out."
    fun mayHavePushedAt(time: String) = "May have been pushed — it reported starting the push at $time, then went silent."

    /** The menu and the presses that leave a landing for its people (design §3, LS6). The board's sentence case, unlike iOS's. */
    const val OPEN_TASK = "Open task"
    const val OPEN_SOURCE_SESSION = "Open source session"
    const val OPEN_COORDINATOR = "Open coordinator"
    const val REVIEW_CARD = "Review card"
    const val STOP_LANDING = "Stop landing"
    const val CANCEL_MERGE = "Cancel merge"
    const val ABANDON = "Abandon"
    const val RETRY = "Retry"
    const val RERUN_THE_CHECK = "Re-run the check"
    /** What the page's Re-run the check records as its reason: the owner route requires one (`RetryIntegrationDto.reason`),
     *  and the sentence names the page the door was pressed on (web's `RERUN_LANDING_CHECK_REASON`; the Swift sends it too). */
    const val RERUN_LANDING_CHECK_REASON = "Re-run the timed-out check from the landing page."
    /** What the merge card's Re-run the check records instead, naming the card it was pressed on
     *  (web's `RERUN_CHECK_REASON`, Swift's `LandingPageCopy.rerunCheckReason`). */
    const val RERUN_CHECK_REASON = "Re-run the timed-out check from the merge card."
    const val BEFORE_PUSH_ONLY = "Before the push only · nothing pushed yet"
    const val CANCEL_BEFORE_PUSH = "Before the push only · stops at the runner’s next report"
    const val ENDS_NOTHING_PUSHED = "Ends this attempt · nothing was pushed"
    const val ENDS_MAY_HAVE_PUSHED = "Ends this attempt · it may have been pushed"
    const val STOP_FAILED = "Stop failed"
    const val CANCEL_FAILED = "Cancel failed"
    const val ABANDON_FAILED = "Abandon failed"
    const val RETRY_FAILED = "Retry failed"
    const val RERUN_FAILED = "Re-run failed"
    const val RERUN_END = "Re-run ends this check and queues the next one on the same candidate."
    const val ABANDON_END = "Abandon only ends it; the candidate goes back to you."
    const val NO_RETRY_MERGE =
        "No Retry: a confirmed merge ends by Abandon, or finishes when a new process on the runner takes it over."
    const val LEGACY_PUSH_VARIANT =
        "An older runner (reports only between steps): may have been pushed — Orbit can’t rule it out."

    const val LOADING_LANDING = "Loading this landing…"
    const val LOADING_LOG = "Loading the log…"
    const val LOG_UNAVAILABLE = "Couldn’t read this log"
    const val LOG_EMPTY = "This check printed nothing."
    const val SHOW_MORE = "Show more"
    const val LOG = "Log"
    const val OLDER_ATTEMPTS_HIDDEN = "Older attempts are not shown here."
    fun bytesOmitted(bytes: Int) = "$bytes bytes omitted"
    /** The window's read-only footer names who decides (LS6: nothing to type here). */
    const val DECISIONS_THE_COORDINATOR = "Decisions: the coordinator"

    /** The ways into a landing session (contract §2.9 LS6, owner 2026-10-19: 方案 A). Held to the Swift's `LandingPageCopy.openLanding`,
     * `noLandingPage` and `allJobs`. */
    const val OPEN_LANDING = "Open landing"
    const val NO_LANDING_PAGE = "No landing page on this server yet"
    const val ALL_JOBS = "All jobs"

    /** `+N job queued` — the other jobs a merge round stands for, beside its `All jobs ›`; null when it stands for one. */
    fun moreJobsQueued(count: Int): String? {
        val others = count - 1
        if (others <= 0) return null
        return "+$others job${if (others == 1) "" else "s"} queued"
    }
}

/** A landing entrance's two answers (iOS `LandingEntry`): a session id to open, or the fact that this server names none. */
sealed interface LandingTarget {
    data class Link(override val sessionId: String) : LandingTarget
    data object NoPage : LandingTarget

    val sessionId: String? get() = (this as? Link)?.sessionId
    /** The words beside the press, or in its place. */
    val label: String get() = when (this) {
        is Link -> LandingSessionCopy.OPEN_LANDING
        NoPage -> LandingSessionCopy.NO_LANDING_PAGE
    }
}

/** The one rule every entrance wears: a session to open, else the grey sentence in the same slot. */
fun landingEntry(landingSessionId: String?): LandingTarget =
    landingSessionId?.takeIf { it.isNotEmpty() }?.let { LandingTarget.Link(it) } ?: LandingTarget.NoPage

/** The check a v2 claim is running, as the landing view carries it (the project integration read's `ProjectIntegrationCheck`). */
data class LandingAttemptCheck(val name: String?, val index: Int, val count: Int, val budgetSeconds: Int, val startedAt: String?)

/** The landing's newest attempt, whatever its state (`SessionLandingAttempt`). */
data class LandingAttempt(
    val jobId: String,
    val kind: String,
    val state: String,
    val generation: Int,
    val phase: String?,
    val round: Int?,
    val step: String?,
    val claim: Int,
    val runnerName: String?,
    val sourceSessionId: String?,
    val targetRef: String,
    val startedAt: String,
    val heartbeatAt: String?,
    val outputMovedAt: String?,
    val progressProtocol: String?,
    val check: LandingAttemptCheck?,
    val liveness: String?,
    val timedOut: Boolean,
    val limitSeconds: Int?,
    val retryable: Boolean,
    val pushBoundaryPassed: Boolean,
    /** Why a queued attempt waits, in the server's own sentence (the view's `blockingReason.summary`). */
    val blockingSummary: String?,
)

/** One line of the server-written timeline (`IntegrationTimelineEntry`); [text] is the whole sentence, [data] the
 *  structured fields it was written from (a check's exit codes, a result's state). */
data class LandingEntry(val kind: String, val at: String, val claim: Int, val round: Int?, val checkName: String?, val checkIndex: Int?,
    val phase: String?, val reason: String?, val text: String, val data: JsonObject? = null)
data class LandingSection(val title: String, val jobId: String, val kind: String, val generation: Int, val state: String,
    val entries: List<LandingEntry>)
data class LandingFact(val kind: String, val text: String)
data class LandingTimeline(val sections: List<LandingSection>, val facts: List<LandingFact>, val truncated: Boolean)

/** One finished check's result, as the runner reports it (`LandingCheckResult`). */
data class LandingCheckResult(val name: String?, val exitCode: Int?, val expectedExitCode: Int?, val timedOut: Boolean, val durationMs: Int?) {
    /** No timeout, and the exit code the command declared (or none reported). */
    val passed: Boolean get() = !timedOut && (exitCode == null || exitCode == expectedExitCode)
}

/** `GET /sessions/:id`'s landing view (`SessionLandingView`). Optional slots an older server omits read null/empty. */
data class LandingView(
    val sessionId: String,
    val projectId: String,
    val subject: String,
    val taskId: String?,
    val promotionId: String?,
    val episode: Int,
    val openedAt: String,
    val settledAt: String?,
    val settledAs: String?,
    val checks: List<LandingCheckResult>,
    val currentAttempt: LandingAttempt?,
    val timeline: LandingTimeline?,
)

/** One page of one check's output (`GET /sessions/:id/landing/log`). */
data class LandingLogEntry(val text: String, val truncatedBytes: Int)
data class LandingLogPage(val jobId: String?, val entries: List<LandingLogEntry>, val nextCursor: String?)

/** The read selectors a log line carries: the attempt, the claim and round inside it, and the check's position. */
data class LandingLogSelectors(val jobId: String, val claim: Int?, val round: Int?, val check: Int?)

/** The facts a landing status card renders (OrbitKit `LandingAttemptCard`). */
data class LandingAttemptCard(
    /** `Landing`, `Merge check`, `Merge to main` — the head's word. */
    val word: String,
    /** The step, `queued`, `Timed out`, `Update unavailable`, or the terminal verdict. */
    val state: String,
    /** The head's right slot: the step's clock, or a word (`Timed out`, `Not landed`, …). */
    val right: String,
    val rightIsClock: Boolean,
    /** The line under the word: state, the V6 clauses, the claim and the freshness. */
    val detail: String,
    /** `Merge check 2m 40s of 60m · usually ~18m`, under the head; null for a queued attempt. */
    val budget: String?,
    /** How far through its budget the current step is, for the quiet meter under the head. */
    val progress: Float?,
    /** `Output 3s ago · Updated just now` — the two server facts, in §7.2 V6's words. */
    val live: String?,
    /** The heartbeat is fresh (LIVE or QUIET): the card draws the green freshness dot. */
    val fresh: Boolean,
    val usualProgress: Float?,
    /** What stopped it, in a sentence under the head (a failed check, a conflict, an error). */
    val failure: String?,
    val running: Boolean,
    val timedOut: Boolean,
)

/** A settled subject's card: the outcome the round (or the task's segment) reached (OrbitKit `LandingOutcomeCard`). */
data class LandingOutcomeCard(val title: String, val right: String, val detail: String?, val tasksHeading: String?, val tasks: List<String>,
    val checkLine: String?, val treeLine: String?, val ok: Boolean)

/** The receipt a merge row opens to in the Landings window (board 03 e; OrbitKit `LandingMergeReceipt`): `Now on main · 2 tasks`, the
 *  tasks by name, the check that passed on the combined tree and the tree that landed. */
data class LandingMergeReceipt(val heading: String, val tasks: List<String> = emptyList(), val checkLine: String? = null,
    val treeLine: String? = null)

/** Which of the owner's doors the landing view's own facts open (LS6: none is inferred here). */
data class LandingGates(val stop: Boolean = false, val cancel: Boolean = false, val abandon: Boolean = false, val retry: Boolean = false,
    val recheck: Boolean = false)

/** What a landing menu row does; the page owns the navigation and the press. */
enum class LandingMenuAction { OPEN_TASK, OPEN_SOURCE_SESSION, OPEN_COORDINATOR, REVIEW_CARD, STOP, CANCEL, ABANDON, RETRY, RERUN_THE_CHECK }

/** One row of the menu a landing's long-press opens (the old landing page's ⋯). */
data class LandingMenuItem(val key: String, val action: LandingMenuAction, val label: String, val sub: String? = null, val danger: Boolean = false)

/** The read-time facts §7.2 V6 takes from the project's integration read (the landing view does not carry them). */
data class LandingFacts(val stepStartedAt: String? = null, val typicalMs: Int? = null, val main: String? = null) {
    val mainBranch: String get() = main ?: RunSettings.defaultMainBranch
}

object LandingSessionModel {
    private const val MINUTE = 60_000L
    private const val LEASE_STALE_MS = 90_000L

    /** Whether a `GET /sessions/:id` answer is a landing's (LS6): the detail's own `sessionKind`, never a list row's `kind`. */
    fun isLanding(detail: JsonObject?) = detail?.text("sessionKind") == "LANDING"

    /** The landing view a session detail carries — present on a landing, absent on a conversation and an older server. */
    fun view(detail: JsonObject?): LandingView? = detail?.obj("landing")?.let(::read)

    /** One attempt, from the view's `currentAttempt` or an integration read's `inFlightJobs` entry (the same names): every field an
     *  older server — or the job's shorter shape — omits reads as the fact it did not send. */
    private fun attempt(a: JsonObject) = LandingAttempt(
        jobId = a.text("jobId").orEmpty(), kind = a.text("kind").orEmpty(), state = a.text("state").orEmpty(),
        generation = a.number("generation") ?: 1, phase = a.text("phase"), round = a.number("round"), step = a.text("step"),
        claim = a.number("claim") ?: 0, runnerName = a.text("runnerName"), sourceSessionId = a.text("sourceSessionId"),
        targetRef = a.text("targetRef").orEmpty(), startedAt = a.text("startedAt").orEmpty(), heartbeatAt = a.text("heartbeatAt"),
        outputMovedAt = a.text("outputMovedAt"), progressProtocol = a.text("progressProtocol"),
        check = a.obj("check")?.let { c -> LandingAttemptCheck(c.text("name"), c.number("index") ?: 1, c.number("count") ?: 1,
            c.number("budgetSeconds") ?: 0, c.text("startedAt")) },
        liveness = a.text("liveness"), timedOut = a.flag("timedOut"), limitSeconds = a.number("limitSeconds"),
        retryable = a.flag("retryable"), pushBoundaryPassed = a.flag("pushBoundaryPassed"),
        blockingSummary = a.obj("blockingReason")?.text("summary")?.takeIf { it.isNotEmpty() },
    )

    /** Decode the landing view. The timeline and its slots are optional (a server that predates them), and every attempt
     *  field an older server omits reads as the fact it did not send. */
    fun read(json: JsonObject): LandingView {
        val attempt = json.obj("currentAttempt")?.let(::attempt)
        val timeline = json.obj("timeline")?.let { t ->
            LandingTimeline(
                sections = t.objects("sections").map { s ->
                    LandingSection(s.text("title").orEmpty(), s.text("jobId").orEmpty(), s.text("kind").orEmpty(),
                        s.number("generation") ?: 1, s.text("state").orEmpty(), s.objects("entries").map { e ->
                            LandingEntry(e.text("kind").orEmpty(), e.text("at").orEmpty(), e.number("claim") ?: 0, e.number("round"),
                                e.obj("check")?.text("name"), e.obj("check")?.number("index"), e.text("phase"), e.text("reason"),
                                e.text("text").orEmpty(), e.obj("data"))
                        })
                },
                facts = t.objects("facts").map { LandingFact(it.text("kind").orEmpty(), it.text("text").orEmpty()) },
                truncated = t.flag("truncated"),
            )
        }
        return LandingView(
            sessionId = json.text("sessionId").orEmpty(), projectId = json.text("projectId").orEmpty(),
            subject = json.text("subject").orEmpty(), taskId = json.text("taskId"), promotionId = json.text("promotionId"),
            episode = json.number("episode") ?: 1, openedAt = json.text("openedAt").orEmpty(), settledAt = json.text("settledAt"),
            settledAs = json.text("settledAs"),
            checks = json.objects("checks").map {
                LandingCheckResult(it.text("name"), it.number("exitCode"), it.number("expectedExitCode"), it.flag("timedOut"), it.number("durationMs"))
            },
            currentAttempt = attempt, timeline = timeline,
        )
    }

    /**
     * What a device that cannot reach the server draws for a landing page it has not read yet (iOS `offlinePlaceholder`): the job
     * an integration read last described, as the page's attempt — nothing settled, no timeline, no door. [attemptCard] draws it as
     * a failed read, its clock frozen at that read and `Update unavailable` in its head, and [gates] opens nothing on a failed read.
     */
    fun offlinePlaceholder(sessionId: String, job: JsonObject): LandingView = LandingView(
        sessionId = sessionId, projectId = "", subject = if (job.text("taskId").isNullOrEmpty()) "PROMOTION" else "TASK",
        taskId = job.text("taskId"), promotionId = job.text("promotionId"), episode = 1, openedAt = job.text("startedAt").orEmpty(),
        settledAt = null, settledAs = null, checks = emptyList(), currentAttempt = attempt(job), timeline = null,
    )

    /** The last six lines a check printed that are not blank (the live block's and a failed check's inline tail; iOS and web keep
     *  the same six). Carriage returns go; an empty answer is no tail at all. */
    fun tail(text: String): String = text.replace("\r", "").split("\n").filter { it.isNotBlank() }.takeLast(6).joinToString("\n")

    /** One page of a check's output. */
    fun logPage(json: JsonObject): LandingLogPage = LandingLogPage(json.text("jobId"), json.objects("entries").map {
        LandingLogEntry(it.text("text").orEmpty(), it.number("truncatedBytes") ?: 0)
    }, json.text("nextCursor"))

    /**
     * §2.7a's cadence for a landing page: a RUNNING attempt four seconds, a queued one (or a stopped one waiting for
     * its next attempt) fifteen, and nothing once the subject has settled. A page with nothing read yet asks again in
     * fifteen (iOS's own rule: a failure must not stop the poll).
     */
    fun nextReadMs(view: LandingView?): Long? {
        if (view == null) return 15_000
        if (view.settledAt != null) return null
        return if (view.currentAttempt?.state == "RUNNING") 4_000 else 15_000
    }

    /** Whether this device has lost the server: its last read failed, or is more than 90 s old. */
    fun readUnavailable(now: Instant, updatedAt: Instant?, failed: Boolean) =
        failed || (updatedAt != null && elapsedMs(updatedAt, now) > LEASE_STALE_MS)

    /** The page title: the session row's own (server-managed) title, or the one the view can spell. */
    fun headerTitle(view: LandingView?, rowTitle: String?, taskTitle: String? = null): String {
        if (!rowTitle.isNullOrEmpty()) return rowTitle
        if (view == null) return LandingSessionCopy.CHIP
        if (view.subject == "PROMOTION") {
            val project = ObjectId.toPublic(view.projectId)
            return "${LandingSessionCopy.MERGE_ROUND} $project → ${LandingSessionCopy.INTO_MAIN} · #${view.episode}"
        }
        return if (!taskTitle.isNullOrEmpty()) "${LandingSessionCopy.LAND} · $taskTitle" else LandingSessionCopy.LAND
    }

    /** `17m 41s`, `1h 05m` — the check's own duration, as the timeline's sentences spell one. */
    fun duration(ms: Int?): String {
        val total = max(0, ((ms ?: 0) / 1_000.0).roundToInt())
        val hours = total / 3_600
        val mins = (total % 3_600) / 60
        val seconds = total % 60
        return if (hours > 0) "${hours}h ${"%02d".format(mins)}m" else "${mins}m ${"%02d".format(seconds)}s"
    }

    /** `Merge check` / `Task acceptance`, the names the check rows use. */
    fun checkLabel(name: String?) = if (name == "MERGE_CHECK") LandingSessionCopy.MERGE_CHECK else LandingSessionCopy.TASK_ACCEPTANCE

    private fun section(view: LandingView, jobId: String) = view.timeline?.sections?.firstOrNull { it.jobId == jobId }

    /** When the attempt FIRST started: the timeline's own first claim line — the same fact the head says as `first started 17:03`. */
    fun firstStartedAt(view: LandingView, jobId: String): String? = section(view, jobId)?.entries
        ?.filter { it.kind == "CLAIMED" || it.kind == "TAKEN_OVER" }
        ?.mapNotNull { ProjectTime.parse(it.at)?.let { at -> at to it.at } }
        ?.minByOrNull { it.first }?.second

    /** The first line that says the runner reported starting a push, if the timeline holds one. */
    private fun pushReport(view: LandingView, jobId: String): Pair<Boolean, String?> {
        val entry = section(view, jobId)?.entries?.firstOrNull { it.kind == "PUSH_REFUSED" || it.phase == "PUSH" || it.phase == "VERIFY" }
        return (entry != null) to entry?.at
    }

    /** Whether a stop or cancel has been ASKED for and the runner has not answered yet (J-T8/M-T10). */
    fun cancelling(view: LandingView): Boolean {
        val attempt = view.currentAttempt ?: return false
        if (attempt.state != "RUNNING") return false
        return section(view, attempt.jobId)?.entries.orEmpty().any { it.kind == "STOP_REQUESTED" && it.claim == attempt.claim }
    }

    private fun elapsedMs(from: Instant, to: Instant) = to.toEpochMilli() - from.toEpochMilli()
    private fun minutesSince(at: Instant, now: Instant) = max(0L, elapsedMs(at, now) / MINUTE).toInt()
    private fun instant(iso: String?): Instant? = ProjectTime.parse(iso)

    /**
     * The status card over the subject's newest attempt: the landing row's head with §7.2 V6's rows under it.
     *
     * Liveness is the server's word, read at the moment of the view: LIVE and QUIET let the local clock run, SILENT
     * freezes it at the runner's last word, LEGACY freezes it at the read, and LEASE_EXPIRED is the one timeout — the
     * card then draws the server's own `Timed out` head. A read this device could not make is said first: whatever the
     * last read said is frozen at `Update unavailable`.
     */
    fun attemptCard(view: LandingView, now: Instant, updatedAt: Instant? = null, failed: Boolean = false,
        facts: LandingFacts = LandingFacts(), zone: ZoneId = ZoneId.systemDefault()): LandingAttemptCard? {
        val attempt = view.currentAttempt ?: return null
        val main = facts.mainBranch
        val word = ProjectPage.jobWords(main)[attempt.kind] ?: LandingSessionCopy.CHIP
        val unavailable = readUnavailable(now, updatedAt, failed)
        val timedOut = attempt.timedOut || attempt.liveness == "LEASE_EXPIRED"
        val readAt = updatedAt

        if (unavailable) {
            val stepStart = instant(facts.stepStartedAt) ?: instant(attempt.check?.startedAt) ?: instant(attempt.startedAt)
            val frozenAt = minOf(now, readAt ?: now)
            val stepClock = stepStart?.let { ProjectPage.landingClock(max(0.0, elapsedMs(it, frozenAt) / 1_000.0)) } ?: "0m 0s"
            val budgetMinutes = attempt.check?.let { (it.budgetSeconds / 60.0).roundToInt() }
            val updated = readAt?.let { minutesSince(it, now) }
            return LandingAttemptCard(word, LandingSessionCopy.UPDATE_UNAVAILABLE, stepClock, true,
                LandingSessionCopy.UPDATE_UNAVAILABLE,
                if (attempt.check != null && budgetMinutes != null) "${checkLabel(attempt.check.name)} $stepClock ${ProjectPage.landingOf} ${budgetMinutes}m" else null,
                null, updated?.let { "Updated ${it}m ago" }, false, null, null, false, false)
        }

        if (timedOut) {
            val silentSince = instant(attempt.heartbeatAt) ?: instant(attempt.startedAt)
            val silent = silentSince?.let { minutesSince(it, now) } ?: 0
            val limit = attempt.limitSeconds?.let { "${LandingSessionCopy.LIMIT} ${(it / 60.0).roundToInt()}m" }
            return LandingAttemptCard(word, LandingSessionCopy.TIMED_OUT, LandingSessionCopy.TIMED_OUT, false,
                listOfNotNull("${LandingSessionCopy.NO_REPORT_FOR} ${silent}m", limit).joinToString(" · "),
                null, null, null, false, null, null, false, true)
        }

        if (attempt.state == "QUEUED" || attempt.claim == 0) {
            val queuedAt = instant(attempt.startedAt)
            return LandingAttemptCard(word, LandingSessionCopy.QUEUED,
                queuedAt?.let { ProjectPage.landingClock(max(0.0, elapsedMs(it, now) / 1_000.0)) } ?: "0m 0s", true,
                listOfNotNull(LandingSessionCopy.QUEUED, attempt.blockingSummary).joinToString(" · "),
                null, null, null, false, null, null, false, false)
        }

        if (attempt.state != "RUNNING") return terminalCard(view, attempt, word, unavailable = false)

        // The current step's clock: the check's own start when one is in flight, else the step's, and the claim's as
        // the last fallback. SILENT freezes it at the runner's last word and LEGACY at the read.
        val stepStart = instant(facts.stepStartedAt) ?: instant(attempt.check?.startedAt) ?: instant(attempt.startedAt)
        val heartbeat = instant(attempt.heartbeatAt)
        val liveness = attempt.liveness
        val elapsedAt = when (liveness) {
            "SILENT" -> heartbeat ?: stepStart ?: now
            "LEGACY" -> readAt ?: now
            else -> now
        }
        val stepClock = stepStart?.let { ProjectPage.landingClock(max(0.0, elapsedMs(it, elapsedAt) / 1_000.0)) } ?: "0m 0s"
        val budgetMinutes = attempt.check?.let { (it.budgetSeconds / 60.0).roundToInt() }

        val clauses = mutableListOf<String>()
        when (liveness) {
            "LIVE" -> instant(attempt.outputMovedAt)?.let {
                clauses += "${outputWord()} ${max(0, (elapsedMs(it, now) / 1_000.0).roundToInt())}s ago"
            }
            "QUIET" -> {
                instant(attempt.outputMovedAt)?.let { clauses += "${noOutputWord()} ${minutesSince(it, now)}m" }
                if (budgetMinutes != null) clauses += "${ProjectPage.landingWithinIts} ${budgetMinutes}m ${ProjectPage.landingBudget}"
            }
            "SILENT" -> {
                val since = heartbeat ?: stepStart ?: now
                val who = attempt.runnerName?.takeIf { it.isNotEmpty() }?.let { "${noWordFromRunnerWord()} $it" }
                    ?: noWordFromTheRunnerWord()
                clauses += "$who for ${minutesSince(since, now)}m"
            }
            "LEGACY" -> clauses += reportsOnlyBetweenStepsWord()
        }
        // Usually is the merge check's own fact (design §3): an acceptance check has no usual duration to name.
        if (attempt.check?.name == "MERGE_CHECK" && facts.typicalMs != null) {
            clauses += "${ProjectPage.landingUsually} ~${(facts.typicalMs / MINUTE.toDouble()).roundToInt()}m"
        }
        if (attempt.claim >= 1) {
            clauses += "${ProjectPage.landingClaim} ${attempt.claim}"
            if (attempt.round != null) clauses += ProjectPage.landingRoundClause(attempt.round, attempt.kind)
        }
        if (attempt.claim > 1) {
            val started = instant(attempt.startedAt)?.let { ProjectPage.landingClockTime(it, zone) } ?: "--:--"
            val first = firstStartedAt(view, attempt.jobId)?.let(::instant)
            clauses += if (first != null) "${ProjectPage.landingTakenOver} $started · ${ProjectPage.landingFirstStarted} ${ProjectPage.landingClockTime(first, zone)}"
                else "${ProjectPage.landingTakenOver} $started"
        }
        // Freshness is the runner's own last report, not this app's read: a successful refresh does not make a silent job
        // look active (the same rule the landing row's line follows).
        val freshnessAt = heartbeat ?: readAt ?: now
        val age = if (liveness == "SILENT") null else minutesSince(freshnessAt, now)
        if (age != null) clauses += if (age == 0) "updated just now" else "updated ${age}m ago"

        val phase = attempt.phase?.takeIf { it.isNotEmpty() }?.let { ProjectPage.phaseWords(main)[it] ?: LandingSessionCopy.RUNNING }
        val state = if (cancelling(view)) LandingSessionCopy.CANCELLING else phase ?: LandingSessionCopy.RUNNING
        val outputMoved = instant(attempt.outputMovedAt)
        val outputAge = outputMoved?.let { max(0, (elapsedMs(it, now) / 1_000.0).roundToInt()) }
        val updatedWord = age?.let { if (it == 0) "Updated just now" else "Updated ${it}m ago" }
        val live = when (liveness) {
            "LIVE" -> listOfNotNull(outputAge?.let { "Output ${it}s ago" }, updatedWord).joinToString(" · ")
            "QUIET" -> listOfNotNull(outputMoved?.let { "No output for ${minutesSince(it, now)}m" },
                budgetMinutes?.let { "within its ${it}m budget" }, updatedWord).joinToString(" · ")
            "SILENT" -> {
                val since = heartbeat ?: stepStart ?: now
                val who = attempt.runnerName?.takeIf { it.isNotEmpty() }?.let { "runner $it" } ?: "the runner"
                "No word from $who for ${minutesSince(since, now)}m"
            }
            "LEGACY" -> listOfNotNull("Reports only between steps", updatedWord).joinToString(" · ")
            else -> updatedWord
        }
        val progress = if (attempt.check != null && stepStart != null && attempt.check.budgetSeconds > 0)
            (elapsedMs(stepStart, elapsedAt) / (attempt.check.budgetSeconds * 1_000.0)).toFloat().coerceIn(0f, 1f) else null
        val usualProgress = if (attempt.check?.name == "MERGE_CHECK" && facts.typicalMs != null && attempt.check.budgetSeconds > 0)
            (facts.typicalMs / (attempt.check.budgetSeconds * 1_000.0)).toFloat().coerceIn(0f, 1f) else null
        val budget = if (attempt.check != null && budgetMinutes != null) {
            "${checkLabel(attempt.check.name)} $stepClock ${ProjectPage.landingOf} ${budgetMinutes}m" +
                (facts.typicalMs?.let { " · usually ~${(it / MINUTE.toDouble()).roundToInt()}m" } ?: "")
        } else null
        return LandingAttemptCard(word, state, if (budgetMinutes == null) stepClock else "$stepClock ${ProjectPage.landingOf} ${budgetMinutes}m",
            true, (listOf(state) + clauses).joinToString(" · "), budget, progress, live,
            liveness == "LIVE" || liveness == "QUIET", usualProgress, null, true, false)
    }

    /** The card for an attempt that has ended but whose subject has not: what stopped it. */
    private fun terminalCard(view: LandingView, attempt: LandingAttempt, word: String, unavailable: Boolean): LandingAttemptCard {
        val mergeJob = attempt.kind != "LAND_TASK"
        val failed = view.checks.firstOrNull { it.timedOut || (it.exitCode != null && it.exitCode != it.expectedExitCode) }
        val label = checkLabel(failed?.name)
        val clause = when {
            failed?.timedOut == true -> "${LandingSessionCopy.CHECKS_FAILED} · ${LandingSessionCopy.CHECKS_TIMED_OUT.replaceFirstChar { it.lowercase() }}"
            failed != null -> "${LandingSessionCopy.CHECKS_FAILED} · ${LandingSessionCopy.EXIT} ${failed.exitCode ?: "—"} " +
                "${LandingSessionCopy.AFTER} ${duration(failed.durationMs)}"
            attempt.state == "CONFLICT" -> "${LandingSessionCopy.COULD_NOT_MERGE} · ${LandingSessionCopy.CONFLICT}"
            attempt.state == "ERROR" -> LandingSessionCopy.STOPPED_WITH_AN_ERROR
            else -> LandingSessionCopy.STOPPED_NOT_LANDED
        }
        val failure = when {
            failed != null -> (if (failed.timedOut) "$label ${LandingSessionCopy.TIMED_OUT.replaceFirstChar { it.lowercase() }} ${LandingSessionCopy.ON_THE_COMBINED_TREE}"
                else LandingSessionCopy.taskAcceptanceExited(failed.exitCode?.toString() ?: "—", (failed.expectedExitCode ?: 0).toString())) +
                " · ${LandingSessionCopy.NOTHING_PUSHED_CLAUSE}"
            attempt.state == "CONFLICT" -> "${LandingSessionCopy.COULD_NOT_MERGE} · ${LandingSessionCopy.CONFLICT}"
            attempt.state == "ERROR" -> "${LandingSessionCopy.STOPPED_WITH_AN_ERROR} · ${LandingSessionCopy.NOTHING_PUSHED_CLAUSE}"
            // A merge check that ended READY passed and waits for the owner: nothing stopped it.
            attempt.kind == "CHECK_PROMOTION" && attempt.state == "READY" -> null
            else -> LandingSessionCopy.STOPPED_NOT_LANDED
        }
        val ready = attempt.state == "READY"
        return LandingAttemptCard(word, if (ready) LandingSessionCopy.READY else clause,
            if (ready) LandingSessionCopy.READY else if (mergeJob) LandingSessionCopy.NOT_MERGED else LandingSessionCopy.NOT_LANDED,
            false, if (ready) LandingSessionCopy.PASSED_CHECK else clause, null, null, null, false, null,
            if (unavailable) null else failure, false, false)
    }

    /** The settled page's head: the outcome, the commit it landed, the tasks that are now on main, the check that passed. */
    fun outcomeCard(view: LandingView, promotion: JsonObject?, zone: ZoneId = ZoneId.systemDefault()): LandingOutcomeCard? {
        val settledInstant = instant(view.settledAt) ?: return null
        val settledClock = ProjectPage.landingClockTime(settledInstant, zone)
        val main = RunSettings.mainBranchName(promotion?.text("upstreamRef"))
        val target = view.currentAttempt?.targetRef
        val duration = view.checks.sumOf { it.durationMs ?: 0 }
        val passed = view.checks.isNotEmpty() && view.checks.all { it.passed }
        val checkLine = if (passed) "${LandingSessionCopy.PASSED_ON_THE_TREE} · ${duration(duration)}" else null
        val tree = promotion?.text("landsTreeSha")?.takeIf { it.isNotEmpty() }?.take(7)
        val treeLine = tree?.let { sha ->
            "${LandingSessionCopy.LANDED_EXACTLY} $sha · " +
                (if (promotion?.text("landsAs") == "MERGE_COMMIT") LandingSessionCopy.AS_A_MERGE_COMMIT else LandingSessionCopy.BY_FAST_FORWARD)
        }
        return when (view.settledAs) {
            "MERGED" -> {
                val merged = promotion?.obj("merged")
                val titles = promotion?.objects("tasks").orEmpty().mapNotNull { it.text("title") }
                val taskIds = promotion?.get("taskIds") as? JsonArray
                val detail = listOfNotNull(
                    merged?.text("sha")?.take(7),
                    taskIds?.let { plural(it.size, "task") },
                    merged?.let { if (it.flag("automatic")) LandingSessionCopy.AUTOMATICALLY else LandingSessionCopy.BY_YOU },
                ).joinToString(" · ")
                LandingOutcomeCard("${LandingSessionCopy.MERGED_INTO} $main",
                    merged?.text("at")?.let(::instant)?.let { ProjectPage.landingClockTime(it, zone) } ?: settledClock,
                    detail.ifEmpty { null },
                    if (taskIds != null) "${LandingSessionCopy.NOW_ON} $main · ${plural(taskIds.size, "task")}" else "${LandingSessionCopy.NOW_ON} $main",
                    titles, checkLine, treeLine, true)
            }
            "LANDED" -> LandingOutcomeCard(LandingSessionCopy.LANDED, settledClock,
                target?.takeIf { it.isNotEmpty() }?.let { "${LandingSessionCopy.LANDED_ON} ${it.removePrefix("refs/heads/")}" },
                null, emptyList(), checkLine, null, true)
            "ALREADY_LANDED" -> LandingOutcomeCard(LandingSessionCopy.ALREADY_LANDED, settledClock,
                target?.takeIf { it.isNotEmpty() }?.let { "${LandingSessionCopy.ALREADY_ON} ${it.removePrefix("refs/heads/")}" },
                null, emptyList(), checkLine, null, true)
            "NOTHING_TO_LAND" -> LandingOutcomeCard(LandingSessionCopy.NOTHING_TO_LAND, settledClock, null, null, emptyList(), null, null, true)
            "HANDLED" -> LandingOutcomeCard(LandingSessionCopy.HANDLED, settledClock, null, null, emptyList(), null, null, false)
            "DECLINED" -> LandingOutcomeCard(LandingSessionCopy.DECLINED, settledClock, null, null, emptyList(), null, null, false)
            "CANCELLED" -> LandingOutcomeCard(LandingSessionCopy.CANCELLED, settledClock, null, null, emptyList(), null, null, false)
            "DELETED" -> LandingOutcomeCard(LandingSessionCopy.DELETED, settledClock, null, null, emptyList(), null, null, false)
            else -> LandingOutcomeCard(view.settledAs ?: LandingSessionCopy.HANDLED, settledClock, null, null, emptyList(), null, null, false)
        }
    }

    private fun plural(n: Int, one: String) = "$n $one${if (n == 1) "" else "s"}"

    /**
     * A merge round's receipt in the Landings window (board 03 e), from its merged record (`promotions/merged`): what is now on main,
     * the checks that passed on the combined tree and the tree that landed. The round's landing view adds its checks where the record
     * carries none; a merge older than landing sessions has only the record, and a round past the read's 20 records only its landing
     * view (OrbitKit `LandingPageCopy.mergeReceipt`, web `landingMergeReceipt`).
     */
    fun mergeReceipt(promotion: JsonObject?, view: LandingView?): LandingMergeReceipt {
        val main = RunSettings.mainBranchName(promotion?.text("upstreamRef"))
        // One rule for both shapes: no timeout, and no exit code or the expected one.
        val recorded = promotion?.objects("checks").orEmpty().map {
            LandingCheckResult(it.text("name"), it.number("exitCode"), it.number("expectedExitCode"), it.flag("timedOut"), it.number("durationMs"))
        }
        val checks = recorded.ifEmpty { view?.checks.orEmpty() }
        val passed = checks.isNotEmpty() && checks.all { it.passed }
        val heading = if (promotion != null) "${LandingSessionCopy.NOW_ON} $main · ${plural(promotion.strings("taskIds").size, "task")}"
            else "${LandingSessionCopy.NOW_ON} $main"
        val treeLine = promotion?.text("landsTreeSha")?.takeIf { it.isNotEmpty() }?.let { sha ->
            "${LandingSessionCopy.LANDED_EXACTLY} ${sha.take(7)} · " +
                (if (promotion.text("landsAs") == "MERGE_COMMIT") LandingSessionCopy.AS_A_MERGE_COMMIT else LandingSessionCopy.BY_FAST_FORWARD)
        }
        return LandingMergeReceipt(heading, promotion?.objects("tasks").orEmpty().mapNotNull { it.text("title") },
            if (passed) "${LandingSessionCopy.PASSED_ON_THE_TREE} · ${duration(checks.sumOf { it.durationMs ?: 0 })}" else null, treeLine)
    }

    /**
     * The doors the newest attempt's own facts open. Every condition is the view's: the job's kind, whether it is in
     * flight, the server's `timedOut`/`liveness`, the phase the runner reported, and the push boundary the server
     * computed. A read this device could not make opens nothing.
     */
    fun gates(view: LandingView, now: Instant, updatedAt: Instant? = null, failed: Boolean = false): LandingGates {
        if (view.settledAt != null || readUnavailable(now, updatedAt, failed)) return LandingGates()
        val attempt = view.currentAttempt ?: return LandingGates()
        val expired = attempt.timedOut || attempt.liveness == "LEASE_EXPIRED"
        if (!(attempt.state == "RUNNING" || attempt.state == "QUEUED")) return LandingGates()
        val pastPush = attempt.pushBoundaryPassed
        val cancelling = cancelling(view)
        return LandingGates(
            stop = attempt.kind == "LAND_TASK" && !expired && !pastPush && !cancelling,
            cancel = attempt.kind == "LAND_PROMOTION" && !expired && !pastPush && !cancelling,
            abandon = attempt.state == "RUNNING" && expired,
            retry = attempt.retryable,
            recheck = attempt.timedOut && attempt.kind == "CHECK_PROMOTION" && view.promotionId != null,
        )
    }

    /**
     * The ⋯ menu's rows, in the order the board draws them: the ways to look at this work, then the doors the landing
     * view's facts open. No Copy Link (design §3, owner 2026-10-19) and no other row invented by the client.
     */
    fun menuItems(view: LandingView, gates: LandingGates, hasCoordinator: Boolean, hasReview: Boolean, nothingPushed: Boolean): List<LandingMenuItem> {
        val items = mutableListOf<LandingMenuItem>()
        if (!view.taskId.isNullOrEmpty()) items += LandingMenuItem("task", LandingMenuAction.OPEN_TASK, LandingSessionCopy.OPEN_TASK)
        // A merge round names the session of the task that landed last, not a source this round worked in: the board's
        // merge-round menu is Review card and Open coordinator alone.
        if (view.subject == "TASK" && !view.currentAttempt?.sourceSessionId.isNullOrEmpty()) {
            items += LandingMenuItem("source", LandingMenuAction.OPEN_SOURCE_SESSION, LandingSessionCopy.OPEN_SOURCE_SESSION)
        }
        if (hasCoordinator) items += LandingMenuItem("coordinator", LandingMenuAction.OPEN_COORDINATOR, LandingSessionCopy.OPEN_COORDINATOR)
        if (view.subject == "PROMOTION" && hasReview) items += LandingMenuItem("review", LandingMenuAction.REVIEW_CARD, LandingSessionCopy.REVIEW_CARD)
        if (gates.stop) items += LandingMenuItem("stop", LandingMenuAction.STOP, LandingSessionCopy.STOP_LANDING, LandingSessionCopy.BEFORE_PUSH_ONLY, danger = true)
        if (gates.cancel) items += LandingMenuItem("cancel", LandingMenuAction.CANCEL, LandingSessionCopy.CANCEL_MERGE, LandingSessionCopy.CANCEL_BEFORE_PUSH, danger = true)
        if (gates.abandon) items += LandingMenuItem("abandon", LandingMenuAction.ABANDON, LandingSessionCopy.ABANDON,
            if (nothingPushed) LandingSessionCopy.ENDS_NOTHING_PUSHED else LandingSessionCopy.ENDS_MAY_HAVE_PUSHED, danger = true)
        if (gates.retry) items += LandingMenuItem("retry", LandingMenuAction.RETRY, LandingSessionCopy.RETRY)
        if (gates.recheck) items += LandingMenuItem("recheck", LandingMenuAction.RERUN_THE_CHECK, LandingSessionCopy.RERUN_THE_CHECK)
        return items
    }

    /**
     * The J12 sentence under a timed-out attempt. A v2 claim that never recorded a PUSH proves nothing was pushed;
     * everything else — a legacy claim, a takeover of one, a report that named the push — may have been. A merge check
     * gets NO sentence (owner 2026-10-19): CHECK_PROMOTION never pushes.
     */
    fun pushSentence(view: LandingView, attempt: LandingAttempt, zone: ZoneId = ZoneId.systemDefault()): String? {
        if (attempt.kind == "CHECK_PROMOTION") return null
        val (reported, at) = pushReport(view, attempt.jobId)
        if (attempt.progressProtocol == "v2" && !reported) return LandingSessionCopy.NOTHING_PUSHED_SENTENCE
        if (at != null) instant(at)?.let { return LandingSessionCopy.mayHavePushedAt(ProjectPage.landingClockTime(it, zone)) }
        return LandingSessionCopy.MAY_HAVE_PUSHED_SENTENCE
    }

    /** The timed-out card's line about the claim: who took it, when, and where it stopped. */
    fun timeoutLine(attempt: LandingAttempt, main: String = RunSettings.defaultMainBranch, zone: ZoneId = ZoneId.systemDefault()): String {
        val who = attempt.runnerName?.takeIf { it.isNotEmpty() }?.let { "${LandingSessionCopy.RUNNER} $it" } ?: LandingSessionCopy.THE_RUNNER
        val took = instant(attempt.startedAt)?.let { ProjectPage.landingClockTime(it, zone) } ?: "--:--"
        val stopped = attempt.phase?.let { ProjectPage.phaseWords(main)[it] ?: LandingSessionCopy.RUNNING } ?: LandingSessionCopy.RUNNING
        val parts = mutableListOf("$who ${LandingSessionCopy.TOOK_IT_AT} $took · ${LandingSessionCopy.STOPPED_AT} $stopped",
            "${ProjectPage.landingClaim} ${attempt.claim}")
        if (attempt.round != null) parts += ProjectPage.landingRoundClause(attempt.round, attempt.kind)
        return parts.joinToString(" · ")
    }

    /** The grey band a timed-out attempt's section ends with: the runner's last word that never came. */
    fun noReportBand(view: LandingView, zone: ZoneId = ZoneId.systemDefault()): String? {
        val attempt = view.currentAttempt ?: return null
        if (!attempt.timedOut) return null
        val at = attempt.heartbeatAt ?: attempt.startedAt
        val who = attempt.runnerName?.takeIf { it.isNotEmpty() }?.let { "${LandingSessionCopy.NO_REPORT_FROM} $it" }
            ?: "${LandingSessionCopy.NO_REPORT_FROM} the runner"
        val clock = instant(at)?.let { ProjectPage.landingClockTime(it, zone) } ?: "--:--"
        return "$who ${LandingSessionCopy.SINCE} $clock"
    }

    /** A section's state after its title (`Generation 1 · not landed · CHECK_FAILED`). */
    fun sectionState(state: String): String? = when (state) {
        "CHECK_FAILED", "CONFLICT" -> "not landed · $state"
        "ERROR" -> "stopped · $state"
        "CANCELLED" -> "stopped"
        else -> null
    }

    /** A finished check passed: no timeout, and the exit code it expected. Read off [LandingEntry.data], never off the
     *  sentence; no exit code is not a pass (unlike [LandingCheckResult.passed], the settled card's rule). Swift's
     *  `IntegrationTimelineEntry.checkPassed`. */
    fun checkPassed(entry: LandingEntry): Boolean {
        val data = entry.data ?: return false
        if (entry.kind != "CHECK_FINISHED" || data.flag("timedOut")) return false
        val exitCode = data.number("exitCode") ?: return false
        return exitCode == data.number("expectedExitCode")
    }

    /** A check or result line that ended well draws ✓, and one that did not draws ✗: a passed check, or a result whose
     *  branch is on its target. [jobKind] is the kind of the section the line is in: a merge check that ends READY passed,
     *  and its round is ready to merge into main. A merge to main that answers READY handed the candidate back to be checked
     *  again and merged nothing (M-T12, J-T13), so it keeps its ✗. Swift's `IntegrationTimelineEntry.succeeded(in:)`. */
    fun entryOk(entry: LandingEntry, jobKind: String): Boolean = when (entry.kind) {
        "CHECK_FINISHED" -> checkPassed(entry)
        "RESULT", "RESULT_FALLBACK" -> entry.data?.text("state").let { state ->
            state in setOf("LANDED", "ALREADY_LANDED", "NOTHING_TO_LAND") || (jobKind == "CHECK_PROMOTION" && state == "READY")
        }
        else -> false
    }
}

// The V6 clause words the landing head folds into a sentence: ProjectPage keeps the capitalised constants (the project
// rows print them as their own clause); the head lowercases the first letter mid-line, as Swift's `lowercasedFirst()`.
private fun lowercaseFirst(text: String) = text.replaceFirstChar { it.lowercase() }
private fun outputWord() = lowercaseFirst(ProjectPage.landingOutput)
private fun noOutputWord() = lowercaseFirst(ProjectPage.landingNoOutputFor)
private fun noWordFromRunnerWord() = lowercaseFirst(ProjectPage.landingNoWordFromRunner)
private fun noWordFromTheRunnerWord() = lowercaseFirst(ProjectPage.landingNoWordFromTheRunner)
private fun reportsOnlyBetweenStepsWord() = lowercaseFirst(ProjectPage.landingReportsOnlyBetweenSteps)
