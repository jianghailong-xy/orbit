package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import java.time.Instant

// The task card opened from a task's own run conversation (docs/task-run-sidebar-design.md, the web column signed off
// 2026-11-27), as OrbitKit's TaskRunCard.swift writes its rules: the web column's blocks in its order — head with the reasoned
// status pill, the state block, Branch, Done means as a checklist, Runs, then Runs with and Activity on a line each. The pill's
// cause is the shared table's (src/shared/src/taskStatusReason.ts); TaskRunCardTest holds the words to both sources.

/** Why a task's run ended the way it did, as the status pill says it: `Failed · check exited 1`. */
sealed interface TaskStatusReason {
    val text: String
    data class CheckExited(val exitCode: Int) : TaskStatusReason { override val text get() = "check exited $exitCode" }
    data object RunStopped : TaskStatusReason { override val text = "run stopped" }
    data object RunInterrupted : TaskStatusReason { override val text = "run interrupted" }
    data object OverBudget : TaskStatusReason { override val text = "over budget" }
    data object RunnerLost : TaskStatusReason { override val text = "runner lost" }
    data object RunFailed : TaskStatusReason { override val text = "run failed" }

    companion object {
        /** What the runner reports for a command that returned no code of its own. */
        private const val NO_COMPARABLE_EXIT_CODE = -1
        private val acceptanceSentence = Regex("""^acceptance command exited (-?\d+); expected (-?\d+)$""")
        private val runnerLost = Regex("""\brunner (offline|lost)\b""", RegexOption.IGNORE_CASE)
        private val overBudget = Regex("""\b(over|exceeded (its|the)) budget\b|\bbudget exceeded\b""", RegexOption.IGNORE_CASE)

        /** Why this run failed, or null when nothing it carries names a cause (`taskFailureReason`): the acceptance rounds Orbit
         * ran, the session's error sentence, then how its last turn ended or why it was ended. */
        fun failure(run: JsonObject?): TaskStatusReason? {
            run ?: return null
            run.objects("acceptanceRounds").firstOrNull()?.let { newest ->
                val exit = newest.int("exitCode")
                if (exit != newest.int("expectedExitCode")) return CheckExited(exit ?: NO_COMPARABLE_EXIT_CODE)
            }
            val error = run.text("error")?.trim().orEmpty()
            acceptanceSentence.find(error)?.let { return CheckExited(it.groupValues[1].toInt()) }
            if (runnerLost.containsMatchIn(error)) return RunnerLost
            if (overBudget.containsMatchIn(error)) return OverBudget
            val endReason = run.text("endReason").orEmpty().lowercase()
            val outcome = run.text("lastTurnOutcome")
            if (outcome == "CANCELLED" || endReason == "cancelled" || endReason == "task_cancelled") return RunStopped
            if (outcome == "INTERRUPTED") return RunInterrupted
            if (error.isNotEmpty() || outcome == "FAILED") return RunFailed
            return null
        }
    }
}

/** The card's words, the web column's. */
object TaskRunCardCopy {
    const val KICKER = "Task"
    const val FAILED = "Failed"
    const val NEEDS_YOU = "Needs you"
    fun needsYouEvidence(revision: String) = "Needs you · evidence r$revision"
    fun soFar(cost: String) = "$cost so far"
    const val REVIEW_THE_EVIDENCE = "Review the evidence"
    const val ACCEPT = "Accept"
    const val SEND_BACK = "Send back"
    const val DELIVERED = "Delivered"
    fun evidenceAccepted(revision: String, time: String) = "Evidence r$revision accepted · $time"
    fun checkExited(code: Int, time: String) = "Check exited $code · $time"
    const val DONE = "Done"
    const val WHY_IT_FAILED = "Why it failed"
    fun round(exit: Int?, expected: Int, time: String) = "Acceptance check · exit ${exit?.toString() ?: "none"}, expected $expected · $time"
    const val OUTPUT = "Output"
    const val PRINTED_NOTHING = "It printed nothing."
    fun latestNote(author: String, day: String) = "Latest note ($author, $day): "
    const val READ = "Read"
    const val SHOW_LESS = "Show less"
    const val RERUN_THE_CHECK = "Re-run the check"
    const val RETRY_THE_TASK = "Retry the task"
    const val CLOSE_AS_NOT_NEEDED = "Close as not needed"
    const val BRANCH = "Branch"
    fun versus(main: String) = "vs $main"
    fun inMain(main: String) = "In $main"
    fun ahead(count: Int) = "$count ahead"
    const val LEFT = "Left"
    fun more(count: Int) = "$count more"
    const val LANDING = "Landing"
    fun mergedInto(target: String) = "Merged into $target"
    const val NOT_LANDED = "Not landed"
    const val AFTER_YOU_ACCEPT = "After you accept"
    const val AFTER_ITS_DONE = "After it's done"
    const val DONE_MEANS = "Done means"
    const val CRITERIA_TEXT_BRIEF = "Criteria text · Brief"
    const val SHOW = "Show"
    const val HIDE = "Hide"
    const val RUNS = "Runs"
    fun run(number: Int) = "Run $number"
    const val THIS_CONVERSATION = "this conversation"
    const val EDIT = "Edit"
    fun activity(count: Int) = "Activity · $count"
    fun filedFrom(title: String) = " · Filed from $title"
    const val UNTITLED_SESSION = "Untitled session"
}

/** Which state block the card draws first (`compactTaskState`). */
enum class TaskRunCardState { FAILED, RUNNING, NEEDS_YOU, DONE }

/** The card's blocks, top to bottom, as the web column draws them. */
enum class TaskRunCardBlock { HEAD, STATE, BRANCH, DONE_MEANS, RUNS, RUNS_WITH, ACTIVITY }

/** One row of Done means: ✓ passed, ✕ failed, ○ not settled yet. */
data class TaskDoneMeansRow(val key: String, val text: String, val code: Boolean, val mark: Mark) {
    enum class Mark(val glyph: String) { PASSED("✓"), FAILED("✕"), PENDING("○") }
}

private fun JsonObject.int(key: String) = (this[key] as? JsonPrimitive)?.intOrNull

object TaskRunCardLogic {
    /** The state block: a settled task first, then one waiting on the owner, then one with a run going. */
    fun state(status: String?, needsYou: Boolean, running: Boolean): TaskRunCardState? = when {
        status == "DONE" -> TaskRunCardState.DONE
        status == "FAILED" -> TaskRunCardState.FAILED
        needsYou -> TaskRunCardState.NEEDS_YOU
        running -> TaskRunCardState.RUNNING
        else -> null
    }

    /** The blocks the card draws, in the web column's order; a block with nothing to say is left out. */
    fun blocks(state: TaskRunCardState?, hasBranch: Boolean, hasRuns: Boolean): List<TaskRunCardBlock> = buildList {
        add(TaskRunCardBlock.HEAD)
        if (state != null) add(TaskRunCardBlock.STATE)
        if (hasBranch) add(TaskRunCardBlock.BRANCH)
        add(TaskRunCardBlock.DONE_MEANS)
        if (hasRuns) add(TaskRunCardBlock.RUNS)
        add(TaskRunCardBlock.RUNS_WITH)
        add(TaskRunCardBlock.ACTIVITY)
    }

    /** The run whose conversation the task page was opened over (`from`, the frame under it), when it is one of the task's
     * runs. Null anywhere else — the Tasks list, a project, another conversation — where the full page is drawn. */
    fun hereRun(task: JsonObject, from: String?): JsonObject? =
        from?.let { id -> task.objects("sessions").firstOrNull { ObjectId.same(it.text("id"), id) } }

    /** The status pill, carrying its reason: `Failed · check exited 1`, `Needs you · evidence r1`, or the page's own pill.
     * Needs you draws amber, a queued pill's colour. */
    fun pill(task: JsonObject, state: TaskRunCardState?, run: JsonObject?, evidenceRevision: String?, now: Instant = Instant.now()): TaskPill =
        when (state) {
            TaskRunCardState.FAILED -> TaskPill(PillKind.FAILED,
                listOfNotNull(TaskRunCardCopy.FAILED, TaskStatusReason.failure(run)?.text).joinToString(" · "))
            TaskRunCardState.NEEDS_YOU -> TaskPill(PillKind.QUEUED, evidenceRevision?.let(TaskRunCardCopy::needsYouEvidence) ?: TaskRunCardCopy.NEEDS_YOU)
            else -> TaskDetailLogic.headPill(task, now)
        }

    /** The line beside the pill: what the run going now has cost, or the run's date and the task's cost. */
    fun meta(task: JsonObject, state: TaskRunCardState?, run: JsonObject?, day: (String?) -> String?): String? {
        if (state == TaskRunCardState.RUNNING) {
            return TaskDetailLogic.costLabel(TaskDetailLogic.liveRun(task)?.let { TaskDetailLogic.runCost(it) })?.let(TaskRunCardCopy::soFar)
        }
        return listOfNotNull(run?.let { day(it.text("createdAt")) }, TaskDetailLogic.totalCost(task)).takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** The round that judges the command row: this run's newest, else the newest any run ran. */
    fun newestRound(task: JsonObject, run: JsonObject?): JsonObject? =
        run?.objects("acceptanceRounds")?.firstOrNull()
            ?: task.objects("sessions").flatMap { it.objects("acceptanceRounds") }.maxByOrNull { it.text("finishedAt").orEmpty() }

    fun roundPassed(round: JsonObject): Boolean = round.int("exitCode") == round.int("expectedExitCode")
    fun roundExit(round: JsonObject): Int? = round.int("exitCode")
    fun roundExpected(round: JsonObject): Int = round.int("expectedExitCode") ?: 0

    private val bullet = Regex("""^([-*•]|\d+[.)])\s+""")

    /** Done means as a checklist (`doneMeansChecklist`): the acceptance command, judged by the newest round Orbit ran, then each
     * criterion of the text, ticked once the task is accepted. A line is never crossed out on its own. */
    fun doneMeans(criteria: String?, command: String?, round: JsonObject?, status: String?, evidenceDecision: String?): List<TaskDoneMeansRow> {
        val rows = mutableListOf<TaskDoneMeansRow>()
        if (!command.isNullOrEmpty()) {
            val mark = when {
                round == null -> TaskDoneMeansRow.Mark.PENDING
                roundPassed(round) -> TaskDoneMeansRow.Mark.PASSED
                else -> TaskDoneMeansRow.Mark.FAILED
            }
            rows += TaskDoneMeansRow("command", command, true, mark)
        }
        val settled = status == "DONE" || evidenceDecision == "CONFIRM"
        val text = criteria?.trim().orEmpty()
        val items = text.split("\n").map { it.trim() }.filter { bullet.containsMatchIn(it) }
        val lines = when {
            items.isNotEmpty() -> items.map { it.replace(bullet, "") }
            text.isNotEmpty() -> listOf(text.replace(Regex("""\s+"""), " "))
            else -> emptyList()
        }
        lines.forEachIndexed { i, line ->
            rows += TaskDoneMeansRow("criterion-$i", line, false, if (settled) TaskDoneMeansRow.Mark.PASSED else TaskDoneMeansRow.Mark.PENDING)
        }
        return rows
    }

    /** The Branch block's Landing line: the landing's own badge, a merge the conversation made, or what landing waits on. */
    fun landingLine(landing: String?, mergeStatus: String?, mergeTarget: String?, main: String, state: TaskRunCardState?): String = when {
        landing != null -> landing
        mergeStatus == "merged" -> TaskRunCardCopy.mergedInto(mergeTarget ?: main)
        state == TaskRunCardState.DONE || state == TaskRunCardState.FAILED -> TaskRunCardCopy.NOT_LANDED
        state == TaskRunCardState.NEEDS_YOU -> TaskRunCardCopy.AFTER_YOU_ACCEPT
        else -> TaskRunCardCopy.AFTER_ITS_DONE
    }

    /** The first line of a comment, for the Why it failed note. */
    fun firstLine(body: String): String = body.split("\n").map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()

    /** The Activity line: how many entries, and the conversation the task was filed from. */
    fun activityLine(count: Int, filedFrom: JsonObject?): String =
        TaskRunCardCopy.activity(count) + (filedFrom?.let { TaskRunCardCopy.filedFrom(it.text("title")?.takeIf(String::isNotEmpty) ?: TaskRunCardCopy.UNTITLED_SESSION) } ?: "")
}
