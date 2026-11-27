package io.orbitd.android.sessionfacts

import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SearchHit
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionDisplayState
import io.orbitd.android.directory.SessionMark
import io.orbitd.android.directory.displayFacts
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A search hit's state and marks on the server's own payloads for the cross-client check's 22 search cases (search-payloads.json:
 * `GET /sessions/search`'s hit beside the same session's list row), one named test per case. The expected answer is the case's list row
 * on every client: the board's (capture/rules.mjs without Disconnected), which the check holds web, Mac and iPhone to. Without the facts
 * (an older server) both functions answer null; what the row then draws is SearchDisplayRowDrawTest's.
 */
class SearchDisplayRowsTest {
    private val cases = Json.parseToJsonElement(
        File("../../../scripts/acceptance/session-three-state-check/search/search-payloads.json").readText()).jsonArray.map { it.jsonObject }
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val facts = setOf("phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished", "activity", "runningBgCount")

    private fun payload(name: String, kind: String) = cases.single { it["name"]!!.jsonPrimitive.content == name }[kind]!!.jsonObject
    private fun hit(p: JsonObject) = json.decodeFromJsonElement(SearchHit.serializer(), p)

    private fun check(name: String, state: SessionDisplayState, vararg marks: SessionMark) {
        val hit = hit(payload(name, "searchHit"))
        assertEquals("$name state", state, SessionDisplay.state(hit.displayFacts))
        assertEquals("$name marks", marks.toList(), SessionDisplay.marks(hit.displayFacts))
        val row = json.decodeFromJsonElement(DirectorySession.serializer(), payload(name, "listRow"))
        assertEquals("$name list row state", state, SessionDisplay.state(row.displayFacts))
        assertEquals("$name list row marks", marks.toList(), SessionDisplay.marks(row.displayFacts))
        val older = hit(JsonObject(payload(name, "searchHit") - facts))
        assertNull("$name older state", SessionDisplay.state(older.displayFacts))
        assertNull("$name older marks", SessionDisplay.marks(older.displayFacts))
    }

    @Test fun theServerAnswersTheTwentyTwoCases() = assertEquals(22, cases.map { it["name"] }.distinct().size)

    @Test fun pending_isQueued() = check("PENDING", Q)
    @Test fun running_isRunning() = check("RUNNING", R)
    @Test fun awaitingInput_isIdle() = check("AWAITING_INPUT", I)
    @Test fun interrupted_isIdleInterrupted() = check("INTERRUPTED", I, SessionMark.INTERRUPTED)
    @Test fun succeeded_isIdleFinished() = check("SUCCEEDED", I, SessionMark.FINISHED)
    @Test fun failed_isIdleFailed() = check("FAILED", I, SessionMark.FAILED)
    @Test fun cancelled_isIdleEnded() = check("CANCELLED", I, SessionMark.ENDED)
    @Test fun jobRunning_isRunningBackground() = check("job running", R, SessionMark.BACKGROUND)
    @Test fun waitingOnAnApproval_isRunningNeedsYou() = check("waiting on an approval", R, SessionMark.NEEDS_YOU)
    @Test fun watchArmed_isPlainIdle() = check("watch armed", I)
    @Test fun pausedAccount_isQueuedOnHold() = check("paused account", Q, SessionMark.ON_HOLD)
    @Test fun endedRunnerNeverConfirmed_isIdleEnded() = check("ended, runner never confirmed", I, SessionMark.ENDED)
    @Test fun oldPlainSucceeded_isIdleEnded() = check("old plain row stored SUCCEEDED", I, SessionMark.ENDED)
    @Test fun endingAfterAnInterruptedTurn_isIdleInterrupted() = check("ending after an interrupted turn", I, SessionMark.INTERRUPTED)
    @Test fun engineStartedItsOwnTurn_isRunning() = check("parked, engine started its own turn", R)
    @Test fun subAgentRunning_isRunning() = check("parked, sub-agent running", R)
    @Test fun processLeftUp_isIdleBackground() = check("parked, background process left up", I, SessionMark.BACKGROUND)
    @Test fun parkedRetryArmed_isPlainIdle() = check("parked, retry armed", I)
    @Test fun failedRetryArmed_isIdleRetrying() = check("failed, retry armed", I, SessionMark.RETRYING)
    @Test fun failedRunnerOffline_isIdleFailed() = check("failed, runner offline", I, SessionMark.FAILED)
    @Test fun approvalBesideABackgroundJob_isRunningNeedsYouBackground() =
        check("approval beside a background job", R, SessionMark.NEEDS_YOU, SessionMark.BACKGROUND)
    @Test fun interruptedProcessUpRetryArmed_isIdleInterruptedBackground() =
        check("interrupted, a process up, retry armed", I, SessionMark.INTERRUPTED, SessionMark.BACKGROUND)

    private companion object {
        val Q = SessionDisplayState.QUEUED
        val R = SessionDisplayState.RUNNING
        val I = SessionDisplayState.IDLE
    }
}
