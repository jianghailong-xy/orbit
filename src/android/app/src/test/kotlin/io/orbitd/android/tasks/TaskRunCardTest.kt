package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The task card in a task's own run conversation (docs/task-run-sidebar-design.md), case for case OrbitKit's
 * `TaskRunCardTests`, and its words against the shared reason table and the iPhone's copy. */
class TaskRunCardTest {
    private fun json(text: String) = Json.parseToJsonElement(text) as JsonObject
    private fun said(text: String) = TaskStatusReason.failure(json(text))?.text

    // MARK: the shared reason table

    @Test fun itNamesTheNewestAcceptanceRoundThatDisagreedWithItsCode() {
        assertEquals("check exited 1", said("""{"id":"S","acceptanceRounds":[
          {"id":"r2","turnId":"t2","exitCode":1,"expectedExitCode":0,"finishedAt":"2026-11-26T06:53:00.000Z"},
          {"id":"r1","turnId":"t1","exitCode":0,"expectedExitCode":0,"finishedAt":"2026-11-26T06:00:00.000Z"}]}"""))
        assertEquals("check exited -1", said("""{"id":"S","acceptanceRounds":[{"id":"r","turnId":"t","exitCode":null,"expectedExitCode":0,"finishedAt":"x"}]}"""))
    }

    @Test fun itReadsTheApiserverSentenceWhenNoRoundIsListed() {
        assertEquals("check exited 2", said("""{"id":"S","error":"acceptance command exited 2; expected 0"}"""))
    }

    @Test fun itNamesALostRunnerABudgetAStopAndAnInterruption() {
        assertEquals("runner lost", said("""{"id":"S","error":"runner offline"}"""))
        assertEquals("over budget", said("""{"id":"S","error":"the run went over budget"}"""))
        assertEquals("run stopped", said("""{"id":"S","endReason":"cancelled"}"""))
        assertEquals("run stopped", said("""{"id":"S","lastTurnOutcome":"CANCELLED"}"""))
        assertEquals("run interrupted", said("""{"id":"S","lastTurnOutcome":"INTERRUPTED"}"""))
    }

    @Test fun itFallsBackToRunFailedAndSaysNothingWithoutACause() {
        assertEquals("run failed", said("""{"id":"S","error":"engine crashed"}"""))
        assertEquals("run failed", said("""{"id":"S","lastTurnOutcome":"FAILED"}"""))
        assertNull(said("""{"id":"S","lastTurnOutcome":"ANSWERED",
          "acceptanceRounds":[{"id":"r","turnId":"t","exitCode":0,"expectedExitCode":0,"finishedAt":"x"}]}"""))
        assertNull(TaskStatusReason.failure(null))
    }

    // MARK: the card's blocks

    @Test fun theBlocksAreTheWebColumnsInItsOrder() {
        assertEquals(listOf(TaskRunCardBlock.HEAD, TaskRunCardBlock.STATE, TaskRunCardBlock.BRANCH, TaskRunCardBlock.DONE_MEANS,
            TaskRunCardBlock.RUNS, TaskRunCardBlock.RUNS_WITH, TaskRunCardBlock.ACTIVITY),
            TaskRunCardLogic.blocks(TaskRunCardState.FAILED, hasBranch = true, hasRuns = true))
        assertEquals(listOf(TaskRunCardBlock.HEAD, TaskRunCardBlock.DONE_MEANS, TaskRunCardBlock.RUNS_WITH, TaskRunCardBlock.ACTIVITY),
            TaskRunCardLogic.blocks(null, hasBranch = false, hasRuns = false))
    }

    @Test fun theStateBlockIsTheSettledOneFirst() {
        assertEquals(TaskRunCardState.DONE, TaskRunCardLogic.state("DONE", needsYou = true, running = true))
        assertEquals(TaskRunCardState.FAILED, TaskRunCardLogic.state("FAILED", needsYou = false, running = true))
        assertEquals(TaskRunCardState.NEEDS_YOU, TaskRunCardLogic.state("IN_PROGRESS", needsYou = true, running = true))
        assertEquals(TaskRunCardState.RUNNING, TaskRunCardLogic.state("IN_PROGRESS", needsYou = false, running = true))
        assertNull(TaskRunCardLogic.state("OPEN", needsYou = false, running = false))
    }

    @Test fun theCardIsDrawnOnlyOverOneOfTheTasksOwnRuns() {
        val task = json("""{"id":"T","title":"t","status":"FAILED","sessions":[{"id":"S2"},{"id":"S1"}]}""")
        assertEquals("S1", TaskRunCardLogic.hereRun(task, "S1")?.text("id"))
        assertNull("a link in another conversation opens the full page", TaskRunCardLogic.hereRun(task, "OTHER"))
        assertNull("so does the Tasks list", TaskRunCardLogic.hereRun(task, null))
    }

    @Test fun thePillCarriesItsReason() {
        val failed = json("""{"id":"T","title":"t","status":"FAILED","sessions":[
          {"id":"S","createdAt":"2026-11-25T14:41:00.000Z","costUsd":1.32,"error":"acceptance command exited 1; expected 0"}]}""")
        val here = failed.objects("sessions").first()
        assertEquals(TaskPill(PillKind.FAILED, "Failed · check exited 1"), TaskRunCardLogic.pill(failed, TaskRunCardState.FAILED, here, null))
        assertEquals("Needs you · evidence r1", TaskRunCardLogic.pill(failed, TaskRunCardState.NEEDS_YOU, here, "1").label)
        assertEquals("Needs you", TaskRunCardLogic.pill(failed, TaskRunCardState.NEEDS_YOU, here, null).label)
        assertEquals("Nov 25 · $1.32", TaskRunCardLogic.meta(failed, TaskRunCardState.FAILED, here) { if (it == null) null else "Nov 25" })
        val running = json("""{"id":"T","title":"t","status":"IN_PROGRESS","sessions":[{"id":"S","status":"RUNNING","costUsd":0.84}]}""")
        assertEquals("$0.84 so far", TaskRunCardLogic.meta(running, TaskRunCardState.RUNNING, running.objects("sessions").first()) { "x" })
    }

    @Test fun doneMeansIsAChecklistJudgedByTheNewestRound() {
        val round = json("""{"id":"r","turnId":"t","exitCode":1,"expectedExitCode":0,"finishedAt":"x"}""")
        val rows = TaskRunCardLogic.doneMeans("- `npm test` passes\n- Full suite, 0 failed", "npm test", round, "FAILED", null)
        assertEquals(listOf("npm test", "`npm test` passes", "Full suite, 0 failed"), rows.map { it.text })
        assertEquals(listOf("✕", "○", "○"), rows.map { it.mark.glyph })
        assertTrue(rows.first().code)
        val accepted = TaskRunCardLogic.doneMeans("Upload retries\n3× on 5xx", null, null, "IN_PROGRESS", "CONFIRM")
        assertEquals(listOf("Upload retries 3× on 5xx"), accepted.map { it.text })
        assertEquals(listOf(TaskDoneMeansRow.Mark.PASSED), accepted.map { it.mark })
        assertEquals(listOf(TaskDoneMeansRow.Mark.PENDING), TaskRunCardLogic.doneMeans(null, "make", null, "OPEN", null).map { it.mark })
    }

    @Test fun theLandingLineSaysWhatLandingWaitsOn() {
        assertEquals("Landed on main · 7c41e9", TaskRunCardLogic.landingLine("Landed on main · 7c41e9", null, null, "main", TaskRunCardState.DONE))
        assertEquals("Merged into main", TaskRunCardLogic.landingLine(null, "merged", null, "main", TaskRunCardState.DONE))
        assertEquals("Not landed", TaskRunCardLogic.landingLine(null, null, null, "main", TaskRunCardState.FAILED))
        assertEquals("After you accept", TaskRunCardLogic.landingLine(null, null, null, "main", TaskRunCardState.NEEDS_YOU))
        assertEquals("After it's done", TaskRunCardLogic.landingLine(null, null, null, "main", TaskRunCardState.RUNNING))
    }

    @Test fun theNoteAndTheActivityLine() {
        assertEquals("Machine load, not the code.", TaskRunCardLogic.firstLine("\n  Machine load, not the code.\nMore."))
        assertEquals("Activity · 4 · Filed from Polish the header share button",
            TaskRunCardLogic.activityLine(4, json("""{"id":"C","title":"Polish the header share button"}""")))
        assertEquals("Activity · 2", TaskRunCardLogic.activityLine(2, null))
    }

    // MARK: the words

    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/shared/src/taskStatusReason.ts").isFile }

    @Test fun theReasonsAreTheSharedTables() {
        val table = File(root, "src/shared/src/taskStatusReason.ts").readText().replace(Regex("""\s+"""), " ")
        assertTrue(table.contains("CHECK_EXITED: (exitCode: number) => `check exited \${exitCode}`"))
        listOf("RUN_STOPPED" to TaskStatusReason.RunStopped, "RUN_INTERRUPTED" to TaskStatusReason.RunInterrupted,
            "OVER_BUDGET" to TaskStatusReason.OverBudget, "RUNNER_LOST" to TaskStatusReason.RunnerLost,
            "RUN_FAILED" to TaskStatusReason.RunFailed).forEach { (key, reason) ->
            assertTrue("$key says ${reason.text} on the web too", table.contains("$key: '${reason.text}'"))
        }
    }

    /** Every word of the card is the iPhone's: each constant here is a `TaskRunCardCopy` line of OrbitKit's. */
    @Test fun theWordsAreTheIphones() {
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/TaskRunCard.swift").readText()
        listOf(TaskRunCardCopy.KICKER, TaskRunCardCopy.FAILED, TaskRunCardCopy.NEEDS_YOU, TaskRunCardCopy.REVIEW_THE_EVIDENCE,
            TaskRunCardCopy.ACCEPT, TaskRunCardCopy.SEND_BACK, TaskRunCardCopy.DELIVERED, TaskRunCardCopy.DONE, TaskRunCardCopy.WHY_IT_FAILED,
            TaskRunCardCopy.OUTPUT, TaskRunCardCopy.PRINTED_NOTHING, TaskRunCardCopy.READ, TaskRunCardCopy.SHOW_LESS,
            TaskRunCardCopy.RERUN_THE_CHECK, TaskRunCardCopy.RETRY_THE_TASK, TaskRunCardCopy.CLOSE_AS_NOT_NEEDED, TaskRunCardCopy.BRANCH,
            TaskRunCardCopy.LEFT, TaskRunCardCopy.LANDING, TaskRunCardCopy.NOT_LANDED, TaskRunCardCopy.AFTER_YOU_ACCEPT,
            TaskRunCardCopy.AFTER_ITS_DONE, TaskRunCardCopy.DONE_MEANS, TaskRunCardCopy.CRITERIA_TEXT_BRIEF, TaskRunCardCopy.SHOW,
            TaskRunCardCopy.HIDE, TaskRunCardCopy.RUNS, TaskRunCardCopy.THIS_CONVERSATION, TaskRunCardCopy.EDIT, TaskRunCardCopy.UNTITLED_SESSION,
        ).forEach { assertTrue("the iPhone says $it", swift.contains("= \"$it\"")) }
        listOf(TaskRunCardCopy.needsYouEvidence("\\(revision)"), TaskRunCardCopy.soFar("\\(cost)"),
            TaskRunCardCopy.evidenceAccepted("\\(revision)", "\\(time)"), TaskRunCardCopy.latestNote("\\(author)", "\\(day)"),
            TaskRunCardCopy.versus("\\(main)"), TaskRunCardCopy.inMain("\\(main)"), TaskRunCardCopy.mergedInto("\\(target)"),
            TaskRunCardCopy.filedFrom("\\(title)"),
        ).forEach { assertTrue("the iPhone writes $it", swift.contains("\"$it\"")) }
    }
}
