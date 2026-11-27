package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Plan step 0.7: without `capabilities`, a status the app cannot classify — a new word, or none — is never sent a turn in place; it
 * gets what an ended session gets (`resume`) instead of throwing. The seven known words, and any status with capabilities, are as before.
 */
class ComposerUnknownStatusTest {
    private fun detail(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test fun anUnknownStatusFallsBackToResumeWithoutThrowing() {
        assertEquals("resume", sendEndpoint(detail("""{"id":"s","status":"SOME_NEW_WORD","lifecycleState":"OPEN"}""")))
    }

    @Test fun aMissingStatusFallsBackToResumeWithoutThrowing() {
        assertEquals("resume", sendEndpoint(detail("""{"id":"s","lifecycleState":"OPEN"}""")))
        assertEquals("resume", sendEndpoint(detail("""{"id":"s"}""")))
    }

    @Test fun theFallbackIsWhatAnEndedSessionGets() {
        assertEquals(sendEndpoint(detail("""{"id":"s","status":"ENDED"}""")), sendEndpoint(detail("""{"id":"s","status":"SOME_NEW_WORD"}""")))
    }

    @Test fun theSevenKnownStatusesBehaveAsBefore() {
        val expected = mapOf("PENDING" to "turns", "RUNNING" to "turns", "AWAITING_INPUT" to "turns",
            "FAILED" to "resume", "CANCELLED" to "resume")
        for ((status, endpoint) in expected) assertEquals(status, endpoint, sendEndpoint(detail("""{"id":"s","status":"$status"}""")))
        // These two were refused before this change, and still are.
        for (status in listOf("SUCCEEDED", "INTERRUPTED")) {
            val failure = runCatching { sendEndpoint(detail("""{"id":"s","status":"$status"}""")) }.exceptionOrNull()
            assertEquals(status, "Session state is unavailable.", failure?.message)
        }
    }

    @Test fun aTrashedOrCompletedSessionStillAsksForRestoreFirst() {
        val failure = runCatching { sendEndpoint(detail("""{"id":"s","status":"SOME_NEW_WORD","lifecycleState":"TRASHED"}""")) }.exceptionOrNull()
        assertEquals("Restore this session before sending.", failure?.message)
    }

    @Test fun capabilitiesStillDecideForAnyStatus() {
        for (status in listOf("RUNNING", "FAILED", "SOME_NEW_WORD")) {
            assertEquals("turns", sendEndpoint(detail("""{"status":"$status","capabilities":{"canSend":true,"canResume":true}}""")))
            assertEquals("resume", sendEndpoint(detail("""{"status":"$status","capabilities":{"canSend":false,"canResume":true}}""")))
            val failure = runCatching { sendEndpoint(detail("""{"status":"$status","capabilities":{"resumeBlockedReason":"Blocked."}}""")) }
                .exceptionOrNull()
            assertEquals("Blocked.", failure?.message)
        }
        val noStatus = detail("""{"capabilities":{"canSend":true}}""")
        assertEquals("turns", sendEndpoint(noStatus))
    }
}
