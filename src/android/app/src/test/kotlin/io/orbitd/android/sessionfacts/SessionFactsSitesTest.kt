package io.orbitd.android.sessionfacts

import io.orbitd.android.composer.sendEndpoint
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.RunState
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.displayRunState
import io.orbitd.android.directory.effectiveRunState
import io.orbitd.android.push.pushStale
import io.orbitd.android.reader.WorktreeBarLogic
import io.orbitd.android.tasks.TaskDetailLogic
import io.orbitd.android.tasks.resolvedRunState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Plan step 5.4: the sites that decided on exact terminal words, each with the session facts present and absent. Site 2, the wait
 * after End and Move, went when the server took the release over (a move is one request). */
class SessionFactsSitesTest {
    private fun row(json: String) = Json.parseToJsonElement(json).jsonObject
    private fun directorySession(json: String): DirectorySession =
        Wire.json.decodeFromString<DirectorySession>("""{"id":"s",${json.trim().removePrefix("{")}""")

    // Site 1: the push filter (push/PushAuthority.kt).
    @Test fun pushFinishedStandsForAReleasedSessionWhoseWorkFinished() {
        assertFalse(pushStale(row("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","endReason":"task_done"}"""), true))
        assertFalse(pushStale(row("""{"status":"CANCELLED","released":true,"phase":"IDLE","workFinished":true}"""), true))
    }
    @Test fun pushFinishedIsNothingForAnEndSomebodyAskedForOrAPlainConversation() {
        assertTrue(pushStale(row("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","endReason":"ended"}"""), true))
        assertTrue(pushStale(row("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED"}"""), true))
        assertTrue(pushStale(row("""{"status":"SUCCEEDED","released":false,"phase":"IDLE"}"""), true))
    }
    @Test fun pushFailedStandsForAFailedTurnNobodyAskedToEnd() {
        assertFalse(pushStale(row("""{"status":"FAILED","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED"}"""), false))
        assertTrue(pushStale(row("""{"status":"FAILED","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED","endReason":"ended"}"""), false))
        assertTrue(pushStale(row("""{"status":"FAILED","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED","retryAt":"2026-01-01T00:00:00Z"}"""), false))
    }
    @Test fun pushWithoutTheFactsDecidesFromTheExactStatusAsBefore() {
        assertFalse(pushStale(row("""{"status":"SUCCEEDED"}"""), true))
        assertTrue(pushStale(row("""{"status":"FAILED"}"""), true))
        assertFalse(pushStale(row("""{"status":"FAILED"}"""), false))
        assertTrue(pushStale(row("""{"status":"FAILED","completedAt":"x"}"""), false))
        assertTrue(pushStale(row("""{"status":"SUCCEEDED","retryAt":"x"}"""), true))
    }

    // Site 3: Commit versus Merge (reader/WorktreeBar.kt).
    @Test fun committedReadsReleasedWhenSent() {
        assertTrue(WorktreeBarLogic.committed(row("""{"released":true,"phase":"IDLE"}"""), "AWAITING_INPUT"))
        assertFalse(WorktreeBarLogic.committed(row("""{"released":false,"phase":"IDLE"}"""), "SUCCEEDED"))
        assertTrue(WorktreeBarLogic.committed(row("""{"released":false,"phase":"PENDING"}"""), "RUNNING"))
    }
    @Test fun committedFallsBackToTheStatusWhenAbsent() {
        for (s in listOf("RUNNING", "AWAITING_INPUT", "INTERRUPTED")) assertFalse(s, WorktreeBarLogic.committed(row("""{}"""), s))
        for (s in listOf("SUCCEEDED", "FAILED", "CANCELLED", "PENDING")) assertTrue(s, WorktreeBarLogic.committed(row("""{}"""), s))
    }

    // Site 4: resume versus turns when capabilities is absent (composer/ComposerData.kt).
    @Test fun sendEndpointReadsReleasedWhenCapabilitiesAreAbsent() {
        assertEquals("resume", sendEndpoint(row("""{"status":"AWAITING_INPUT","lifecycleState":"OPEN","released":true,"phase":"IDLE"}""")))
        assertEquals("turns", sendEndpoint(row("""{"status":"SUCCEEDED","lifecycleState":"OPEN","released":false,"phase":"IDLE"}""")))
        assertEquals("turns", sendEndpoint(row("""{"status":"WHATEVER","released":false,"phase":"RUNNING"}""")))
    }
    @Test fun sendEndpointFallsBackToTheStatusAndCapabilitiesStillWin() {
        assertEquals("turns", sendEndpoint(row("""{"status":"AWAITING_INPUT"}""")))
        assertEquals("resume", sendEndpoint(row("""{"status":"FAILED"}""")))
        assertEquals("turns", sendEndpoint(row("""{"released":true,"capabilities":{"canSend":true}}""")))
    }

    // Site 5: a task run's result off the session row (tasks/TaskDetail.kt, TaskLogic.kt).
    // With the facts, the label is the approved board's state from `phase` and its marks (docs/mocks/session-display-three-states);
    // Interrupted, Background, Will resume, Finished and Ended are not marks (the owner, 2026-11-27).
    @Test fun aTaskRunReadsItsResultOffTheFactsWhenSent() {
        fun label(json: String) = TaskDetailLogic.runLabel(row(json))
        assertEquals("Idle", label("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","endReason":"task_done","workFinished":true}"""))
        assertEquals("Idle", label("""{"status":"FAILED","released":true,"phase":"IDLE","endReason":"ended","lastTurnOutcome":"FAILED"}"""))
        assertEquals("Idle", label("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED"}"""))
        assertEquals("Idle · Failed", label("""{"status":"FAILED","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED"}"""))
        assertEquals("Idle", label("""{"status":"INTERRUPTED","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED","endReason":"ended"}"""))
        // A parked session's run state stays parked (web dispatchedTurnInFlight); the label is its phase.
        assertEquals("AWAITING_INPUT", resolvedRunState(row("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING"}""")))
        assertEquals("Running", label("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING"}"""))
        assertEquals("Queued · On hold", label("""{"status":"PENDING","released":false,"phase":"PENDING","waitingOn":"HOLD"}"""))
        assertEquals("Queued", label("""{"status":"PENDING","released":false,"phase":"PENDING"}"""))
        assertEquals("Idle", label("""{"status":"AWAITING_INPUT","released":false,"phase":"IDLE"}"""))
    }
    @Test fun aTaskRunKeepsTodaysWordsWhenTheFactsAreAbsentOrUnknown() {
        fun label(json: String) = TaskDetailLogic.runLabel(row(json))
        assertEquals("Finished", label("""{"status":"SUCCEEDED"}"""))
        assertEquals("Failed", label("""{"status":"FAILED"}"""))
        assertEquals("Queued", label("""{"status":"PENDING","waitingOn":"HOLD"}"""))
        assertEquals("Ended", label("""{"status":"CANCELLED"}"""))
        // An unknown phase with released false falls back to the status.
        assertEquals("Running", label("""{"status":"RUNNING","released":false,"phase":"HIBERNATING"}"""))
        assertEquals("RUNNING", resolvedRunState(row("""{"runState":"RUNNING"}""")))
    }

    // F2: a held session whose status word is unknown reads its phase; absent fields keep the old reading.
    @Test fun anUnknownStatusHeldSessionWithActivityTurnReadsRunning() {
        fun word(json: String) = SessionHeader.statusWord(directorySession(json))
        assertEquals("Running", word("""{"status":"MYSTERY","released":false,"phase":"RUNNING","activity":"TURN"}"""))
        assertEquals("Queued", word("""{"status":"MYSTERY","released":false,"phase":"PENDING","activity":"TURN"}"""))
    }
    // F1: the server's own capabilities for a resumable session carry canSend AND canResume.
    @Test fun aReleasedSessionResumesWhenCapabilitiesSayBoth() {
        val caps = ""","capabilities":{"canSend":true,"canResume":true}"""
        assertEquals("resume", sendEndpoint(row("""{"status":"AWAITING_INPUT","released":true,"phase":"IDLE"$caps}""")))
        assertEquals("resume", sendEndpoint(row("""{"status":"MYSTERY","released":true,"phase":"IDLE"$caps}""")))
    }
    @Test fun aHeldSessionTakesATurnWhenCapabilitiesSayBoth() {
        val caps = ""","capabilities":{"canSend":true,"canResume":true}"""
        assertEquals("turns", sendEndpoint(row("""{"status":"AWAITING_INPUT","released":false,"phase":"IDLE"$caps}""")))
        assertEquals("turns", sendEndpoint(row("""{"status":"MYSTERY","released":false,"phase":"RUNNING"$caps}""")))
    }
    @Test fun withoutTheReleaseFieldCapabilitiesDecideAsBefore() {
        val caps = ""","capabilities":{"canSend":true,"canResume":true}"""
        assertEquals("turns", sendEndpoint(row("""{"status":"FAILED"$caps}""")))
        assertEquals("turns", sendEndpoint(row("""{"status":"AWAITING_INPUT"$caps}""")))
        assertEquals("turns", sendEndpoint(row("""{"status":"AWAITING_INPUT","capabilities":{"canSend":true,"canResume":false}}""")))
    }
    @Test fun anUnknownStatusHeldSessionReadsItsPhase() {
        fun word(json: String) = SessionHeader.statusWord(directorySession(json))
        // The word is the state from `phase` (the board); the run state below it reads the phase as before.
        assertEquals("Idle", word("""{"status":"MYSTERY","released":false,"phase":"IDLE"}"""))
        assertEquals("Running", word("""{"status":"MYSTERY","released":false,"phase":"RUNNING"}"""))
        assertEquals("Queued", word("""{"status":"MYSTERY","released":false,"phase":"PENDING"}"""))
        assertEquals("Idle", word("""{"status":"MYSTERY","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED"}"""))
        assertEquals(RunState.INTERRUPTED, directorySession("""{"status":"MYSTERY","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED"}""").effectiveRunState)
        assertEquals(RunState.AWAITING_INPUT, directorySession("""{"status":"MYSTERY","released":false,"phase":"IDLE"}""").effectiveRunState)
    }
    @Test fun anUnknownStatusReleasedSessionReadsTheReleaseRules() {
        fun word(json: String) = SessionHeader.statusWord(directorySession(json))
        // The word is Idle (the board); the release rules still decide the run state the rest of the app reads.
        assertEquals("Idle", word("""{"status":"MYSTERY","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED"}"""))
        assertEquals(RunState.FAILED, directorySession("""{"status":"MYSTERY","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED"}""").displayRunState)
        assertEquals(RunState.SUCCEEDED, directorySession("""{"status":"MYSTERY","released":true,"phase":"IDLE","endReason":"task_done"}""").displayRunState)
        assertEquals(RunState.ENDED, directorySession("""{"status":"MYSTERY","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED"}""").displayRunState)
    }
    @Test fun anUnknownStatusWithoutTheFactsKeepsReadingEnded() {
        assertEquals("Ended", SessionHeader.statusWord(directorySession("""{"status":"MYSTERY"}""")))
        assertEquals("Ended", SessionHeader.statusWord(directorySession("""{"status":"MYSTERY","phase":"IDLE"}""")))
        assertEquals("Ended", SessionHeader.statusWord(directorySession("""{"status":"MYSTERY","released":false,"phase":"HIBERNATING"}""")))
    }
    @Test fun theTaskRunLabelReadsPhaseForAnUnknownStatusAndFallsBackWhenAbsent() {
        fun label(json: String) = TaskDetailLogic.runLabel(row(json))
        // With the facts, the label is the state from `phase` and its marks (the board); resolvedRunState keeps the parked reading.
        assertEquals("Idle", label("""{"status":"MYSTERY","released":false,"phase":"IDLE"}"""))
        assertEquals("Running", label("""{"status":"MYSTERY","released":false,"phase":"RUNNING"}"""))
        assertEquals("Queued", label("""{"status":"MYSTERY","released":false,"phase":"PENDING"}"""))
        // The server sends activity TURN on every queued or running row: that is a running turn, not parked work.
        assertEquals("Running", label("""{"status":"RUNNING","released":false,"phase":"RUNNING","activity":"TURN"}"""))
        assertEquals("Queued", label("""{"status":"PENDING","released":false,"phase":"PENDING","activity":"TURN"}"""))
        // A job with no turn (RUNNING phase, another activity) is Running (Background is not a mark); its run state stays parked.
        assertEquals("Running", label("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB"}"""))
        assertEquals("AWAITING_INPUT", resolvedRunState(row("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB"}""")))
        // A parked session whose engine runs its own turn is Running; its run state is still parked: the status decides before the activity.
        assertEquals("Running", label("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"TURN"}"""))
        assertEquals("AWAITING_INPUT", resolvedRunState(row("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"TURN"}""")))
        assertEquals("Running", label("""{"status":"RUNNING","released":false,"phase":"RUNNING","activity":"TURN"}"""))
        // An unknown status falls back to the activity.
        assertEquals("Running", label("""{"status":"MYSTERY","released":false,"phase":"RUNNING","activity":"TURN"}"""))
        assertEquals("Running", label("""{"status":"MYSTERY","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB"}"""))
        assertEquals("AWAITING_INPUT", resolvedRunState(row("""{"status":"MYSTERY","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB"}""")))
        assertEquals("Running", label("""{"status":"RUNNING","released":false,"phase":"RUNNING","activity":"WAITING"}"""))
        // `released` with an unknown phase is not the facts: web, and now Android, fall back to the status.
        assertEquals("Running", label("""{"status":"RUNNING","released":true,"phase":"HIBERNATING"}"""))
        assertEquals("—", label("""{"status":"MYSTERY"}"""))
    }
}
