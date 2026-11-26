package io.orbitd.android.core.guests

import io.orbitd.android.directory.SessionDisplayState
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The guest view and Shared with me draw the state and the marks as web does (`SharedSessionStatus`, `sharedWithMeStateText`), one named
 * test per case of the cross-client check: the 23 cases' `guestRow` and `sharedHead` as the server's own code builds them
 * (scripts/acceptance/session-three-state-check/guest/make-guest-payloads.cjs). The expected words are web's
 * `sessionDisplayState` and `sessionMarks` on those payloads.
 *
 * Each case also holds the older server: with the six facts taken out, both functions answer null and the row and the head say what
 * they said before this change (recorded from the code before it).
 */
class GuestDisplayRowsTest {
    private val cases: Map<String, JsonObject> = Json.parseToJsonElement(
        File("../../../scripts/acceptance/session-three-state-check/guest/guest-payloads.json").readText()).jsonArray
        .associate { it.jsonObject["name"]!!.jsonPrimitive.content to it.jsonObject }
    private val facts = setOf("phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished")

    private fun payload(case: String, kind: String) = cases.getValue(case)[kind]!!.jsonObject
    private fun row(p: JsonObject) = GuestWire.list(buildJsonObject { put("sessions", buildJsonArray { add(p) }) }.toString()
        .encodeToByteArray()).single()
    private fun head(p: JsonObject) = GuestWire.state(p)

    private fun matchesWeb(case: String, state: SessionDisplayState, marks: List<String>) {
        val tone = when (state) {
            SessionDisplayState.QUEUED -> GuestTone.QUEUED
            SessionDisplayState.RUNNING -> GuestTone.RUNNING
            SessionDisplayState.IDLE -> GuestTone.IDLE
        }
        val row = row(payload(case, "guestRow"))
        for ((kind, shown) in listOf("guestRow" to row.state, "sharedHead" to head(payload(case, "sharedHead")))) {
            assertEquals("$case $kind state", state.word, shown.word)
            assertEquals("$case $kind marks", marks, shown.marks?.map { it.word })
            assertEquals("$case $kind tone", tone, shown.tone)
        }
        assertEquals("$case Shared with me", "${row.ownerName} · ${(listOf(state.word) + marks).joinToString(" · ")}", SharedWithMe.subtitle(row))
        olderServer(case)
    }

    private fun olderServer(case: String) {
        val before = LEGACY.getValue(case)
        val row = row(JsonObject(payload(case, "guestRow") - facts))
        val head = head(JsonObject(payload(case, "sharedHead") - facts))
        for (shown in listOf(row.state, head)) assertNull("$case without facts", shown.marks)
        assertEquals("$case without facts", before, listOf(SharedWithMe.subtitle(row).substringAfter(" · "), row.state.tone.name,
            head.word, head.tone.name))
    }

    private val Q = SessionDisplayState.QUEUED
    private val R = SessionDisplayState.RUNNING
    private val I = SessionDisplayState.IDLE

    @Test fun theFileHoldsTheChecksTwentyThreeCases() = assertEquals(LEGACY.keys, cases.keys)

    @Test fun pending_matchesWeb() = matchesWeb("PENDING", Q, listOf<String>())
    @Test fun running_matchesWeb() = matchesWeb("RUNNING", R, listOf<String>())
    @Test fun awaitingInput_matchesWeb() = matchesWeb("AWAITING_INPUT", I, listOf<String>())
    @Test fun interrupted_matchesWeb() = matchesWeb("INTERRUPTED", I, listOf("Interrupted"))
    @Test fun succeeded_matchesWeb() = matchesWeb("SUCCEEDED", I, listOf("Finished"))
    @Test fun failed_matchesWeb() = matchesWeb("FAILED", I, listOf("Failed"))
    @Test fun cancelled_matchesWeb() = matchesWeb("CANCELLED", I, listOf("Ended"))
    @Test fun jobRunning_matchesWeb() = matchesWeb("job running", R, listOf("Background"))
    @Test fun waitingOnAnApproval_matchesWeb() = matchesWeb("waiting on an approval", R, listOf("Needs you"))
    @Test fun watchArmed_matchesWeb() = matchesWeb("watch armed", I, listOf("Will resume"))
    @Test fun pausedAccount_matchesWeb() = matchesWeb("paused account", Q, listOf("On hold"))
    @Test fun settledLanding_matchesWeb() = matchesWeb("settled landing", I, listOf("Finished"))
    @Test fun endedRunnerNeverConfirmed_matchesWeb() = matchesWeb("ended, runner never confirmed", I, listOf("Ended"))
    @Test fun oldPlainRowStoredSucceeded_matchesWeb() = matchesWeb("old plain row stored SUCCEEDED", I, listOf("Ended"))
    @Test fun endingAfterAnInterruptedTurn_matchesWeb() = matchesWeb("ending after an interrupted turn", I, listOf("Interrupted"))
    @Test fun parkedEngineStartedItsOwnTurn_matchesWeb() = matchesWeb("parked, engine started its own turn", R, listOf<String>())
    @Test fun parkedSubAgentRunning_matchesWeb() = matchesWeb("parked, sub-agent running", R, listOf<String>())
    @Test fun parkedBackgroundProcessLeftUp_matchesWeb() = matchesWeb("parked, background process left up", I, listOf("Background"))
    @Test fun parkedRetryArmed_matchesWeb() = matchesWeb("parked, retry armed", I, listOf("Will resume"))
    @Test fun failedRetryArmed_matchesWeb() = matchesWeb("failed, retry armed", I, listOf("Retrying"))
    @Test fun failedRunnerOffline_matchesWeb() = matchesWeb("failed, runner offline", I, listOf("Failed"))
    @Test fun approvalBesideABackgroundJob_matchesWeb() = matchesWeb("approval beside a background job", R, listOf("Needs you", "Background"))
    @Test fun interruptedAProcessUpRetryArmed_matchesWeb() = matchesWeb("interrupted, a process up, retry armed", I, listOf("Interrupted", "Background", "Will resume"))

    /** A filed session: the state and marks as ever, then Completed (web puts it after them, never instead). */
    @Test fun aFiledSessionSaysCompletedAfterItsStateAndMarks() {
        val row = row(JsonObject(payload("SUCCEEDED", "guestRow") + ("lifecycleState" to JsonPrimitive("COMPLETED"))))
        assertEquals("Idle", row.state.word)
        assertEquals(GuestTone.IDLE, row.state.tone)
        assertEquals("${row.ownerName} · Idle · Finished · Completed", SharedWithMe.subtitle(row))
    }

    /** What a mark reads beside the facts: the approvals count too, where a payload sends it. */
    @Test fun theCountsBesideTheFactsAreReadWhenSent() {
        val p = payload("AWAITING_INPUT", "guestRow")
        val more = JsonObject(p + ("runningBgCount" to JsonPrimitive(1)) + ("pendingApprovals" to JsonPrimitive(1)))
        for (shown in listOf(row(more).state, head(more))) assertEquals(listOf("Needs you", "Background"), shown.marks!!.map { it.word })
    }

    private companion object {
        /** Without the facts, before this change: Shared with me's state text and tone, then the head's word and tone. */
        val LEGACY: Map<String, List<String>> = mapOf(
            "PENDING" to listOf("Queued", "QUEUED", "Queued", "QUEUED"),
            "RUNNING" to listOf("Running", "RUNNING", "Running", "RUNNING"),
            "AWAITING_INPUT" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "INTERRUPTED" to listOf("Interrupted", "CANCELLED", "Interrupted", "CANCELLED"),
            "SUCCEEDED" to listOf("Succeeded", "DONE", "Succeeded", "DONE"),
            "FAILED" to listOf("Failed", "FAILED", "Failed", "FAILED"),
            "CANCELLED" to listOf("Ended", "CANCELLED", "Ended", "CANCELLED"),
            "job running" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "waiting on an approval" to listOf("Running", "RUNNING", "Running", "RUNNING"),
            "watch armed" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "paused account" to listOf("Queued", "QUEUED", "Queued", "QUEUED"),
            "settled landing" to listOf("Succeeded", "DONE", "Succeeded", "DONE"),
            "ended, runner never confirmed" to listOf("Failed", "FAILED", "Failed", "FAILED"),
            "old plain row stored SUCCEEDED" to listOf("Succeeded", "DONE", "Succeeded", "DONE"),
            "ending after an interrupted turn" to listOf("Interrupted", "CANCELLED", "Ended", "CANCELLED"),
            "parked, engine started its own turn" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "parked, sub-agent running" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "parked, background process left up" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "parked, retry armed" to listOf("Awaiting reply", "AWAITING", "Awaiting reply", "AWAITING"),
            "failed, retry armed" to listOf("Failed", "FAILED", "Failed", "FAILED"),
            "failed, runner offline" to listOf("Failed", "FAILED", "Failed", "FAILED"),
            "approval beside a background job" to listOf("Running", "RUNNING", "Running", "RUNNING"),
            "interrupted, a process up, retry armed" to listOf("Interrupted", "CANCELLED", "Interrupted", "CANCELLED")
        )
    }
}
