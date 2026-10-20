package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.time.Duration
import java.time.Instant
import kotlin.math.roundToLong

/**
 * The exception that became the owner's without anybody asking, and the pause only they can lift, as the coordinator's conversation
 * draws them (A08-17; OrbitKit `ExceptionCards`, the browser's `ProjectProgressStatus.tsx`). The card opens with what has to happen
 * next in the server's own sentence (`requiredAction`) and who is already fixing it (`handledBy`); then the doors the server listed,
 * in three weights, the server's `primaryAction` first, each with the one line saying what pressing it does; then the facts of the
 * item's payload; and last the owner's own ending. Every word is iOS's (`ExceptionCardsTest` reads OrbitKit's source).
 *
 * The row is the open-items read's own (`ProjectOpenItemRow`); actions and kinds keep the server's spelling.
 */
object ExceptionCards {
    const val escalatedTitle = "Escalated to you"
    const val pauseTitle = "Paused"
    const val provenance = "FROM ORBIT"
    /** What a card whose item the read no longer carries says about itself. */
    const val gone = "This exception is no longer open."

    // MARK: what has to happen next

    /** What a card opens with when the row names no next step and carries no sentence of its own. */
    const val requiredActionFallback = "Review what needs to happen next."

    /** The card's first sentence: the server's `requiredAction`, else the fact that opened the item, else the standing sentence. */
    fun requiredAction(row: JsonObject): String = row.text("requiredAction")?.takeIf { it.isNotBlank() }
        ?: row.text("detailLine")?.takeIf { it.isNotEmpty() } ?: requiredActionFallback

    /** One sentence per task filed as this item's fix, so a reader knows somebody is on it before weighing a press; null when none is. */
    fun handledByLine(row: JsonObject): String? = row.objects("handledBy").takeIf { it.isNotEmpty() }
        ?.joinToString(" · ") { "The coordinator is fixing this in ${it.text("title").orEmpty()}." }

    // MARK: the doors (mock 7, 方案 B)

    /** The three weights a press is drawn in: the step this kind of exception asks for, the other way to take it, and the quiet rest. */
    enum class PressTier { PRIMARY, SECONDARY, LINK }

    /** One press: the server's action, its weight, what it is called and the line under it saying what pressing it does. */
    data class CardPress(val action: String, val tier: PressTier, val label: String, val consequence: String)

    const val openTaskSession = "Open task session"
    /** The two landing doors (board v4 06, §4.6 X-E5): the way into the landing this item is about, and the press that ends a
     * timed-out attempt. */
    const val openLanding = "Open landing"
    const val abandon = "Abandon"
    /** RETRY's two names: a task's landing (or a failed task's run) again, and a merge candidate's check again. */
    const val retry = "Retry"
    const val rerunCheck = "Re-run the check"
    private val actionLabels = mapOf("REVIEW" to "Review", "ANSWER" to "Answer", "RESUME" to "Resume",
        "OPEN_COORDINATOR" to "Open coordinator", "OPEN_TASK_SESSION" to openTaskSession, "RETRY" to retry,
        "CANCEL_TASK" to "Cancel task", "ASK_COORDINATOR_AGAIN" to "Ask the coordinator again",
        "OPEN_LANDING" to openLanding, "ABANDON" to abandon)
    private val actionConsequences = mapOf(
        "REVIEW" to "Open the current merge card.",
        "ANSWER" to "Record your answer on the coordinator question.",
        "RESUME" to "The coordinator resumes and held work can continue.",
        "OPEN_COORDINATOR" to "Open the coordinator conversation.",
        "OPEN_TASK_SESSION" to "Open the task session to repair the branch.",
        "RETRY" to "A new integration attempt is queued with your reason.",
        "CANCEL_TASK" to "The task is cancelled and its open item closes.",
        "ASK_COORDINATOR_AGAIN" to "It goes back to the coordinator with a fresh escalation clock.",
        "OPEN_LANDING" to "Open the landing: every attempt, step by step.",
        "ABANDON" to "Ends this attempt. Nothing was pushed, and nothing is queued again.")
    const val promotionRetryConsequence = "The current candidate is checked again with your reason."
    const val taskRunAgainConsequence = "The task runs again and this item closes with it."
    /** J12's other half, for a claim Orbit cannot prove never pushed (a legacy claim, a v2 one that recorded a push, or a row that
     * predates the facts) — the browser's `ABANDON_MAY_HAVE_PUSHED`. */
    const val abandonMayHavePushed = "Ends this attempt. It may have been pushed, and nothing is queued again."
    /** J12's rule (contract §4.6 revision 23 E1): a `CHECK_PROMOTION` never pushes, and a v2 claim that never recorded a PUSH proves
     * none happened. A legacy claim reports only between steps, so its silence proves nothing — nor does a row without facts. */
    fun pushIsImpossible(lease: JsonObject?): Boolean =
        lease?.text("jobKind") == "CHECK_PROMOTION" || (lease?.text("progressProtocol") == "v2" && lease?.flag("pushReported") == false)
    /** The reason a RETRY carries when the row has no `requiredAction`: the door requires one. */
    const val retryReasonFallback = "Retry the integration after the failed check."
    const val markHandledConsequence = "Only if you dealt with it yourself. Your reason goes on the record."

    /** The doors a card may lead with; the rest only look or only stop, and are drawn quiet. */
    private val leadingActions = setOf("OPEN_TASK_SESSION", "RETRY", "ASK_COORDINATOR_AGAIN")
    /** The next step a kind asks for where the design names one; any other kind keeps the server's order. */
    private val kindNextStep = mapOf("INTEGRATION_CONFLICT" to "OPEN_TASK_SESSION", "INTEGRATION_CHECK_FAILED" to "OPEN_TASK_SESSION",
        "TASK_FAILED" to "RETRY")
    /** The kinds the owner closes by hand (the server's `HAND_CLOSABLE_RESOLUTIONS`); X-E5's silence is theirs to judge as dealt
     * with (§4.6). */
    private val handClosableKinds = setOf("INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR", "TASK_FAILED", "LANDING_LEASE_EXPIRED")

    /** What one door is called: a RETRY on a row that names a merge candidate re-runs that candidate's check. Null for a door the
     * browser has no label for, which is never drawn. */
    fun actionLabel(row: JsonObject, action: String): String? =
        if (action == "RETRY" && row.text("promotionId") != null) rerunCheck else actionLabels[action]

    /** The line under a door: for a RETRY, the candidate's re-check, a failed task's run again, or a landing queued again; for an
     * ABANDON, J12's verdict on whether a push can be ruled out. */
    fun actionConsequence(row: JsonObject, action: String): String {
        if (action == "RETRY") {
            if (row.text("promotionId") != null) return promotionRetryConsequence
            if (row.text("kind") == "TASK_FAILED") return taskRunAgainConsequence
        }
        if (action == "ABANDON") return if (pushIsImpossible(row.obj("lease"))) actionConsequences.getValue("ABANDON") else abandonMayHavePushed
        return actionConsequences[action].orEmpty()
    }

    /** What a RETRY press carries as its reason: the item's own sentence about what has to happen, trimmed, else the fallback. */
    fun retryReason(row: JsonObject): String = row.text("requiredAction")?.trim()?.takeIf { it.isNotEmpty() } ?: retryReasonFallback

    /**
     * Which of RETRY's three doors this row's press goes through (`open-item-doors.ts`): a failed task runs again (`task-start`,
     * `POST tasks/:id/execute`); a row that names a merge candidate re-runs that candidate's check (`integration-retry-promotion`,
     * `POST projects/:id/promotions/:promotionId/integration/retry`); any other row queues its task's landing again
     * (`integration-retry-task`, `POST projects/:id/tasks/:taskId/integration/retry`). Null when the row carries no address for it.
     */
    fun retryVerb(row: JsonObject): CardVerb? = when {
        row.text("kind") == "TASK_FAILED" -> if (row.text("taskId") != null) CardVerb.RETRY_TASK else null
        row.text("promotionId") != null -> CardVerb.RERUN_CHECK
        row.text("taskId") != null -> CardVerb.RETRY_INTEGRATION
        else -> null
    }

    /** Whether the row carries the address a press needs. [mergeCard] is the merge candidate whose card this conversation draws:
     * `Review` scrolls to that card, so it is drawn only where the card is. */
    fun addressed(row: JsonObject, action: String, mergeCard: String? = null): Boolean = when (action) {
        "ASK_COORDINATOR_AGAIN", "ANSWER", "RESUME" -> true
        "RETRY" -> row.text("taskId") != null || row.text("promotionId") != null
        "CANCEL_TASK" -> row.text("taskId") != null
        "REVIEW" -> row.text("promotionId") != null && row.text("promotionId") == mergeCard
        "OPEN_COORDINATOR" -> row.obj("delivery")?.text("sessionId") != null
        "OPEN_TASK_SESSION" -> row.text("sessionId") != null || row.text("taskId") != null
        // A reading door: the landing this item is about, which a row an older build opened names nowhere — then the door is not
        // drawn rather than pointed at nothing.
        "OPEN_LANDING" -> !row.text("landingSessionId").isNullOrEmpty()
        // The one job the item is about; a row that names none draws no Abandon.
        "ABANDON" -> !row.text("integrationJobId").isNullOrEmpty()
        else -> false
    }

    /** The doors a card draws: the server's own list, minus what this build cannot name and what the row carries no address for. */
    fun drawn(row: JsonObject, mergeCard: String? = null): List<String> =
        row.strings("actions").filter { actionLabel(row, it) != null && addressed(row, it, mergeCard) }

    /** The doors a card leads with, in order: the server's `primaryAction` when it lists it, else the step the kind asks for — or,
     * on an item that has become the owner's, the way back to the coordinator — then the same step taken another way. */
    fun leadingDoors(row: JsonObject, actions: List<String>): List<String> {
        // §4.6 X-E5 is escalated at birth with ABANDON as its lead: a server that sends no primaryAction (an older build) still
        // leads with the one press that ends the attempt, and with nothing else.
        if (row.text("kind") == "LANDING_LEASE_EXPIRED") {
            val ending = actions.filter { it == "ABANDON" }
            if (ending.isNotEmpty()) return ending + actions.filter { it != "ABANDON" }
        }
        row.text("primaryAction")?.takeIf { it in actions }?.let { primary -> return listOf(primary) + actions.filter { it != primary } }
        val leading = actions.filter { it in leadingActions }
        val next = if (row.text("assignee") == "OWNER") "ASK_COORDINATOR_AGAIN" else kindNextStep[row.text("kind")]
        if (next == null || next !in leading) return leading
        return listOf(next) + leading.filter { it != next }
    }

    /** The card's whole action row: the pair it leads with in their own order, then the rest of the server's list, quiet. */
    fun presses(row: JsonObject, mergeCard: String? = null): List<CardPress> {
        val actions = drawn(row, mergeCard)
        val leading = leadingDoors(row, actions)
        val primary = leading.firstOrNull()
        val secondary = leading.getOrNull(1)
        return (leading + actions.filter { it !in leading }).map { action ->
            CardPress(action, if (action == primary) PressTier.PRIMARY else if (action == secondary) PressTier.SECONDARY else PressTier.LINK,
                actionLabel(row, action) ?: action, actionConsequence(row, action))
        }
    }

    /** What the card draws: a pause's one Resume, prominent — a pause is a card of its own, not one of the three weights — and any
     * other item's [presses]. */
    fun cardPresses(row: JsonObject, mergeCard: String? = null): List<CardPress> =
        if (row.text("kind") != "FUSE_PAUSED") presses(row, mergeCard)
        else drawn(row).filter { it == "RESUME" }.map { CardPress(it, PressTier.PRIMARY, actionLabel(row, it) ?: it, actionConsequence(row, it)) }

    /** The request a door sends, where it is one: the card's verb for it, which the catalogue grants from the same row. Null for a
     * door that only looks — the two ways onto the work, and `Review`. */
    fun verb(row: JsonObject, action: String): CardVerb? = when (action) {
        "ASK_COORDINATOR_AGAIN" -> CardVerb.RETURN_COORDINATOR
        "RETRY" -> retryVerb(row)
        "CANCEL_TASK" -> CardVerb.CANCEL_TASK
        "RESUME" -> CardVerb.RESUME
        // OPEN_LANDING only looks (it opens a session), so it has no verb: the card opens it where it is pressed.
        "ABANDON" -> CardVerb.ABANDON
        else -> null
    }

    /** Where `Open task session` goes: the attempt that opened the item, else its task. */
    fun openTaskSessionLink(row: JsonObject): String? =
        row.text("sessionId")?.let { "orbit-session:$it" } ?: row.text("taskId")?.let { "orbit-task:$it" }

    // MARK: the owner's own ending

    const val markHandled = "Mark as handled"
    const val markHandledTitle = "Mark this item as handled?"
    const val markHandledBody = "It stops being something this project owes anyone. The reason is what the record gains, because nothing " +
        "on the line could verify the ending for itself — the task, its branch and its history stay where they are."
    const val markHandledReason = "Why is it no longer open?"
    /** The door's own ceiling (`MAX_OPEN_ITEM_RESOLUTION_NOTE`). */
    const val markHandledMaxLength = 2_000

    /** Whether the owner may close this item themselves: it is theirs, and its kind is one the door closes by hand. */
    fun markable(row: JsonObject): Boolean = row.text("assignee") == "OWNER" && row.text("kind") in handClosableKinds

    // What a refused press says, by the door it went through (the browser's headlines).
    const val notMarkedHandled = "The item was not closed"
    const val notRerunCheck = "The check was not re-run"
    const val notRetriedLanding = "The task integration was not retried"
    const val notRunAgain = "The task was not run again"
    const val notReturned = "That item was not sent back"
    const val notResumed = "The coordinator was not resumed"
    const val notAbandoned = "The attempt was not ended"

    /** The headline a refusal of [verb] is said under, ahead of the server's reason; null for a verb this card does not press. */
    fun refusalHeadline(verb: CardVerb): String? = when (verb) {
        CardVerb.MARK_HANDLED -> notMarkedHandled
        CardVerb.RERUN_CHECK -> notRerunCheck
        CardVerb.RETRY_INTEGRATION -> notRetriedLanding
        CardVerb.RETRY_TASK -> notRunAgain
        CardVerb.RETURN_COORDINATOR -> notReturned
        CardVerb.RESUME -> notResumed
        CardVerb.ABANDON -> notAbandoned
        else -> null
    }

    // MARK: the heading and the footer

    /** How the item became the owner's, one sentence per way; null for an item that was the owner's from the start. */
    fun heading(row: JsonObject, now: Instant = Instant.now()): String? {
        // §4.6 X-E5 (revision 23): the item is escalated at birth, so `waitedBeforeEscalation` would only ever say "1s". Its heading
        // is the fact it is about — how long the claim has been silent, counted from the last report the runner made (board v4 06).
        if (row.text("kind") == "LANDING_LEASE_EXPIRED") {
            val silent = leaseSilentMinutes(row)
            return if (silent == null) "Now yours — no report from the runner"
            else "Now yours — no report from the runner for ${silent}m"
        }
        return headingByReason(row, now)
    }

    private fun headingByReason(row: JsonObject, now: Instant): String? = when (row.text("assigneeReason")) {
        "ESCALATED" -> "Now yours — no one acted on this for ${waitedBeforeEscalation(row)}"
        "COORDINATOR_ENDED" -> "Now yours — the coordinator conversation ended"
        "CHAIN_LIMIT" -> "Now yours — the 3rd failure in this chain"
        "HANDED_OVER" -> "Now yours — the coordinator handed it over"
        "NO_COORDINATOR" -> "Now yours — this project has no coordinator (waiting ${waited(row, now)})"
        else -> null
    }

    /** The card's first line: how it became the owner's, or its own title. */
    fun headingLine(row: JsonObject, now: Instant = Instant.now()): String = heading(row, now) ?: row.text("title").orEmpty()

    /** What escalated, under a heading that is not the title; null when the heading is the title. */
    fun subject(row: JsonObject, now: Instant = Instant.now()): String? = if (heading(row, now) == null) null else row.text("title")

    /** The minutes the claim had been silent when the item was opened — the server's own count, off the two instants the row carries.
     * Nil when the row predates the facts. */
    fun leaseSilentMinutes(row: JsonObject): Int? {
        val lease = row.obj("lease") ?: return null
        val reported = lease.text("lastReportAt")?.let(::parse) ?: return null
        val opened = (row.text("escalatedAt") ?: row.text("waitingSince"))?.let(::parse) ?: return null
        return maxOf(1, Duration.between(reported, opened).seconds.toInt() / 60)
    }

    /** How long the coordinator had it before the clock took it away; "a while" when the read does not say. */
    fun waitedBeforeEscalation(row: JsonObject): String {
        val escalated = parse(row.text("escalatedAt")) ?: return "a while"
        val since = parse(row.text("waitingSince")) ?: return "a while"
        return span(Duration.between(since, escalated))
    }

    /** How long it has been waiting. */
    fun waited(row: JsonObject, now: Instant = Instant.now()): String =
        parse(row.text("waitingSince"))?.let { span(Duration.between(it, now)) } ?: "a while"

    const val ownerPrefix = "Owner: you"
    const val cameToOwnerAt = " · came to the owner at "

    /** "Owner: you · waiting 2h 10m", and when a clock moved it, how long the coordinator had it first. */
    fun ownerLine(row: JsonObject, now: Instant = Instant.now()): String {
        val waiting = "$ownerPrefix · waiting ${waited(row, now)}"
        // §4.6 X-E5 is escalated at birth: there is no window it waited the coordinator through, so the footer says the wait alone.
        if (row.text("kind") == "LANDING_LEASE_EXPIRED" || row.text("escalatedAt") == null) return waiting
        return waiting + cameToOwnerAt + waitedBeforeEscalation(row)
    }

    private fun span(duration: Duration) = BackgroundWakeCard.duration(duration.seconds)
    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    // MARK: the fact block (§7.5, mock 5)

    /** How one run of a fact's value is drawn: the card's prose, the machine's own words (mono), or a check's verdict (alert). */
    enum class Face { PLAIN, MONO, BAD }
    data class Run(val text: String, val face: Face = Face.PLAIN)

    /** One fact: a label, its value in the runs it is drawn in, and — on the Check row — the failed check's log, hung under it. */
    data class FactRow(val label: String, val runs: List<Run>, val logTail: CheckTail? = null) {
        constructor(label: String, value: String, mono: Boolean = false) : this(label, listOf(Run(value, if (mono) Face.MONO else Face.PLAIN)))
        val value: String get() = runs.joinToString("") { it.text }
    }

    /** What a failed check printed, folded from the end, where the reason it is red always is; its colour codes stripped. */
    data class CheckTail(val lines: List<String>, val hidden: Int) {
        val shown: List<String> get() = if (hidden == 0) lines else lines.takeLast(foldedLines)
        /** "Show 3 more lines", or null when every line is on screen. */
        val more: String? get() = if (hidden > 0) "Show $hidden more lines" else null

        companion object {
            const val foldedLines = 6
            const val less = "Show less"
            private val ansi = Regex("\u001B\\[[0-9;?]*[ -/]*[@-~]")

            /** The tail as the card draws it, or null when the check printed nothing. */
            fun of(outputTail: String?): CheckTail? {
                val cleaned = outputTail?.replace(ansi, "") ?: return null
                if (cleaned.isBlank()) return null
                val lines = cleaned.split("\n")
                return CheckTail(lines, maxOf(0, lines.size - foldedLines))
            }
        }
    }

    /** What the card draws for the item's facts: the payload's rows, or — for a row whose payload this build cannot read — the
     * server's own sentence, as the card drew it before the rows existed. */
    sealed interface Facts {
        data class DetailLine(val line: String) : Facts
        data class Rows(val rows: List<FactRow>) : Facts {
            /** The failed check's log, wherever its row is. */
            val logTail: CheckTail? get() = rows.firstNotNullOfOrNull { it.logTail }
        }
    }

    const val taskLabel = "Task"
    const val intoLabel = "Into"
    const val filesLabel = "Files"
    const val afterAFixLabel = "After a fix"
    // §4.6 X-E5's lease block (board v4 06 c): the claim the item is about, in three rows.
    const val landingFactLabel = "Landing"
    const val runnerFactLabel = "Runner"
    const val stepFactLabel = "Step"
    /** The landing line's phase words, which `ProjectPage.phaseWords` names too; a lease row wears the same ones. */
    private val phaseWords = mapOf("FETCH" to "fetching", "MAIN_SYNC" to "syncing main", "REBASE" to "rebasing", "MERGE" to "merging",
        "CHECK" to "checking", "VERIFY" to "verifying", "PUSH" to "pushing")
    const val generationWord = "generation"
    const val lastReportWord = "last report"
    const val leaseExpiredWord = "lease expired"
    const val theRunnerWord = "The runner"
    /** The most rounds one claim of a `LAND_TASK` can run: the M of "round N of M" (§7.2 V6) — the first round plus up to two refetches
     * when the push loses a race (contract J5, appendix A-Q5; runner-go `integrate.go` `integrationRefetchRounds + 1`). iOS
     * `ProjectPage.landTaskRoundsPerClaim`. Here because core is what this card and the app's landing head and page both reach. */
    const val landTaskRoundsPerClaim = 3
    const val checkLabel = "Check"
    const val branchLabel = "Branch"
    const val howLabel = "How"
    const val retriesLabel = "Retries"
    const val errorLabel = "Error"
    const val nothingLanded = " · nothing landed"
    const val afterAFix = "push to the task branch — Orbit re-integrates and re-checks on its own"
    const val branchUnchanged = "unchanged — the task passed on its own branch; it fails only on the combined tree"

    /** The rows of the item's payload, in the browser's order (`ItemFactRows`), field for field. X-E5 draws the claim it is about in
     * three rows instead of the item's sentence; an item an older build opened carries no lease and keeps that sentence. */
    fun facts(row: JsonObject): Facts {
        if (row.text("kind") == "LANDING_LEASE_EXPIRED") row.obj("lease")?.let { return Facts.Rows(leaseFacts(row, it)) }
        val facts = row.obj("facts") ?: return Facts.DetailLine(row.text("detailLine").orEmpty())
        val rows = mutableListOf<FactRow>()
        val task = facts.obj("task")
        task?.text("title")?.let { rows += FactRow(taskLabel, it) }
        facts.text("targetRef")?.let { ref ->
            var into = ref
            facts.text("targetSha")?.let { into += " at ${it.take(7)}" }
            if (facts.flag("nothingLanded")) into += nothingLanded
            rows += FactRow(intoLabel, into)
        }
        val files = facts.strings("files")
        if (files.isNotEmpty()) rows += FactRow(filesLabel, files.joinToString(" · "), mono = true)
        // Only where the item is about a task: the push this sentence describes is to that task's branch.
        if (task != null && files.isNotEmpty()) rows += FactRow(afterAFixLabel, afterAFix)
        facts.obj("check")?.let { check ->
            rows += FactRow(checkLabel, listOf(Run(check.text("command").orEmpty(), Face.MONO), Run(" · "), Run(checkVerdict(check), Face.BAD),
                Run(" after ${checkDuration((check["durationMs"] as? JsonPrimitive)?.doubleOrNull ?: 0.0)}")),
                CheckTail.of(check.text("outputTail")))
        }
        if (facts.flag("branchUnchanged")) rows += FactRow(branchLabel, branchUnchanged)
        facts.obj("failure")?.let { failure ->
            rows += FactRow(howLabel, howFailed(failure))
            chainStanding(failure)?.let { rows += FactRow(retriesLabel, it) }
        }
        facts.text("errorCode")?.let { rows += FactRow(errorLabel, it, mono = true) }
        return Facts.Rows(rows)
    }

    /** §4.6 X-E5's three rows: which landing on which runner and since when, and where the runner had got to (board v4 06 c). */
    private fun leaseFacts(row: JsonObject, lease: JsonObject): List<FactRow> {
        val rows = mutableListOf<FactRow>()
        val generation = lease.number("generation")?.let { "$generationWord $it" }
        val landing = listOfNotNull(row.obj("facts")?.obj("task")?.text("title"), generation).joinToString(" · ")
        if (landing.isNotEmpty()) rows += FactRow(landingFactLabel, landing)
        fun clock(at: String?): String? = parse(at)?.let { instant ->
            val time = instant.atZone(java.time.ZoneId.systemDefault())
            "%02d:%02d".format(time.hour, time.minute)
        }
        val runner = listOfNotNull(lease.text("runner") ?: theRunnerWord,
            lease.text("lastReportAt")?.let(::clock)?.let { "$lastReportWord $it" },
            lease.text("leaseExpiredAt")?.let(::clock)?.let { "$leaseExpiredWord $it" }).joinToString(" · ")
        if (runner.isNotEmpty()) rows += FactRow(runnerFactLabel, runner)
        // The M is the job kind's most rounds per claim (§7.2 V6), never `checkCount`: the two merge kinds have one round and name none.
        val round = lease.number("round")?.let { n -> "round $n" + (if (lease.text("jobKind") == "LAND_TASK") " of $landTaskRoundsPerClaim" else "") }
        // The step in the landing line's own words where the phase has one, else the server's step word (iOS `leaseFacts`).
        val step = listOfNotNull(lease.text("phase")?.let { phaseWords[it] } ?: lease.text("step"),
            lease.text("claimGeneration")?.let { "claim $it" }, round).joinToString(" · ")
        if (step.isNotEmpty()) rows += FactRow(stepFactLabel, step)
        return rows
    }

    /** How a check ended: the code it returned, or that its budget ran out. */
    fun checkVerdict(check: JsonObject): String = check.number("exitCode")?.let { "exit $it" }
        ?: if (check.flag("timedOut")) "timed out" else "no exit code"

    /** How long a check took, as the browser's `checkDuration` rounds it: "48s", "6m 12s", "1h 4m". */
    fun checkDuration(ms: Double): String {
        val seconds = maxOf(0L, (ms / 1_000).roundToLong())
        val h = seconds / 3_600; val m = (seconds % 3_600) / 60; val s = seconds % 60
        if (h > 0) return if (m > 0) "${h}h ${m}m" else "${h}h"
        if (m > 0) return if (s > 0) "${m}m ${s}s" else "${m}m"
        return "${s}s"
    }

    private val how = mapOf(
        "ACCEPTANCE_EXIT_MISMATCH" to "the acceptance command exited",
        "RUN_FAILED" to "a turn of the run failed",
        "RUNNER_FINALIZED_FAILED" to "the runner finished the run as failed",
        "REAPED_API_ERROR" to "the run stopped on an API or sign-in error and was reaped",
        "ATTEMPT_LOST_RUNNER_OFFLINE" to "its runner went offline and the attempt was taken back",
        "ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED" to "its runtime never started and the attempt was taken back",
        "REPORTED_FAILED" to "somebody filed it as failed")

    /** Why an attempt failed, in the browser's words, the same sentence whether or not it knows the reason. */
    fun howFailed(failure: JsonObject): String {
        val said = failure.text("how")?.let { how[it] } ?: "the task failed"
        val exitCode = failure.number("exitCode") ?: return said
        return "$said $exitCode (expected ${failure.number("expectedExitCode") ?: 0})"
    }

    /** Where the attempt's chain stands; null when the payload carries no counts. */
    fun chainStanding(failure: JsonObject): String? {
        val attempt = failure.number("attempt") ?: return null
        val limit = failure.number("limit") ?: return null
        val standing = "attempt $attempt of $limit in this chain"
        return if (attempt >= limit) "$standing — this one is the owner's" else "$standing — the ${ordinal(limit)} failure goes straight to the owner"
    }

    fun ordinal(n: Int): String {
        if (n % 100 in 11..13) return "${n}th"
        return when (n % 10) { 1 -> "${n}st"; 2 -> "${n}nd"; 3 -> "${n}rd"; else -> "${n}th" }
    }
}
