package io.orbitd.android.sessionfacts

import io.orbitd.android.composer.sendEndpoint
import io.orbitd.android.directory.runEnded
import io.orbitd.android.push.pushStale
import io.orbitd.android.reader.WorktreeBarLogic
import io.orbitd.android.tasks.TaskDetailLogic
import io.orbitd.android.tasks.resolvedRunState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Plan step 5.4: the five sites that decided on exact terminal words, each with the session facts present and absent. */
class SessionFactsSitesTest {
    private fun row(json: String) = Json.parseToJsonElement(json).jsonObject

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

    // Site 2: the wait after End (directory/DirectoryActions.kt).
    @Test fun theWaitAfterEndReadsReleasedWhenSent() {
        assertTrue(runEnded(row("""{"status":"AWAITING_INPUT","released":true}""")))
        assertFalse(runEnded(row("""{"status":"CANCELLED","released":false}""")))
    }
    @Test fun theWaitAfterEndFallsBackToTheTerminalStatusWhenAbsent() {
        for (s in listOf("SUCCEEDED", "FAILED", "CANCELLED")) assertTrue(s, runEnded(row("""{"status":"$s"}""")))
        assertTrue(runEnded(row("""{"status":"RUNNING","runStatus":"FAILED"}""")))
        for (s in listOf("RUNNING", "AWAITING_INPUT", "INTERRUPTED")) assertFalse(s, runEnded(row("""{"status":"$s"}""")))
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
    @Test fun aTaskRunReadsItsResultOffTheFactsWhenSent() {
        fun label(json: String) = TaskDetailLogic.runLabel(row(json))
        assertEquals("Finished", label("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","endReason":"task_done"}"""))
        assertEquals("Ended", label("""{"status":"FAILED","released":true,"phase":"IDLE","endReason":"ended","lastTurnOutcome":"FAILED"}"""))
        assertEquals("Ended", label("""{"status":"SUCCEEDED","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED"}"""))
        assertEquals("Failed", label("""{"status":"FAILED","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED"}"""))
        assertEquals("Interrupted", label("""{"status":"INTERRUPTED","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED","endReason":"ended"}"""))
        assertEquals("Running", label("""{"status":"AWAITING_INPUT","released":false,"phase":"RUNNING"}"""))
        assertEquals("On hold", label("""{"status":"PENDING","released":false,"phase":"PENDING","waitingOn":"HOLD"}"""))
        assertEquals("Queued", label("""{"status":"PENDING","released":false,"phase":"PENDING"}"""))
        assertEquals("Awaiting reply", label("""{"status":"AWAITING_INPUT","released":false,"phase":"IDLE"}"""))
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
}
