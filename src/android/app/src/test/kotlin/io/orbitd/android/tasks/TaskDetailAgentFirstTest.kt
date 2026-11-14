package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The rules of the task page led by the run (docs/mocks/task-detail-agent-first, boards 04–05), case for case
 * OrbitKit's `TaskDetailAgentFirstTests`. */
class TaskDetailAgentFirstTest {
    private fun json(text: String) = Json.parseToJsonElement(text) as JsonObject
    private fun rows(text: String) = (Json.parseToJsonElement(text) as JsonArray).map { it as JsonObject }
    private val now = Instant.parse("2026-11-12T10:54:00.000Z")

    @Test fun itSaysHowLongAndHowMuch() {
        assertEquals("<1m", TaskDetailLogic.elapsedLabel("2026-11-12T10:53:30.000Z", now))
        assertEquals("7m", TaskDetailLogic.elapsedLabel("2026-11-12T10:47:00.000Z", now))
        assertEquals("1h 12m", TaskDetailLogic.elapsedLabel("2026-11-12T09:42:00.000Z", now))
        assertEquals("2h", TaskDetailLogic.elapsedLabel("2026-11-12T08:54:00.000Z", now))
        assertNull(TaskDetailLogic.elapsedLabel(null, now))
        assertNull(TaskDetailLogic.costLabel(0.0))
        assertNull(TaskDetailLogic.costLabel(null))
        assertEquals("<$0.01", TaskDetailLogic.costLabel(0.004))
        assertEquals("$3.13", TaskDetailLogic.costLabel(3.125))
    }

    @Test fun oneStatusReadsRunningWithItsTimeAndTheRunsCost() {
        val running = json("""{"id":"T","title":"t","status":"OPEN","sessions":[
          {"id":"S","status":"RUNNING","createdAt":"2026-11-12T09:42:00.000Z","costUsd":0.84,"model":"claude-opus-5-5"},
          {"id":"R","status":"SUCCEEDED","createdAt":"2026-11-11T09:42:00.000Z","costUsd":2.16}]}""")
        assertEquals(TaskPill(PillKind.RUNNING, "Running · 1h 12m"), TaskDetailLogic.headPill(running, now))
        assertEquals("$3.00", TaskDetailLogic.totalCost(running))
        assertEquals("S", TaskDetailLogic.liveRun(running)?.text("id"))
        assertEquals("W", TaskDetailLogic.runRecipient(json("""{"id":"T","title":"t","status":"OPEN","assignee":{"id":"W"},"sessions":[{"id":"S","status":"RUNNING"}]}""")))
        val idle = json("""{"id":"T","title":"t","status":"DONE","assignee":{"id":"W"},"sessions":[{"id":"S","status":"SUCCEEDED"}]}""")
        assertEquals("Done", TaskDetailLogic.headPill(idle, now).label)
        assertNull(TaskDetailLogic.liveRun(idle))
        assertNull("no run going: an ordinary comment", TaskDetailLogic.runRecipient(idle))
        assertNull("a server without costUsd prints none", TaskDetailLogic.totalCost(idle))
    }

    @Test fun theCommentToTheRunMentionsItsWorkspaceOnce() {
        assertEquals(listOf("A", "W"), TaskDetailLogic.mentions(listOf("A"), "W"))
        assertEquals(listOf("W"), TaskDetailLogic.mentions(listOf("W"), "W"))
        assertEquals(listOf("A"), TaskDetailLogic.mentions(listOf("A"), null))
    }

    @Test fun nowReadsTheReportedPosition() {
        val reported = json("""{"id":"T","title":"t","status":"OPEN","progress":{"revision":3,"phase":"One manager per host","current":3,
         "total":5,"message":"Editing manager.service.ts","lastProgressAt":"2026-11-12T10:50:00.000Z"}}""")
        val progress = TaskDetailLogic.progress(reported)!!
        assertEquals("Step 3 of 5", TaskDetailLogic.progressStep(progress))
        assertEquals(0.6f, TaskDetailLogic.progressFraction(progress)!!, 0.0001f)
        assertEquals("Step 2", TaskDetailLogic.progressStep(json("""{"current":2,"revision":1}""")))
        assertNull(TaskDetailLogic.progressFraction(json("""{"current":2,"revision":1}""")))
        assertNull("a task that never reported", TaskDetailLogic.progress(json("""{"id":"T","status":"OPEN","progress":{"revision":0}}""")))
        assertNull("an older server", TaskDetailLogic.progress(json("""{"id":"T","status":"OPEN"}""")))
        assertNull(TaskDetailLogic.progress(json("""{"id":"T","status":"OPEN","progress":{"revision":"x"}}""")))
    }

    @Test fun deliveredSaysWhatTheEvidenceIsAndWhoDecidedIt() {
        val rows = rows("""[{"revision":"1","submittedAt":"2026-11-12T10:20:00.000Z","evidence":{"claim":"old"},
          "decision":{"decision":"SEND_BACK","note":"Show the tests","decidedAt":"2026-11-12T10:25:00.000Z","decidedByType":"AGENT"}},
         {"revision":"2","submittedAt":"2026-11-12T10:28:00.000Z",
          "evidence":{"claim":"Refuses peers outside allowPeers.","gaps":[],"checks":[
            {"kind":"TOOL_CALL","ref":"toolu_1","command":"python3 -m unittest","succeeded":true},
            {"kind":"COMMIT","ref":"7c41e9a0123456"},{"kind":"FILE","ref":"report.json"},{"kind":"TOOL_CALL","ref":"toolu_2"}]},
          "decision":{"decision":"CONFIRM","decidedAt":"2026-11-12T10:31:00.000Z","decidedByType":"USER"}},
         {"revision":3,"evidence":"not an object"}]""")
        assertEquals("a number or a bad envelope still reads", listOf("1", "2", "3"), rows.map(::evidenceRevision))
        val at: (String?) -> String = { "Nov 12, 10:31 AM" }
        assertEquals("Sent back", TaskDetailLogic.evidenceOutcome(rows[0]).first)
        assertEquals("Accepted", TaskDetailLogic.evidenceOutcome(rows[1]).first)
        assertEquals("Awaiting a decision", TaskDetailLogic.evidenceOutcome(rows[2]).first)
        assertEquals("Evidence r2 · accepted by you · Nov 12, 10:31 AM", TaskDetailLogic.evidenceMeta(rows[1], at))
        assertEquals("Evidence r1 · sent back by a reviewing agent · Nov 12, 10:31 AM", TaskDetailLogic.evidenceMeta(rows[0], at))
        assertEquals("Evidence r3 · submitted Nov 12, 10:31 AM", TaskDetailLogic.evidenceMeta(rows[2], at))
        assertEquals(listOf("python3 -m unittest", "Commit 7c41e9a01", "File report.json", "Tool call toolu_2"),
            rows[1].obj("evidence")!!.objects("checks").map { TaskDetailLogic.evidenceCheckText(it) })
    }

    @Test fun thePlanIsOneSentence() {
        assertEquals("Nothing blocks this task.", TaskDetailLogic.planSentence(json("""{"id":"T","title":"t","status":"OPEN"}""")))
        assertEquals("Its prerequisite is done. “Channel-host kit” waits on it.", TaskDetailLogic.planSentence(json("""
        {"id":"T","title":"t","status":"OPEN","dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"DONE"}}],
         "dependedOnBy":[{"task":{"id":"B","title":"Channel-host kit","status":"OPEN"}}]}""")))
        // Blocked: the notice above it already says so; only what waits on it is added.
        assertEquals("“A” and 1 more wait on it.", TaskDetailLogic.planSentence(json("""
        {"id":"T","title":"t","status":"OPEN","dependencyState":"BLOCKED",
         "dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"OPEN"}}],
         "dependedOnBy":[{"task":{"id":"B","title":"A","status":"OPEN"}},{"task":{"id":"C","title":"B","status":"OPEN"}},
                         {"task":{"id":"D","title":"C","status":"DONE"}}]}""")))
    }

    @Test fun attributionShowsOnlyWhenItSaysSomethingNew() {
        val quiet = json("""{"taskId":"T","owning":{"projectId":"P","title":"p","status":"OPEN"},"owningAbsentReason":null,
         "discovery":{"recorded":false,"authority":"EVIDENCE_ONLY","absentReason":"NO_DISCOVERY_RECORDED"},
         "crossing":null,"crossingAbsentReason":"NO_CROSSING_DECLARED","blocker":null,"blockerAbsentReason":"NOTHING_BLOCKING_ATTRIBUTION"}""")
        assertFalse("the header's project again", TaskDetailLogic.attributionNeedsCard(quiet, "P"))
        assertTrue("counted somewhere else", TaskDetailLogic.attributionNeedsCard(quiet, "Q"))
    }

    @Test fun theTimelineIsOldestFirst() {
        val filed = json("""{"id":"T","title":"t","status":"DONE","createdAt":"2026-11-12T09:35:00.000Z",
         "sessions":[{"id":"S","status":"SUCCEEDED","createdAt":"2026-11-12T09:42:00.000Z"},
                     {"id":"X","status":"FAILED","createdAt":"2026-11-12T09:40:00.000Z","deletedAt":"2026-11-12T09:41:00.000Z"}],
         "comments":[{"id":"C","body":"Looks right","createdAt":"2026-11-12T10:40:00.000Z"}]}""")
        val evidence = rows("""[{"revision":"1","submittedAt":"2026-11-12T10:28:00.000Z",
          "decision":{"decision":"CONFIRM","decidedAt":"2026-11-12T10:31:00.000Z","decidedByType":"AGENT"}}]""")
        val items = TaskDetailLogic.activity(filed, evidence)
        assertEquals("oldest first, and a run in the Trash is left out", listOf("filed", "run-S", "evidence-1", "decision-1", "comment-C"), items.map { it.key })
        assertEquals("Evidence r1 accepted by a reviewing agent", TaskDetailLogic.activityText(items[3]))
        assertEquals("Evidence r1 submitted", TaskDetailLogic.activityText(items[2]))
    }
}
