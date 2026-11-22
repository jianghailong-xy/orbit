package io.orbitd.android.directory

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The conversation bar's project sessions button spins while anything its sheet shows is active (owner 2026-11-17,
 * docs/mocks/project-sessions-button-running, option C; iOS `AppModel.projectActive`, web `projectSessionsButtonActive`). */
class ProjectSessionsButtonActivityTest {
    private fun active(sessions: List<DirectorySession> = emptyList(), integration: String? = null, promotion: String? = null) =
        ProjectSessionsButtonActivity.active(sessions, { null }, integration?.let { Json.parseToJsonElement(it).jsonObject },
            promotion?.let { Json.parseToJsonElement(it).jsonObject })

    @Test fun aSessionAtWorkOrWithABackgroundJobInFlightSpinsIt() {
        assertTrue(active(listOf(DirectorySession("s", "t", status = "RUNNING", runState = "RUNNING"))))
        assertTrue(active(listOf(DirectorySession("s", "t", status = "AWAITING_INPUT", runState = "AWAITING_INPUT",
            runningBgCount = 1, runningBgJobCount = 1))))
        assertFalse(active(listOf(DirectorySession("s", "t", status = "AWAITING_INPUT", runState = "AWAITING_INPUT"))))
        assertFalse(active())
    }

    @Test fun aLandingJobRunningOrQueuedSpinsIt() {
        assertTrue(active(integration = """{"inFlight":{"kind":"LAND_TASK"},"integratingCount":1,"queuedCount":0}"""))
        assertTrue(active(integration = """{"inFlight":null,"integratingCount":0,"queuedCount":1}"""))
        assertTrue(active(integration = """{"inFlight":null,"integratingCount":0,"queuedCount":0,"inFlightJobs":[{"kind":"LAND_TASK"}]}"""))
        assertFalse(active(integration = """{"inFlight":null,"integratingCount":0,"queuedCount":0,"inFlightJobs":[]}"""))
    }

    @Test fun aMergeBeingCheckedOrLandingSpinsItButNotOneWaitingOnADecision() {
        for (state in listOf("CHECKING", "CONFIRMED", "RECHECKING")) assertTrue(state, active(promotion = """{"state":"$state"}"""))
        for (state in listOf("READY", "BLOCKED", "MERGED")) assertFalse(state, active(promotion = """{"state":"$state"}"""))
    }
}
