package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** What the sticky bar says about a turn and which turns it may name — OrbitKit's StickySummary, case for case. */
class StickySummaryTest {
    private fun user(seq: Long, payload: JsonObject) = RunEvent("user", seq, payload)
    private fun text(t: String) = buildJsonObject { put("text", t) }
    private val watch = "Orbit Watch w matched at generation 2: ALL TASK_DONE 2/3\nThis turn was queued by the watch, not typed by a person.\n```json\n{\"watchId\":\"w\",\"changedTargets\":[]}\n```"
    private val wake = "<background-job-wake>\n    bgj_fixture｜job｜echo done｜Check result\n      ended｜completed｜exit code 0\n</background-job-wake>"

    @Test fun aPersonsTurnIsTheirQuestionWithoutWhatDeliveryAppended() {
        val note = "\n\n<referenced-task>\nid: 1\n</referenced-task>"
        val event = user(1, buildJsonObject { put("text", "Ship it?$note"); put("controlPlaneNote", note) })
        assertEquals("↑ Your question" to "Ship it?", StickySummary.of(event))
        assertTrue(StickySummary.isAnchor(event))
    }

    @Test fun cardTurnsAreNamedByTheirCardsOwnWords() {
        assertEquals("↑ From Planner" to "Please review", StickySummary.of(user(1, buildJsonObject {
            put("text", "Please review"); putJsonObject("sessionMessage") { put("fromSessionId", "s"); put("fromTitle", " Planner ") } })))
        assertEquals("↑ From Untitled session" to "Hi", StickySummary.of(user(1, buildJsonObject {
            put("text", "Hi"); putJsonObject("sessionMessage") { put("fromSessionId", "s"); put("fromTitle", "") } })))
        assertEquals("↑ Exception item" to "Merge conflict: Land A06c", StickySummary.of(user(2, buildJsonObject {
            put("text", "x"); putJsonObject("openItemDelivery") { put("itemId", "i"); put("kind", "INTEGRATION_CONFLICT"); put("title", "Land A06c") } })))
        assertEquals("the title already says the kind", "↑ Exception item" to "Task failed: A06c", StickySummary.of(user(2, buildJsonObject {
            put("text", "x"); putJsonObject("openItemDelivery") { put("itemId", "i"); put("kind", "TASK_FAILED"); put("title", "Task failed: A06c") } })))
        assertEquals("↑ Task started" to "A06c", StickySummary.of(user(3, buildJsonObject {
            put("text", "brief"); putJsonObject("taskStart") { put("taskId", "t"); put("title", "A06c") } })))
        assertEquals("↑ Project switched on" to "Android", StickySummary.of(user(4, buildJsonObject {
            put("text", "x"); putJsonObject("projectStarted") { put("projectId", "p"); put("projectTitle", "Android"); put("by", "SWITCH") } })))
        assertEquals("↑ Project started", StickySummary.of(user(4, buildJsonObject {
            put("text", "x"); putJsonObject("projectStarted") { put("projectId", "p"); put("projectTitle", "Android"); put("by", "CONFIRMATION") } })).first)
        assertEquals("↑ Watch triggered" to "2 of 3 done", StickySummary.of(user(5, text(watch))))
        assertTrue(StickySummary.isAnchor(user(5, text(watch))))
    }

    @Test fun aBackgroundWakeIsALineInsideAnAnswerUnlessSomebodyTypedOnIt() {
        assertFalse(StickySummary.isAnchor(user(6, buildJsonObject { put("text", wake); put("controlPlaneNote", wake) })))
        val typed = user(7, buildJsonObject { put("text", "And also this$wake"); put("controlPlaneNote", wake) })
        assertTrue(StickySummary.isAnchor(typed))
        assertEquals("↑ Your question" to "And also this", StickySummary.of(typed))
    }

    /** The owner's answer handed to the coordinator is a line inside the coordinator's work: the bar keeps the question above it. */
    @Test fun theOwnersAnswerIsALineAndNeverTakesTheBar() {
        val answer = user(3, buildJsonObject {
            put("text", "From Orbit · owner answer: you asked \"Merge now?\". The owner answered: Wait (2026-10-09T00:29:36.828Z).")
            putJsonObject("ownerAnswer") {
                put("itemId", "01a0d6a9-d763-70e1-b4cf-8793e971b511"); put("kind", "COORDINATOR_QUESTION")
                put("sessionId", "01a0d6a9-d763-70e1-b4cf-8793e971b512"); put("deliveredAt", "2026-10-09T00:29:37.104Z")
            }
        })
        assertFalse(StickySummary.isAnchor(answer))
        val rows = transcriptRows(listOf(user(1, text("Q1")), RunEvent("assistant", 2, text("A1")), answer, RunEvent("assistant", 4, text("A1 cont."))))
        assertEquals("the answer does not take the bar", "event:1", StickyQuestions(rows).above("event:4")?.key)
        assertTrue("with no card it is the reader's message, as before", StickySummary.isAnchor(user(5, text("From Orbit · owner answer: …"))))
    }

    @Test fun theIndexStepsBackThroughQuestionsAndSkipsWakes() {
        val rows = transcriptRows(listOf(user(1, text("Q1")), RunEvent("assistant", 2, text("A1")),
            user(3, buildJsonObject { put("text", wake); put("controlPlaneNote", wake) }), RunEvent("assistant", 4, text("A1 cont.")),
            user(5, text("Q2")), RunEvent("assistant", 6, text("A2"))))
        val questions = StickyQuestions(rows)
        assertNull(questions.above("event:1"))
        assertEquals("event:1", questions.above("event:2")?.key)
        assertEquals("a wake does not take the bar", "event:1", questions.above("event:5")?.key)
        assertEquals("event:5", questions.above("event:6")?.key)
        assertEquals("event:5", questions.last?.key)
        assertEquals("2 of 3 done", StickySummary.describeReason("ALL TASK_DONE 2/3"))
        assertEquals("1 of 2 finished their turn · 1 of 1 failed", StickySummary.describeReason("ALL SESSION_TURN_SETTLED 1/2 AND ANY TASK_FAILED 1/1"))
        assertEquals("ALL SOMETHING_NEW 1/2", StickySummary.describeReason("ALL SOMETHING_NEW 1/2"))
    }
}
