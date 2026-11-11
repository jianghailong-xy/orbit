package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RunQuestionCardTest {
    @Test fun coordinatorQuestionIsAReadOnlyTranscriptCard() {
        val source = Json.parseToJsonElement("""{"requestId": "run-question-1", "taskTitle": "Ship client cards", "runSessionId": "run-session", "replyBy": "2026-11-12T12:00:00Z", "state": "PENDING", "approvalStatus": "PENDING", "questions": [{"question": "Ship now?", "options": [{"label": "Ship", "description": "Release today"}, {"label": "Wait"}], "multiSelect": false}]}""")
        val cards = transcriptCards(RunEvent("user", 1, buildJsonObject { put("runQuestion", source) }))
        assertEquals(1, cards.size)
        assertEquals("Run question", cards.single().title)
        assertEquals(source, cards.single().source)
        assertTrue(cards.single().actions.isEmpty())
        assertTrue(transcriptCards(RunEvent("user", 2, buildJsonObject { put("text", "runQuestion") })).isEmpty())
    }
}
