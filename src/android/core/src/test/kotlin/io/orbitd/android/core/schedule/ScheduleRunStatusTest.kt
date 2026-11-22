package io.orbitd.android.core.schedule

import java.time.Instant
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ScheduleRunStatusTest {
    private val now = Instant.parse("2026-11-20T04:44:00Z")
    private val zone = "UTC"
    private val planned = "2026-11-20T03:32:00Z"
    private val third = "2026-11-20T03:58:00Z"
    private val gaveUp = "2026-11-20T05:44:00Z"
    private val tries = listOf(planned, "2026-11-20T03:43:00Z", third, "2026-11-20T04:23:00Z", "2026-11-20T05:34:00Z")
    private val display = ScheduleRunStatusDisplay

    private fun read(state: String, session: String, status: String, reason: String = "RUNNER_UNAVAILABLE"): SessionScheduleCardsResponse =
        SessionScheduleCardsResponse.parse(Json.parseToJsonElement("""
            {"run":{"id":"run","scheduleId":"schedule","plannedAt":"$planned","state":"$state",
              "sessionId":"$session","failureReason":"$reason"},"cards":[],"records":[]$status}
        """.trimIndent()))!!

    private fun status(count: Int, thisTry: Int = 1, reached: Int = -1, extra: String = ""): String {
        val rows = tries.take(count).mapIndexed { i, at ->
            """{"sessionId":"try${i + 1}","startedAt":"$at","claimed":${i == 0},"reachedEngine":${i + 1 == reached}}"""
        }
        return ""","runStatus":{"tries":[${rows.joinToString()}],"thisTry":$thisTry$extra}"""
    }

    @Test fun missedRunFromAnyTryShowsItsTimesAndNextRun() {
        for (index in 1..5) {
            val answer = read("MISSED", "try5", status(5, index, extra =
                ""","gaveUpAt":"$gaveUp","nextDueAt":"2026-11-21T06:00:00Z""""))
            assertEquals(ScheduleRunStatusKind.DIDNT_RUN, answer.statusKind)
            val text = display.didntRun(answer.run!!, answer.runStatus!!, "HPC", now, zone)
            assertEquals("Didn't run", text.title)
            assertEquals("HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.", text.body)
            assertEquals(listOf("03:32", "03:43", "03:58", "04:23", "05:34"), text.times)
            assertEquals("gave up 05:44", text.gaveUp)
            assertEquals("Next run: tomorrow 06:00", text.next)
            assertEquals("Scheduled run · planned 03:32 · access Edit and land on main",
                display.strip(answer.run, "LAND", zone))
        }
    }

    @Test fun deadlineAfterAFullRunnerUsesTheFullReason() {
        val answer = read("MISSED", "try1", status(1, extra = ""","gaveUpAt":"$gaveUp""""), "RUNNER_FULL")
        assertEquals(ScheduleRunStatusKind.DIDNT_RUN, answer.statusKind)
        assertEquals("HPC was full the whole time, so the run never started. Nothing was changed.",
            display.didntRun(answer.run!!, answer.runStatus!!, "HPC", now, zone).body)
    }

    @Test fun queuedRunReadsCapacityAndShowsWaitingAndDeadline() {
        val answer = read("RUNNING", "try1", status(1, extra =
            ""","queue":{"queuedReason":"runner_at_capacity","queuedActive":20,"queuedLimit":20,
                "queuedHeldByJobs":0,"since":"$planned","deadline":"2026-11-21T03:32:00Z"}"""))
        assertEquals(ScheduleRunStatusKind.QUEUED_FULL, answer.statusKind)
        val gate = answer.runStatus!!.queue!!
        assertEquals(ScheduleRunQueueGate("runner_at_capacity", 20, 20, 0, planned, "2026-11-21T03:32:00Z"), gate)
        val body = "HPC is running 20 of 20 sessions. The run starts as soon as one finishes."
        val text = display.queued("runner full", body, "Waiting 1 h 12 min", gate.deadline, now, zone)
        assertEquals("Queued · runner full", text.title)
        assertEquals(body, text.body)
        assertEquals("Waiting 1 h 12 min · gives up at 03:32 tomorrow", text.next)
        assertEquals("Gives up at 03:32 tomorrow", display.queued("runner full", body, null, gate.deadline, now, zone).next)
    }

    @Test fun earlierTryPointsToTheSessionThatReachedItsEngine() {
        val answer = read("RUNNING", "try3", status(3, reached = 3))
        assertEquals(ScheduleRunStatusKind.STARTED_ON, answer.statusKind)
        val text = display.startedOn(answer.run!!, answer.runStatus!!, "Claude Code", "HPC", zone)!!
        assertEquals("Started on try 3", text.title)
        assertEquals("This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.", text.body)
        assertNull(read("RUNNING", "try3", status(3, thisTry = 3, reached = 3)).statusKind)
    }

    @Test fun oldServersAndRunsBetweenTriesKeepTheOrdinaryReader() {
        assertNull(read("MISSED", "try1", "").statusKind)
        assertNull(read("QUEUED", "try1", status(1)).statusKind)
        assertNull(read("MISSED", "try1", status(1, thisTry = 0)).statusKind)
    }
}
