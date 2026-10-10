package io.orbitd.android.reader

import io.orbitd.android.core.cards.CardFamily
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A08-4 (iOS f350ee7a1, 52819d05c): the queue's turns drawn at the transcript's end as the turns they will be — with OrbitKit's
 * QueuedSessionReplyTests and QueuedTurnCardsTests fixtures: a queued session reply is its reply cards, a queued task start is its card,
 * a steer and a turn with no id take no Cancel, and a turn the window already holds as delivered is not drawn twice.
 */
class QueuedTailTest {
    private fun rows(json: String) = Wire.json.parseToJsonElement(json).jsonArray.map { it.jsonObject }

    private val reply = """{"requestId":"req1","outcome":"REPLIED","fromSessionId":"s-asked","fromTitle":"分析 session 列表页性能",
        "requestPreview":"再跑一组只读探针","replyText":"全部只读执行","closedAt":"2026-10-06T09:40:00.000Z"}"""
    private val taskStart = """{"taskId":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"runner + web：配额按账户归属","description":null,
        "acceptanceCriteria":null,"completionCriterion":"EVIDENCE_JUDGMENT","acceptanceCommand":null,"acceptanceExpectedExitCode":0,
        "listInstructions":null,"project":{"id":"p1","title":"Codex 多账户"},"auto":true}"""

    @Test fun aQueuedReplyTurnIsItsReplyCards() {
        val tail = queuedTail(rows("""[{"turnId":"t1","kind":"message","content":"<orbit-session-reply request-id=\"req1\">\n…\n</orbit-session-reply>",
            "attachments":[],"sessionReplies":[$reply],"authoredByOrbit":true}]"""), emptyList())
        val turn = tail.single()
        val card = turn.cards.single()
        assertEquals(CardFamily.SESSION_REQUEST, card.family)
        assertEquals("Session reply · REPLIED", card.title)
        assertEquals("req1", card.source.text("requestId"))
        assertEquals("全部只读执行", card.source.text("replyText"))
        assertTrue("an ordinary queued reply can be withdrawn", turn.cancelable)
        assertNull(turn.wake)
    }

    @Test fun aQueuedTaskStartIsItsCard() {
        val turn = queuedTail(rows("""[{"turnId":"t2","kind":"message","content":"the brief","attachments":[],"taskStart":$taskStart,
            "authoredByOrbit":true}]"""), emptyList()).single()
        val card = turn.cards.single()
        assertEquals("Task started", card.title)
        assertEquals("runner + web：配额按账户归属", card.source.text("title"))
        assertTrue(turn.cancelable)
    }

    /** The owner's answer handed to the coordinator waits as the line its echo will be, and can be withdrawn like any queued turn. */
    @Test fun aQueuedOwnerAnswerIsItsLine() {
        val answer = """{"itemId":"01a0d6a9-d763-70e1-b4cf-8793e971b511","kind":"COORDINATOR_QUESTION",
            "sessionId":"01a0d6a9-d763-70e1-b4cf-8793e971b512","deliveredAt":"2026-10-09T00:29:37.104Z"}"""
        val turn = queuedTail(rows("""[{"turnId":"t5","kind":"message","content":"From Orbit · owner answer: you asked \"Merge now?\".",
            "attachments":[],"ownerAnswer":$answer,"authoredByOrbit":true}]"""), emptyList()).single()
        val card = turn.cards.single()
        assertTrue(card.key.endsWith(":ownerAnswer"))
        assertEquals("2026-10-09T00:29:37.104Z", card.source.text("deliveredAt"))
        assertEquals("From Orbit · owner answer: you asked \"Merge now?\".", turn.event.fields.text("text"))
        assertTrue(turn.cancelable)
        val echo = RunEvent("user", 0, buildJsonObject {
            put("text", "From Orbit · owner answer: you asked \"Merge now?\"."); putJsonArray("attachments") {}
            put("ownerAnswer", Wire.json.parseToJsonElement(answer))
        }, "t5")
        assertEquals(transcriptCards(echo).map { it.title to it.source }, turn.cards.map { it.title to it.source })
    }

    /** The queued row carries exactly the cards its echo will: the same projection over the same keys. */
    @Test fun aQueuedRowCarriesTheCardsItsEchoWillCarry() {
        val turn = queuedTail(rows("""[{"turnId":"t3","kind":"message","content":"x","attachments":[],"sessionReplies":[$reply],
            "taskStart":$taskStart}]"""), emptyList()).single()
        val echo = RunEvent("user", 0, buildJsonObject {
            put("text", "x"); putJsonArray("attachments") {}; put("taskStart", Wire.json.parseToJsonElement(taskStart))
            put("sessionReplies", Wire.json.parseToJsonElement("[$reply]"))
        }, "t3")
        assertEquals(transcriptCards(echo).map { it.title to it.source }, turn.cards.map { it.title to it.source })
    }

    @Test fun aSteerAndATurnWithNoIdTakeNoCancel() {
        val tail = queuedTail(rows("""[{"turnId":"t4","kind":"steer","content":"also check the logs","attachments":[]},
            {"kind":"message","content":"no id yet","attachments":[]}]"""), emptyList())
        assertEquals(listOf(false, false), tail.map { it.cancelable })
        assertTrue(tail[0].steer)
        assertTrue("an ordinary message is drawn as the words it will be", tail[1].cards.isEmpty())
    }

    @Test fun aTurnTheWindowHoldsAsDeliveredIsNotDrawnTwice() {
        val listed = rows("""[{"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b61","kind":"message","content":"hello","attachments":[]},
            {"turnId":"t6","kind":"message","content":"still waiting","attachments":[]}]""")
        val delivered = RunEvent("user", 9, buildJsonObject { put("text", "hello") }, "01A0CCA7-8609-70ED-A0E2-D4B55B832B61")
        assertEquals(listOf("t6"), queuedTail(listed, listOf(delivered)).map { it.turnId })
    }

    @Test fun anAcceptedHeadAndAReceiptAreNotTheQueuesTail() {
        val listed = rows("""[{"turnId":"a","kind":"message","content":"head","attachments":[],"placement":"accepted"},
            {"turnId":"b","kind":"steer","content":"lost","attachments":[],"delivery":"failed"},
            {"turnId":"c","kind":"message","content":"queued","attachments":[]}]""")
        assertEquals(listOf("c"), queuedTail(listed, emptyList()).map { it.turnId })
    }

    @Test fun aQueuedWakeIsTheLineItWillBe() {
        val blocks = "<scheduled-wakeup>\n  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:\n" +
            "    2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z\n    reason: waiting for CI run 4242\n" +
            "  The control plane recorded this for you; the user did not say it.\n</scheduled-wakeup>"
        val turn = queuedTail(listOf(buildJsonObject {
            put("turnId", "w1"); put("kind", "message"); put("content", blocks); putJsonArray("attachments") {}; put("authoredByOrbit", true)
        }), emptyList()).single()
        assertEquals("waiting for CI run 4242", turn.wake?.let { io.orbitd.android.core.cards.BackgroundWakeCard.lineName(it) })
        assertTrue(turn.cancelable)
    }
}
