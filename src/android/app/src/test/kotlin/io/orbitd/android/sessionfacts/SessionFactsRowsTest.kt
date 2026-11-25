package io.orbitd.android.sessionfacts

import io.orbitd.android.core.guests.*
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.RunState
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.SessionLine
import io.orbitd.android.directory.displayFacts
import io.orbitd.android.directory.displayRunState
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Plan step 5.4's five cases on the list row and the guest status pill. With the facts present, the list row now draws the approved
 * board's state and marks (docs/mocks/session-display-three-states): its word is the state from `phase` ([SessionHeader.statusWord]) and
 * its value the state with the marks ([shown]); the run state the rest of the app reads ([displayRunState]) is unchanged. With the facts
 * absent, today's word. */
class SessionFactsRowsTest {
    private val now = Instant.parse("2026-11-23T10:00:00Z")
    private fun s(status: String, endReason: String? = null, released: Boolean? = null, outcome: String? = null, waitingOn: String? = null,
        workFinished: Boolean? = null, phase: String? = null, kind: String? = null, bg: Int? = null) =
        DirectorySession("s", "t", status = status, endReason = endReason, released = released, lastTurnOutcome = outcome, waitingOn = waitingOn,
            workFinished = workFinished, phase = phase, sessionKind = kind, runningBgCount = bg)
    private fun word(s: DirectorySession) = SessionHeader.statusWord(s, now = now)
    private fun shown(s: DirectorySession) = SessionDisplay.text(s.displayFacts, ", ")

    @Test fun aFinishedTaskRunReadsFinished() {
        // The Finished mark reads the server's `workFinished` alone (the board: nothing re-derived).
        assertEquals("Idle, Finished", shown(s("SUCCEEDED", "task_done", true, "ANSWERED", workFinished = true, phase = "IDLE")))
        assertEquals("Idle, Finished", shown(s("CANCELLED", null, true, "ANSWERED", workFinished = true, phase = "IDLE")))
        assertEquals("Idle", word(s("SUCCEEDED", null, true, "ANSWERED", workFinished = true, phase = "IDLE", kind = "LANDING")))
        assertEquals(RunState.SUCCEEDED, s("SUCCEEDED", "task_done", true, "ANSWERED", phase = "IDLE").displayRunState)
        assertNull(shown(s("SUCCEEDED", "task_done")))
        assertEquals("Succeeded", word(s("SUCCEEDED", "task_done")))
    }
    @Test fun aQueuedSessionOnHoldReadsOnHold() {
        assertEquals("Queued", word(s("PENDING", released = false, waitingOn = "HOLD", phase = "PENDING")))
        assertEquals("Queued, On hold", shown(s("PENDING", released = false, waitingOn = "HOLD", phase = "PENDING")))
        assertEquals("Queued", shown(s("PENDING", released = false, phase = "PENDING")))
        assertEquals("Queued", word(s("PENDING")))
    }
    @Test fun anEndNobodyConfirmedReadsEndedNotFailed() {
        assertEquals(RunState.ENDED, s("FAILED", "ended", true, "FAILED", phase = "IDLE").displayRunState)
        assertEquals("Idle, Ended", shown(s("FAILED", "ended", true, "FAILED", phase = "IDLE")))
        assertEquals("Idle, Failed", shown(s("FAILED", released = true, outcome = "FAILED", phase = "IDLE")))
        assertEquals("Failed", word(s("FAILED")))
    }
    @Test fun anOldPlainSucceededReadsEndedNotSucceeded() {
        assertEquals("Idle, Ended", shown(s("SUCCEEDED", null, true, "ANSWERED", phase = "IDLE")))
        assertEquals("Succeeded", word(s("SUCCEEDED")))
    }
    @Test fun anInterruptedSessionBeingEndedReadsInterruptedUntilReleased() {
        assertEquals("Idle, Interrupted", shown(s("INTERRUPTED", "ended", false, "INTERRUPTED", phase = "IDLE")))
        assertEquals(RunState.INTERRUPTED, s("INTERRUPTED", "ended", false, "INTERRUPTED", phase = "IDLE").displayRunState)
        assertEquals("Idle, Ended", shown(s("INTERRUPTED", "ended", true, "INTERRUPTED", phase = "IDLE")))
        assertEquals("Ended", word(s("INTERRUPTED", "ended")))
        assertEquals("Interrupted", word(s("INTERRUPTED")))
    }
    @Test fun aSessionRunningOnlyABackgroundJobKeepsToday() {
        assertEquals("Background process running", word(s("AWAITING_INPUT", bg = 1)))
        assertEquals("Running, Background", shown(s("AWAITING_INPUT", released = false, phase = "RUNNING", bg = 1)))
        assertEquals(s("AWAITING_INPUT").displayRunState, s("AWAITING_INPUT", released = false, phase = "RUNNING", bg = 1).displayRunState)
    }

    private fun guest(vararg f: Pair<String, JsonElement>) = GuestWire.state(buildJsonObject { put("runStatus", "SUCCEEDED"); f.forEach { put(it.first, it.second) } })
    @Test fun guestWordsFollowAppleAndKeepTodayWithoutEnoughFacts() {
        // A guest head that carries the end reason or workFinished says Finished / Ended; one that carries only `released` stays on the old path.
        assertEquals("Finished", guest("released" to JsonPrimitive(true), "workFinished" to JsonPrimitive(true)).word)
        assertEquals("Finished", guest("released" to JsonPrimitive(true), "endReason" to JsonPrimitive("task_done")).word)
        assertEquals("Ended", guest("released" to JsonPrimitive(true), "endReason" to JsonPrimitive("ended")).word)
        assertEquals("Succeeded", guest("released" to JsonPrimitive(true)).word)
        assertEquals("Succeeded", guest().word)
        val queued = GuestState(runStatus = "PENDING", released = false, waitingOn = "HOLD", phase = "PENDING")
        assertEquals("Queued", queued.word)
        assertEquals(listOf("On hold"), queued.marks!!.map { it.word })
        assertEquals("Queued", GuestState(runStatus = "PENDING").word)
        assertEquals("Interrupted", GuestState(runStatus = "INTERRUPTED", released = false, endReason = "ended", lastTurnOutcome = "INTERRUPTED").word)
    }
    @Test fun guestLivenessReadsReleasedWhenSent() {
        assertTrue(GuestState(runStatus = "SUCCEEDED", released = false, phase = "IDLE").live)
        assertFalse(GuestState(runStatus = "AWAITING_INPUT", released = true, phase = "IDLE").live)
        assertTrue(GuestState(runStatus = "AWAITING_INPUT").live)
        assertFalse(GuestState(runStatus = "SUCCEEDED").live)
        assertNull(GuestFollow.delay(GuestState(runStatus = "AWAITING_INPUT", released = true, phase = "IDLE"), moved = false))
    }
}
