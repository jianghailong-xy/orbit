package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The owner's answer handed to the coordinator is drawn from the card recorded beside the turn (`ownerAnswer`) as one line — "Sent to the
 * coordinator · 08:29" — never from the words, which stay what the agent read (OrbitKit OwnerAnswerTests, web OwnerAnswerLine.test.tsx).
 */
class OwnerAnswerLineTest {
    private val card = """{"itemId":"01a0d6a9-d763-70e1-b4cf-8793e971b511","kind":"COORDINATOR_QUESTION",
        "sessionId":"01a0d6a9-d763-70e1-b4cf-8793e971b512","deliveredAt":"2026-10-09T00:29:37.104Z"}"""
    private val told = "From Orbit · owner answer: you asked \"Merge now?\". The owner answered: Wait (2026-10-09T00:29:36.828Z)."
    private fun echo(answer: String?) = RunEvent("user", 9, buildJsonObject {
        put("text", told); answer?.let { put("ownerAnswer", Wire.json.parseToJsonElement(it)) }
    }, "turn-answer")

    @Test fun theAnswerIsOneCardDrawnFromItsFields() {
        val drawn = transcriptCards(echo(card)).single()
        assertEquals("record:9:ownerAnswer", drawn.key)
        assertEquals(CoordinatorQueue.sent, drawn.title)
        assertEquals("01a0d6a9-d763-70e1-b4cf-8793e971b511", drawn.source.text("itemId"))
        assertEquals("2026-10-09T00:29:37.104Z", drawn.source.text("deliveredAt"))
        assertEquals("the owner's Not yet… to a request to record the project done is the same card", "record:9:ownerAnswer",
            transcriptCards(echo(card.replace("COORDINATOR_QUESTION", "DONE_REQUEST"))).single().key)
        assertTrue("an ordinary message is no answer", transcriptCards(echo(null)).isEmpty())
    }

    /** A payload missing what makes it a card — or of a kind no client knows, or with a moment that is not one — is none: never half a line. */
    @Test fun aPayloadThatIsNotACardIsNone() {
        listOf(
            card.replace("\"01a0d6a9-d763-70e1-b4cf-8793e971b511\"", "\"\""),
            card.replace("COORDINATOR_QUESTION", "TASK_FAILED"),
            card.replace("\"01a0d6a9-d763-70e1-b4cf-8793e971b512\"", "42"),
            card.replace("2026-10-09T00:29:37.104Z", "yesterday"),
            """{"itemId":"i","kind":"COORDINATOR_QUESTION","sessionId":"s"}""",
            "\"Sent to the coordinator\"",
            "null",
        ).forEach { payload -> assertTrue(payload, transcriptCards(echo(payload)).isEmpty()) }
    }

    /** The line a revision handed to its coordinator leaves, on the receipts' clock: the time that day, the date as well after it. */
    @Test fun theLineSaysSentToTheCoordinatorAndWhen() {
        val source = transcriptCards(echo(card)).single().source
        val zone = ZoneId.of("Asia/Shanghai")
        assertEquals("Sent to the coordinator · 08:29", OwnerAnswerLine.line(source, Instant.parse("2026-10-09T01:00:00Z"), zone))
        assertEquals("Sent to the coordinator · 10/9 08:29", OwnerAnswerLine.line(source, Instant.parse("2026-10-12T01:00:00Z"), zone))
        assertEquals(CoordinatorQueue.sentLine(OwnerReview.receiptTime("2026-10-09T00:29:37.104Z", Instant.parse("2026-10-09T01:00:00Z"), zone)),
            OwnerAnswerLine.line(source, Instant.parse("2026-10-09T01:00:00Z"), zone))
    }
}
