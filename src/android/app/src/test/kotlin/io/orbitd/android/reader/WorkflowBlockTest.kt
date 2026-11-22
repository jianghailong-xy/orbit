package io.orbitd.android.reader

import io.orbitd.android.core.cards.WorkflowFinished
import io.orbitd.android.core.cards.WorkflowFinishedRun
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.WorkflowBlock.CallState
import io.orbitd.android.reader.WorkflowFixture.WF
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * An Orbit workflow as Android draws it, case for case with OrbitKit's `WorkflowBlockTests` (board docs/mocks/subagent-workflow part 4):
 * the folded block's three lines, the calls page by phase, what moves the reads, and the finished strip of its wake turn.
 */
class WorkflowBlockTest {
    private val runs = WorkflowFixture.runs()
    private fun describe(workflow: WorkflowRun?, row: TranscriptRow = WorkflowFixture.row(), runs: Map<String, SubagentRun> = this.runs,
        background: Boolean = false) = WorkflowBlock.describe(row, workflow, { runs[it] }, background)

    // the folded block

    @Test fun theRunningBlockSaysPhaseCountAndCostThenRunningAndQueued() {
        val block = describe(WorkflowFixture.workflow())
        assertEquals("Workflow", WorkflowBlock.LABEL)
        assertEquals("Review the scheduler diff", block.title)
        assertEquals(WorkflowBlock.State.RUNNING, block.state)
        assertEquals("Verify · 7 of 12 · $0.84", block.progress)
        assertEquals("3 running, 2 queued", block.live)
        assertNull(block.error)
    }

    @Test fun theCostReadsAsOfTheLimitOnlyWhenTheCallSetOne() {
        assertEquals("Verify · 7 of 12 · $0.84 of $5.00", describe(WorkflowFixture.workflow(limit = 5.0)).progress)
    }

    @Test fun aFinishedBlockDropsThePhaseAndTheLiveLine() {
        val block = describe(WorkflowFixture.finishedWorkflow, WorkflowFixture.row(finished = true), WorkflowFixture.runs(finished = true))
        assertEquals(WorkflowBlock.State.DONE, block.state)
        assertEquals("12 of 12 · $1.37", block.progress)
        assertNull(block.live)
        assertFalse("a finished workflow folds no phase", block.sections.any { it.more != null })
    }

    @Test fun aWorkflowThatDidNotFinishSaysWhy() {
        val row = transcriptRows(WorkflowFixture.events().take(4)).single { it.event.seq == 3L }
        val block = describe(WorkflowFixture.workflow("FAILED", 0, 0, 0.0, error = "TypeError: args.routes is undefined (line 4)"), row,
            emptyMap())
        assertEquals(WorkflowBlock.State.FAILED, block.state)
        assertEquals("0 of 0 · $0.00", block.progress)
        assertEquals("TypeError: args.routes is undefined (line 4)", block.error)
    }

    @Test fun beforeTheServerIsReadTheBlockStillDrawsFromTheTranscript() {
        val block = describe(null, background = true)
        assertEquals(WorkflowBlock.State.RUNNING, block.state)
        assertEquals("the ended calls' spend, counted from their runs", "Verify · 7 of 12 · $0.35", block.progress)
        val named = transcriptRows(listOf(RunEvent("tool_use", 3, Wire.json.parseToJsonElement(
            """{"id":"$WF","name":"mcp__orbit__workflow","input":{"script":"export const meta = { name: 'review-changes' }"}}""")))).single()
        assertEquals("no description: the script's name", "review-changes", describe(null, named, emptyMap()).title)
    }

    // the calls page

    @Test fun theCallsPageGroupsByPhaseWithCountsAndFoldsAnEndedPhase() {
        val block = describe(WorkflowFixture.workflow())
        assertEquals(listOf("Review", "Verify"), block.sections.map { it.title })
        assertEquals(listOf("Review · 4 done", "Verify · 3 done · 3 running · 2 queued"), block.sections.map { it.header })
        val review = block.sections[0]
        assertEquals(2, review.shown)
        assertEquals("2 more", review.more)
        assertEquals("review:correctness", review.calls.first().label)
        assertEquals("2 findings", review.calls.first().result)
        val verify = block.sections[1]
        assertNull(verify.more)
        assertEquals(listOf(CallState.DONE, CallState.DONE, CallState.FAILED, CallState.RUNNING, CallState.RUNNING, CallState.RUNNING,
            CallState.QUEUED, CallState.QUEUED), verify.calls.map { it.state })
        assertNull("a running call has handed back nothing yet", verify.calls[3].result)
        assertEquals("a row opens its own delegate call's SubAgent block", "$WF#4", verify.calls[0].row.event.toolId())
    }

    @Test fun callsWithNoPhaseComeLastAndAPhaseNotInTheMetaFollowsTheMetasOrder() {
        fun call(i: Int, label: String, phase: String) = listOf(
            RunEvent("tool_use", 10L + 2 * i, buildJsonObject { put("id", "$WF#$i"); put("name", SubagentBlock.TOOL_NAME); put("parentToolUseId", WF)
                putJsonObject("input") { put("description", label); put("workflow_phase", phase) } }),
            RunEvent("tool_result", 11L + 2 * i, buildJsonObject { put("toolUseId", "$WF#$i"); put("parentToolUseId", WF); put("content", "{}") }))
        val events = WorkflowFixture.events().take(4) + call(0, "loose", "") + call(1, "extra", "Extra") + call(2, "verify", "Verify")
        val block = describe(WorkflowFixture.workflow("DONE"), transcriptRows(events).single { it.event.seq == 3L }, emptyMap())
        assertEquals(listOf("Verify", "Extra", null), block.sections.map { it.title })
        assertEquals("1 done", block.sections.last().header)
    }

    @Test fun aCallLeftQueuedWhenTheWorkflowEndedNeverRan() {
        val events = WorkflowFixture.events().take(4) + RunEvent("tool_use", 5, buildJsonObject { put("id", "$WF#0")
            put("name", SubagentBlock.TOOL_NAME); put("parentToolUseId", WF); putJsonObject("input") { put("workflow_phase", "Verify") } })
        val block = describe(WorkflowFixture.workflow("INTERRUPTED"), transcriptRows(events).single { it.event.seq == 3L }, emptyMap())
        assertEquals(WorkflowBlock.State.STOPPED, block.state)
        assertEquals(listOf(CallState.FAILED), block.calls.map { it.state })
    }

    @Test fun theServersWorkflowAndTheCallFieldsDecode() {
        val view = WorkflowRun.byCall(listOf(Wire.json.parseToJsonElement("""{"id":"w1","toolUseId":"$WF","name":"review-changes",
            "description":"Review","phases":["Review","Verify"],"status":"RUNNING","callsDone":6,"callsFailed":1,"costUsd":0.84,
            "maxCostUsd":null,"error":null,"createdAt":"2026-11-20T08:00:00.000Z","endedAt":null}""").jsonObject))
        assertEquals(WorkflowRun("w1", WF, "review-changes", "Review", listOf("Review", "Verify"), "RUNNING", 6, 1, 0.84, null, null,
            "2026-11-20T08:00:00.000Z", null), view[WF])
        val run = SubagentRun.from(Wire.json.parseToJsonElement("""{"toolUseId":"$WF#4","type":"general","background":false,
            "status":"DONE","costUsd":0.05,"createdAt":"2026-11-20T08:00:00.000Z","workflowRunId":"w1","callIndex":4,"label":"verify",
            "phase":"Verify"}""").jsonObject)!!
        assertEquals(listOf("w1", 4, "verify", "Verify"), listOf(run.workflowRunId, run.callIndex, run.label, run.phase))
    }

    // what moves it

    @Test fun theSignatureMovesWhenACallIsMadeOpensOrEnds() {
        val head = WorkflowFixture.events().take(4)
        fun call(ended: Boolean, opened: Boolean) = buildList {
            add(RunEvent("tool_use", 5, buildJsonObject { put("id", "$WF#0"); put("name", SubagentBlock.TOOL_NAME); put("parentToolUseId", WF) }))
            if (opened) add(RunEvent("assistant", 6, buildJsonObject { put("text", "hi"); put("parentToolUseId", "$WF#0") }))
            if (ended) add(RunEvent("tool_result", 7, buildJsonObject { put("toolUseId", "$WF#0"); put("parentToolUseId", WF); put("content", "{}") }))
        }
        assertEquals("a session with no workflow reads nothing", "", WorkflowRuns.signature(WorkflowFixture.events().take(2)))
        val made = WorkflowRuns.signature(head + call(ended = false, opened = false))
        val opened = WorkflowRuns.signature(head + call(ended = false, opened = true))
        val ended = WorkflowRuns.signature(head + call(ended = true, opened = true))
        assertEquals(3, setOf(made, opened, ended).size)
        assertTrue(made.isNotEmpty())
    }

    // the finished strip

    @Test fun theWakeBlockReadsAsOneRunAndIsItsOwnCard() {
        val parsed = WorkflowFinished.parse(WorkflowFixture.WAKE)!!
        assertEquals(listOf(WorkflowFinishedRun(WorkflowFixture.RUN_ID, "review-changes", "Review the scheduler diff", "DONE", 11, 1, 1.37)),
            parsed.runs)
        assertEquals("", parsed.rest)
        assertNull(WorkflowFinished.parse("<orbit-subagent-finished>\n  x\n</orbit-subagent-finished>"))
        assertNull(WorkflowFinished.parse("<orbit-workflow-finished>\n  not a head\n</orbit-workflow-finished>"))
        val wake = WorkflowFixture.events(finished = true).single { it.seq == 100L }
        assertEquals(listOf("record:100:workflow"), transcriptCards(wake).map { it.key })
    }

    @Test fun theStripSaysCallsFailedTimeAndCost() {
        val run = WorkflowFinished.parse(WorkflowFixture.WAKE)!!.runs.single()
        val server = WorkflowFixture.finishedWorkflow
        assertEquals(server, WorkflowFinishedStrip.workflow(run, listOf(server)))
        val strip = WorkflowFinishedStrip.describe(run, server)
        assertEquals("Workflow finished", strip.title)
        assertEquals("12 calls · 1 failed · 6m 40s · $1.37", strip.line)
        assertFalse(strip.failed)
        // Before the server's view is read, the block's own numbers, and no time.
        assertEquals("12 calls · 1 failed · $1.37", WorkflowFinishedStrip.describe(run, null).line)
    }

    @Test fun anInterruptedWorkflowsStripSaysSo() {
        val note = """<orbit-workflow-finished>
  Workflow audit (run 4wRun0000000000000002) finished: INTERRUPTED
  The runner process stopped before the workflow finished. What its SubAgents changed so far is in the working tree, uncommitted. A workflow cannot be resumed yet: start one for the work that is left, or finish it yourself.
    Calls done: 1, failed: 0. Cost: ${'$'}0.10.
  The control plane opened this turn for it.
</orbit-workflow-finished>"""
        val run = WorkflowFinished.parse(note)!!.runs.single()
        assertNull(run.description)
        val strip = WorkflowFinishedStrip.describe(run, null)
        assertEquals("Workflow interrupted", strip.title)
        assertEquals("1 call · $0.10", strip.line)
        assertTrue(strip.failed)
    }
}
