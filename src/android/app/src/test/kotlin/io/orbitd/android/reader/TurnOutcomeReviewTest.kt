package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test

class TurnOutcomeReviewTest {
    private val notice = "This turn ended without a reply — send the message again to retry."
    private fun event(seq: Long, type: String, payload: String = "{}") = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    @Test fun failedTurnWithoutReplyProducesReadableAnchoredExplanation() {
        val rows = transcriptRows(listOf(event(1, "user", """{"text":"Help"}"""),
            event(2, "turn_end", """{"subtype":"error_during_execution"}""")))
        assertEquals(listOf("Help", notice), rows.map { it.event.body() })
        assertEquals("event:2", anchorRow(rows, 2)!!.key)
    }
    @Test fun finishedUnknownAndExplainedOutcomesDoNotInventFailures() {
        for (subtype in listOf("success", "completed", "")) {
            assertEquals(1, transcriptRows(listOf(event(1, "user"), event(2, "turn_end", """{"subtype":"$subtype"}"""))).size)
        }
        for (type in listOf("assistant", "error", "auth_error", "auto_retry", "interrupt")) {
            val rows = transcriptRows(listOf(event(1, "user"), event(2, type, """{"text":"Existing explanation"}"""),
                event(3, "turn_end", """{"subtype":"failed"}""")))
            assertFalse("$type already explains the outcome", rows.any { it.event.body() == notice })
        }
    }
    @Test fun eachTurnResetsOutcomeButStderrAndToolOutputDoNotExplainMissingReply() {
        val rows = transcriptRows(listOf(event(1, "user"), event(2, "assistant", """{"text":"Reply"}"""),
            event(3, "turn_end", """{"subtype":"completed"}"""), event(4, "user"),
            event(5, "system", """{"text":"engine stderr"}"""), event(6, "tool_result", """{"content":"output"}"""),
            event(7, "turn_end", """{"subtype":"error_during_execution"}"""), event(8, "user"),
            event(9, "interrupt"), event(10, "turn_end", """{"subtype":"interrupted"}""")))
        assertEquals(listOf(7L), rows.filter { it.event.body() == notice }.map { it.event.seq })
    }
    @Test fun aPartialPageDoesNotClaimAnOffPageReplyWasMissing() {
        val rows = transcriptRows(listOf(event(100, "tool_result"), event(101, "turn_end", """{"subtype":"failed"}""")))
        assertFalse(rows.any { it.event.body() == notice })
    }
    @Test fun explicitStatusAndFollowUpInsideAnExplainedTurnDoNotAddAnotherFailure() {
        val status = transcriptRows(listOf(event(1, "user"), event(2, "turn_end", """{"status":"AWAITING_INPUT","subtype":"failed"}""")))
        assertFalse(status.any { it.event.body() == notice })
        val followUp = transcriptRows(listOf(event(1, "user"), event(2, "assistant", """{"text":"Reply"}"""),
            event(3, "user"), event(4, "turn_end", """{"subtype":"failed"}""")))
        assertFalse(followUp.any { it.event.body() == notice })
    }
}
