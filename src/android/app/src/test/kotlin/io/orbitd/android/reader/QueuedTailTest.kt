package io.orbitd.android.reader

import io.orbitd.android.cards.AnsweredQuestions
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.CardFamily
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
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

    /** A08-14: a watch's wake waiting for a runner is the watch's line, read off its own content, and it can be withdrawn. */
    @Test fun aQueuedWatchWakeIsItsLine() {
        val wake = "Orbit Watch w1 matched at generation 1: ALL TASK_DONE 1/1\nThis turn was queued by the watch, not typed by a person.\n" +
            "```json\n{\"watchId\":\"w1\",\"changedTargets\":[{\"kind\":\"TASK\",\"id\":\"t-1\",\"observed\":{\"status\":\"DONE\"}}]}\n```"
        val turn = queuedTail(rows("""[{"turnId":"t9","kind":"message","content":${JsonPrimitive(wake)},"attachments":[]}]"""), emptyList()).single()
        assertEquals("w1", turn.watch?.text("watchId"))
        assertEquals("MATCHED", turn.watch?.text("state"))
        assertNull("not a background job's wake", turn.wake)
        assertTrue(turn.cancelable)
        assertNull(queuedTail(rows("""[{"turnId":"t8","kind":"message","content":"just words","attachments":[]}]"""), emptyList()).single().watch)
    }

    @Test fun aQueuedTaskStartIsItsCard() {
        val turn = queuedTail(rows("""[{"turnId":"t2","kind":"message","content":"the brief","attachments":[],"taskStart":$taskStart,
            "authoredByOrbit":true}]"""), emptyList()).single()
        val card = turn.cards.single()
        assertEquals("Task started", card.title)
        assertEquals("runner + web：配额按账户归属", card.source.text("title"))
        assertTrue(turn.cancelable)
    }

    /** The ended questions a coordinator conversation holds, as its rail's records. */
    private fun records(vararg items: String): List<InteractionCard> = CardCatalog.project("s1", "p1", mapOf(
        "project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") {}; putJsonArray("closedQuestions") { items.forEach { item -> addJsonObject {
            put("itemId", item); putJsonObject("question") { put("question", "Merge now?"); putJsonArray("options") {} }
            put("resolution", "ANSWERED"); put("resolvedBy", "USER"); put("resolvedAt", "2026-10-09T00:29:36.828Z")
            putJsonObject("answer") { put("option", JsonNull); put("text", "Wait") }; put("delivery", JsonNull)
        } } } }))
    private fun ownerAnswer(item: String, kind: String = "COORDINATOR_QUESTION") = """{"itemId":"$item","kind":"$kind",
        "sessionId":"01a0d6a9-d763-70e1-b4cf-8793e971b512","deliveredAt":"2026-10-09T00:29:37.104Z"}"""

    /** The owner's answer handed to the coordinator waits as what its echo will be. Drawn as its line, it can be withdrawn like any queued
     * turn; drawn as its question's card, where the conversation holds the question, it has no way out (OwnerAnswerLineViewTest), and the
     * conversation's rail leaves that card to it. */
    @Test fun aQueuedOwnerAnswerIsWhatItsEchoWillBe() {
        val answer = ownerAnswer("01a0d6a9-d763-70e1-b4cf-8793e971b511")
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
        val record = records("01a0d6a9-d763-70e1-b4cf-8793e971b511").single()
        val answered = AnsweredQuestions(listOf(record), listOf(turn.event)) {}
        assertSame("the queued turn draws its question's card", record, answered.record(card.source))
        assertTrue("so the rail does not draw it again", answered.leftToItsTurn(record))
        assertSame("and its review folds what this turn told the coordinator", turn.event, answered.told(record))
    }

    /** Which questions the turns hand over (web `answersHandedOver`): an answer echoed or still on the queue, its item matched whichever
     * spelling each read was served — never a Not yet… to a request to record the project done, which has no card, nor an ownerAnswer
     * on anything but a user turn. A record no turn names stays the rail's, and a question no record holds is no card. */
    @Test fun theQuestionsTheTurnsHandOverAreTheirsToDraw() {
        val echoed = "01a0d6a9-d763-70e1-b4cf-8793e971b511"
        val queuedItem = "01a0d6a9-d763-70e1-b4cf-8793e971b5aa"
        val notYet = "01a0d6a9-d763-70e1-b4cf-8793e971b5bb"
        val agents = "01a0d6a9-d763-70e1-b4cf-8793e971b5cc"
        val untold = "01a0d6a9-d763-70e1-b4cf-8793e971b5dd"
        // The open-items read names the echoed item by its public id; the turn's card carries the UUID.
        val held = records(ObjectId.toPublic(echoed), queuedItem, notYet, agents, untold)
        fun turn(type: String, answer: String) = RunEvent(type, 9, buildJsonObject {
            put("text", "From Orbit · owner answer"); put("ownerAnswer", Wire.json.parseToJsonElement(answer)) }, "t-$type")
        val queued = queuedTail(rows("""[{"turnId":"t7","kind":"message","content":"told","attachments":[],"ownerAnswer":${ownerAnswer(queuedItem)},
            "authoredByOrbit":true},{"turnId":"t8","kind":"message","content":"plain","attachments":[]}]"""), emptyList())
        val answered = AnsweredQuestions(held, listOf(turn("user", ownerAnswer(echoed)), turn("user", ownerAnswer(notYet, "DONE_REQUEST")),
            turn("assistant", ownerAnswer(agents))) + queued.map { it.event }) {}
        val byItem = held.associateBy { it.objectId }
        assertEquals(setOf(ObjectId.toPublic(echoed), queuedItem), held.filter(answered::leftToItsTurn).map { it.objectId }.toSet())
        assertSame(byItem[ObjectId.toPublic(echoed)], answered.record(Wire.json.parseToJsonElement(ownerAnswer(echoed)).jsonObject))
        assertNull("a question no record holds is no card", answered.record(Wire.json.parseToJsonElement(
            ownerAnswer("01a0d6a9-d763-70e1-b4cf-8793e971b5ee")).jsonObject))
        assertNull("a record no turn names folds no words", answered.told(byItem.getValue(untold)))
    }

    /** A fact told to this session waits as the line its echo will be, can be withdrawn like any queued turn, and is nobody's words: the
     * tray does not hold it, and a receipt that it failed hands nothing back to the composer. */
    @Test fun aQueuedCoordinatorDeliveryIsItsLine() {
        val delivery = """{"kind":"DEPENDENT_READY","task":{"id":"01a0d6a9-d763-70e1-b4cf-8793e971b511","title":"Wiki queue"},
            "revision":null,"count":null,"deliveredAt":"2026-10-31T11:30:00.000Z"}"""
        val told = "From Orbit · project “Runner link v1” has a downstream task that can start now"
        val turn = queuedTail(rows("""[{"turnId":"t7","kind":"message","content":"$told","attachments":[],
            "coordinatorDelivery":$delivery,"authoredByOrbit":true}]"""), emptyList()).single()
        val card = turn.cards.single()
        assertTrue(card.key.endsWith(":coordinatorDelivery"))
        assertEquals("Can start now: Wiki queue", card.title)
        assertEquals(told, turn.event.fields.text("text"))
        assertTrue(turn.cancelable)
        assertFalse("nobody typed it", turn.readersOwn)
        assertFalse(turn.inTray)
        val echo = RunEvent("user", 0, buildJsonObject {
            put("text", told); putJsonArray("attachments") {}; put("coordinatorDelivery", Wire.json.parseToJsonElement(delivery))
        }, "t7")
        assertEquals(transcriptCards(echo).map { it.title to it.source }, turn.cards.map { it.title to it.source })
        assertTrue("a failed delivery is no words of the reader's to put back", undeliveredTail(rows("""[{"turnId":"t7","kind":"message",
            "content":"$told","attachments":[],"coordinatorDelivery":$delivery,"authoredByOrbit":true,"delivery":"failed"}]"""),
            emptyList()).isEmpty())
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

    // A07-14 (iOS 0588fe262; OrbitKit AcceptedTurnPlaceholderTests): the head the runner has taken, from `?view=active`.

    private val head = """{"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b71","kind":"message","placement":"accepted","content":"the brief",
        "attachments":[{"id":"att-1","mimeType":"image/png"}],"taskStart":$taskStart,"authoredByOrbit":true,"createdAt":"2026-10-15T02:00:00.000Z"}"""

    /** Drawn as its echo will be — the card it carries, its files — stamped with when it was filed; never a row of the queue's. */
    @Test fun theAcceptedHeadIsTheEchoItWillBeAndNoRowOfTheQueues() {
        val listed = rows("""[$head,{"turnId":"t-next","kind":"message","placement":"queued","content":"and then deploy","attachments":[]}]""")
        val drawn = acceptedHeads(listed, emptyList()).single()
        assertEquals("user", drawn.type)
        assertEquals("01a0cca7-8609-70ed-a0e2-d4b55b832b71", drawn.turnId)
        assertEquals("the head carries when it was filed until its echo brings the runner's", "2026-10-15T02:00:00.000Z", drawn.ts)
        val echo = RunEvent("user", 4, buildJsonObject {
            put("text", "the brief"); putJsonArray("attachments") { addJsonObject { put("id", "att-1"); put("mime", "image/png") } }
            put("taskStart", Wire.json.parseToJsonElement(taskStart))
        }, "01a0cca7-8609-70ed-a0e2-d4b55b832b71")
        assertEquals("the card it is drawn as is the card its echo is", transcriptCards(echo).map { it.title to it.source },
            transcriptCards(drawn).map { it.title to it.source })
        assertEquals(echo.fields["attachments"], drawn.fields["attachments"])
        assertEquals("the queue behind the head is drawn as it was", listOf("t-next"), queuedTail(listed, emptyList()).map { it.turnId })
    }

    /** Its echo takes its place: once the window holds the `user` event of its turn — any spelling of the id — it is not drawn again,
     * whatever a listing read before the echo still says. */
    @Test fun theEchoTakesOverTheHead() {
        val echo = RunEvent("user", 4, buildJsonObject { put("text", "the brief") }, "01A0CCA7-8609-70ED-A0E2-D4B55B832B71")
        assertTrue(acceptedHeads(rows("[$head]"), listOf(echo)).isEmpty())
    }

    /** A turn that ended waits on no echo; another turn ending leaves the head alone. */
    @Test fun theHeadGoesWithItsOwnTurnsEnd() {
        val listed = rows("[$head]")
        val before = RunEvent("turn_end", 3, buildJsonObject { put("subtype", "success") }, "t-0")
        assertEquals(1, acceptedHeads(listed, listOf(before)).size)
        val own = RunEvent("turn_end", 5, buildJsonObject { put("subtype", "success") }, "01a0cca7-8609-70ed-a0e2-d4b55b832b71")
        assertTrue(acceptedHeads(listed, listOf(before, own)).isEmpty())
    }

    /** A `!` command has no echo — the runner runs it as a Bash card — and a receipt is a steer that is over: neither is drawn. */
    @Test fun anAcceptedCommandAndAReceiptAreNoHead() {
        val listed = rows("""[{"turnId":"t-sh","kind":"shell","placement":"accepted","content":"ls -la","attachments":[]},
            {"turnId":"t-s","kind":"steer","placement":"accepted","content":"use staging","attachments":[],"delivery":"failed"}]""")
        assertTrue(acceptedHeads(listed, emptyList()).isEmpty())
        assertTrue(queuedTail(listed, emptyList()).isEmpty())
    }

    /** A07-14 with A08-14: one watch's wake, one row in two states. Queued, it is the tail's — its line, withdrawable — and no head;
     * once the runner has it, it is no row of the queue's (no Withdraw, not counted) but the accepted head, drawn as its echo will be:
     * the same line. Its echo ends both. */
    @Test fun aWatchWakeIsTheQueuesUntilTheRunnerTakesItThenTheAcceptedHead() {
        val wake = "Orbit Watch w1 matched at generation 1: ALL TASK_DONE 1/1\nThis turn was queued by the watch, not typed by a person.\n" +
            "```json\n{\"watchId\":\"w1\",\"changedTargets\":[{\"kind\":\"TASK\",\"id\":\"t-1\",\"observed\":{\"status\":\"DONE\"}}]}\n```"
        fun listed(placement: String) = rows("""[{"turnId":"t9","kind":"message","placement":"$placement","content":${JsonPrimitive(wake)},
            "attachments":[],"createdAt":"2026-10-15T02:00:00.000Z"}]""")
        val queued = queuedTail(listed("queued"), emptyList()).single()
        assertEquals("w1", queued.watch?.text("watchId"))
        assertTrue(queued.cancelable)
        assertTrue("queued, it is no head", acceptedHeads(listed("queued"), emptyList()).isEmpty())

        assertTrue("taken, it is no row of the queue's", queuedTail(listed("accepted"), emptyList()).isEmpty())
        val head = acceptedHeads(listed("accepted"), emptyList()).single()
        assertEquals("t9", head.turnId)
        assertEquals("the head is drawn as the same line", queued.watch, transcriptCards(head).single { it.key.endsWith(":watch") }.source)

        val echo = RunEvent("user", 4, buildJsonObject { put("text", wake) }, "t9")
        assertTrue(queuedTail(listed("queued"), listOf(echo)).isEmpty())
        assertTrue(acceptedHeads(listed("accepted"), listOf(echo)).isEmpty())
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
