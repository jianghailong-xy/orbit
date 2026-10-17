package io.orbitd.android.reader

import io.orbitd.android.composer.ComposerState
import io.orbitd.android.composer.PendingTray
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The tray above the composer (docs/mocks/steer-tray, decided 2026-10-16): the reader's messages nothing has read yet, out of the
 * conversation until the engine reads them, one row each. OrbitKit PendingTrayTests' cases; web `PendingTray.tsx`, `Transcript.tsx`'s
 * `UnreadSteer` and `WorkspaceView.tsx`'s `inPendingTray`.
 */
class PendingTrayTest {
    private fun event(seq: Long, type: String, turn: String? = null, payload: String = "{}", ts: String? = null) =
        RunEvent(type, seq, Wire.json.parseToJsonElement(payload), turn, ts)
    private fun steer(seq: Long, turn: String, text: String = "then push it to main", delivery: String = "written", withdrawable: Boolean = true,
        extra: String = "") = event(seq, "user", turn, """{"text":"$text","steer":true,"delivery":"$delivery","withdrawable":$withdrawable$extra}""",
        "2026-10-16T09:4$seq:00.000Z")
    private fun delivery(seq: Long, turn: String, state: String) = event(seq, "user_delivery", payload = """{"turnId":"$turn","delivery":"$state"}""")
    private fun said(seq: Long, text: String) = event(seq, "assistant", payload = """{"text":"$text"}""")
    private val opening = event(1, "user", "t0", """{"text":"fix the export"}""")
    private fun drawn(events: List<RunEvent>, receipts: List<JsonObject> = emptyList(), holds: Boolean = true) =
        transcriptRows(events, receipts, holds).map { "${it.event.type}:${it.event.body()}" }
    private fun unread(events: List<RunEvent>, receipts: List<JsonObject> = emptyList()) = SteerDelivery.place(events, receipts).unread
    private fun objects(json: String) = Wire.json.parseToJsonElement(json).jsonArray.map { it.jsonObject }

    // A steer waits in the tray until it is read.

    @Test fun aSteerNothingHasReadWaitsInTheTrayNotTheConversation() {
        val events = listOf(opening, steer(2, "t1"))
        assertEquals(listOf("user:fix the export"), drawn(events))
        assertEquals(listOf("t1"), unread(events).map { it.event.turnId })
        assertEquals("written", unread(events).single().delivery)
    }

    @Test fun onceReadItIsDrawnWhereItWasReadAfterWhatCameBefore() {
        val events = listOf(opening, steer(2, "t1"), said(3, "the suite is still running"), delivery(4, "t1", "acknowledged"),
            said(5, "pushing it to main"))
        assertTrue(unread(events).isEmpty())
        assertEquals(listOf("user:fix the export", "assistant:the suite is still running", "user:then push it to main",
            "assistant:pushing it to main"), drawn(events))
        assertEquals("its row is still its own record", "event:2", anchorRow(transcriptRows(events), 2)!!.key)
    }

    @Test fun oneFoundUndeliveredIsDrawnWhereThatBecameKnown() {
        for (state in listOf("failed", "unconfirmed")) {
            val events = listOf(opening, steer(2, "t1"), said(3, "still testing"), delivery(4, "t1", state), said(5, "done"))
            assertTrue(state, unread(events).isEmpty())
            assertEquals(state, listOf("user:fix the export", "assistant:still testing", "user:then push it to main", "assistant:done"), drawn(events))
        }
    }

    @Test fun oneTheEngineDroppedIsNeverDrawn() {
        val events = listOf(opening, steer(2, "t1"), said(3, "still testing"), delivery(4, "t1", "withdrawn"))
        assertTrue(unread(events).isEmpty())
        assertEquals(listOf("user:fix the export", "assistant:still testing"), drawn(events))
    }

    @Test fun oneHandedBackRunsAsATurnOfItsOwnAndIsDrawnOnce() {
        val handedBack = listOf(opening, steer(2, "t1"), delivery(3, "t1", "requeued"))
        assertEquals("queued now, still in the tray", listOf("requeued"), unread(handedBack).map { it.delivery })
        assertEquals(listOf("user:fix the export"), drawn(handedBack))

        val arrived = handedBack + said(4, "the suite is green") +
            event(5, "user", "t1", """{"text":"then push it to main","delivery":"enqueued"}""")
        assertTrue(unread(arrived).isEmpty())
        assertEquals(listOf("user:fix the export", "assistant:the suite is green", "user:then push it to main"), drawn(arrived))
        // Sent in again instead, it waits again — as the one steer, not two.
        val again = handedBack + steer(4, "t1", delivery = "enqueued")
        assertEquals(listOf(4L), unread(again).map { it.event.seq })
        assertEquals(listOf("user:fix the export"), drawn(again))
    }

    @Test fun aSteerOrbitFiledOrAnotherSessionSentStaysWhereItsEchoLands() {
        val wake = "<background-job-wake>\n    bgj_fixture｜job｜echo done｜Check result\n      ended｜completed｜exit code 0\n      output tail:\n        done\n</background-job-wake>"
        for (extra in listOf(""","sessionMessage":{"fromSessionId":"session-2","fromTitle":"the other session"}""",
            ""","controlPlaneNote":${JsonPrimitive(wake)}""")) {
            val events = listOf(opening, steer(2, "t1", text = "from elsewhere", extra = extra), said(3, "reading it"))
            assertTrue(extra, unread(events).isEmpty())
            assertEquals(extra, "event:2", transcriptRows(events)[1].key)
        }
    }

    @Test fun theServersReceiptSettlesOneNoRunnerWillSpeakFor() {
        val turn = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        val events = listOf(opening, steer(2, turn), said(3, "working"))
        val receipts = objects("""[{"turnId":"${turn.uppercase()}","kind":"steer","placement":"steer","content":"then push it to main",
            "attachments":[],"delivery":"unconfirmed"}]""")
        assertTrue(unread(events, receipts).isEmpty())
        assertEquals("at the end, where it became known", listOf("user:fix the export", "assistant:working", "user:then push it to main"),
            drawn(events, receipts))
        assertTrue("and no row of the queue's", queuedTail(receipts, events).isEmpty())
    }

    @Test fun aDeliveryNamesItsTurnInAnySpelling() {
        val turn = "01a0cca7-8609-70ed-a0e2-d4b55b832b62"
        val events = listOf(opening, steer(2, turn.uppercase()), said(3, "reading"), delivery(4, ObjectId.toPublic(turn), "acknowledged"))
        assertTrue(unread(events).isEmpty())
        assertEquals(listOf("user:fix the export", "assistant:reading", "user:then push it to main"), drawn(events))
    }

    @Test fun aWindowShortOfTheTailDrawsItsSteersWhereTheyWereSent() {
        val events = listOf(opening, steer(2, "t1"), said(3, "an older reply"))
        assertEquals(listOf("user:fix the export", "user:then push it to main", "assistant:an older reply"), drawn(events, holds = false))
    }

    // The rows.

    private fun queued(json: String) = queuedTail(objects(json), emptyList())
    private fun ids(vararg turns: String) = turns.map { ObjectId.canonical(it) ?: it }.toSet()

    @Test fun eachRowSaysWhereItIsGoingHowItStandsAndOffersOnlyWhatItCanDo() {
        val steers = unread(listOf(opening,
            // Claude: in its queue, and its runner said it can drop it unread.
            steer(2, "ta"),
            // Codex: has it, and cannot give it back.
            steer(3, "tb", text = "use the other endpoint", withdrawable = false)))
        val waiting = queued("""[
            {"turnId":"tc","kind":"message","placement":"queued","content":"and update the changelog","attachments":[],"createdAt":"2026-10-16T09:44:00.000Z"},
            {"turnId":"td","kind":"shell","placement":"queued","content":"npm test","attachments":[],"createdAt":"2026-10-16T09:45:00.000Z"},
            {"turnId":"te","kind":"steer","placement":"steer","content":"and tag the release","attachments":[],"createdAt":"2026-10-16T09:46:00.000Z"}]""")

        val rows = PendingTray.rows(steers, waiting, ComposerState(), steerOffered = true)
        assertEquals(listOf("ta", "tb", "tc", "td", "te"), rows.map { it.turnId })
        assertEquals(listOf(true, true, false, false, true), rows.map { it.intoTurn })
        assertEquals(listOf("Waiting to be read", "Waiting to be read", "Queued for next turn", "Queued for next turn", "Sending…"),
            rows.map { it.state })
        assertEquals(listOf(true, false, true, true, true), rows.map { it.offersWithdraw })
        assertEquals(listOf(false, false, true, false, false), rows.map { it.offersSteer })
        assertEquals("!npm test", rows[3].text)
        assertEquals("a withdrawn command comes back as the command it was", "!npm test", rows[3].restores)
        assertEquals("then push it to main", rows[0].restores)

        // Steer is offered only while a turn runs on an engine that can take a message into one.
        assertFalse(PendingTray.rows(steers, waiting, ComposerState(), steerOffered = false).any { it.offersSteer })
    }

    @Test fun aRowAPressIsOutForOffersNothingToPressTwice() {
        val steers = unread(listOf(opening, steer(2, "ta")))
        val waiting = queued("""[{"turnId":"tc","kind":"message","content":"and update the changelog","attachments":[],"createdAt":"2026-10-16T09:43:00.000Z"}]""")
        val rows = PendingTray.rows(steers, waiting, ComposerState(withdrawing = ids("ta"), steering = ids("tc")), steerOffered = true)
        assertEquals(listOf("Withdrawing…", "Sending…"), rows.map { it.state })
        assertEquals(listOf(true, true), rows.map { it.intoTurn })
        assertEquals(listOf(true, true), rows.map { it.busy })
        assertFalse(rows.any { it.offersWithdraw || it.offersSteer })
    }

    @Test fun whatTheServerConfirmedShowsBeforeTheListingSaysSo() {
        val waiting = queued("""[{"turnId":"tc","kind":"message","content":"and update the changelog","attachments":[],"createdAt":"2026-10-16T09:43:00.000Z"},
            {"turnId":"tf","kind":"message","content":"and write the notes","attachments":[],"createdAt":"2026-10-16T09:44:00.000Z"}]""")
        val rows = PendingTray.rows(emptyList(), waiting, ComposerState(steered = ids("tc"), withdrawn = ids("tf")), steerOffered = true)
        assertEquals("taken back, it is gone at once", listOf("tc"), rows.map { it.turnId })
        assertTrue("sent into the turn, on its way there", rows.single().intoTurn)
        assertEquals("Sending…", rows.single().state)
        assertFalse(rows.single().offersSteer)
        assertTrue("the server still holds it", rows.single().offersWithdraw)
        assertTrue("a refused withdrawal is a steer's", rows.single().steer)
    }

    @Test fun aHandedBackSteerIsQueuedWithNothingToPress() {
        val steers = unread(listOf(opening, steer(2, "ta"), delivery(3, "ta", "requeued")))
        val row = PendingTray.rows(steers, emptyList(), ComposerState(), steerOffered = true).single()
        assertFalse(row.intoTurn)
        assertEquals("Queued for next turn", row.state)
        assertFalse(row.offersWithdraw || row.offersSteer)
    }

    @Test fun theTrayHoldsOnlyTheReadersOwnWordsStillOnTheirWay() {
        val wake = "Orbit Watch w1 matched at generation 1: ALL TASK_DONE 1/1\nThis turn was queued by the watch, not typed by a person.\n" +
            "```json\n{\"watchId\":\"w1\",\"changedTargets\":[{\"kind\":\"TASK\",\"id\":\"t-1\",\"observed\":{\"status\":\"DONE\"}}]}\n```"
        val tail = queued("""[{"turnId":"a","kind":"message","content":"and update the changelog","attachments":[]},
            {"turnId":"b","kind":"message","content":"a brief","attachments":[],"authoredByOrbit":true},
            {"turnId":"c","kind":"message","content":"hello from there","attachments":[],"sessionMessage":{"fromSessionId":"s-2","fromTitle":"There"}},
            {"turnId":"d","kind":"message","content":${JsonPrimitive(wake)},"attachments":[]},
            {"turnId":"e","kind":"steer","placement":"steer","content":"never made it","attachments":[],"delivery":"failed"}]""")
        assertEquals("a receipt is no row of the queue's", listOf("a", "b", "c", "d"), tail.map { it.turnId })
        assertEquals("what Orbit queued keeps its card in the tail", listOf("a"), tail.filter { it.inTray }.map { it.turnId })
        assertEquals(listOf("a"), PendingTray.rows(emptyList(), tail, ComposerState(), steerOffered = true).map { it.turnId })
    }

    @Test fun aRowOfAttachmentsAloneSaysWhatItCarries() {
        assertEquals("1 image", PendingTray.summary(images = 1, files = 0))
        assertEquals("2 images, 1 file", PendingTray.summary(images = 2, files = 1))
        assertEquals("3 files", PendingTray.summary(images = 0, files = 3))
        val row = PendingTray.rows(emptyList(), queued("""[{"turnId":"ti","kind":"message","content":"","attachments":[
            {"id":"img-1","mimeType":"image/png"},{"id":"doc-1","mimeType":"application/pdf"}]}]"""), ComposerState(), steerOffered = true).single()
        assertEquals("1 image, 1 file", row.text)
        assertTrue(row.filesOnly)
        assertEquals("its thumbnail", "img-1", row.image)
        assertNull("nothing to hand back to the composer", row.restores)
    }

    @Test fun theRowsComeInTheOrderTheyWereSentAndOneJustSentIsTheNewest() {
        val steers = unread(listOf(opening, steer(5, "late")))
        val waiting = queued("""[{"turnId":"new","kind":"message","content":"just now","attachments":[]},
            {"turnId":"early","kind":"message","content":"before","attachments":[],"createdAt":"2026-10-16T09:41:00.000Z"}]""")
        assertEquals(listOf("early", "late", "new"), PendingTray.rows(steers, waiting, ComposerState(), steerOffered = true).map { it.turnId })
    }

    @Test fun onlyTheRuntimesThatTakeAMessageMidTurnOfferSteer() {
        assertTrue(SteerDelivery.runtimeTakesMidTurnSteer("claude"))
        assertTrue(SteerDelivery.runtimeTakesMidTurnSteer("codex"))
        for (runtime in listOf("kimi", "dsh", "opencode", "antigravity")) assertFalse(runtime, SteerDelivery.runtimeTakesMidTurnSteer(runtime))
    }

    @Test fun aSteerIsTakenBackOnlyWhileItsEngineCanDropItUnread() {
        assertTrue(SteerDelivery.offersWithdraw(null, withdrawable = true))
        assertTrue(SteerDelivery.offersWithdraw("enqueued", withdrawable = true))
        assertTrue(SteerDelivery.offersWithdraw("written", withdrawable = true))
        assertFalse(SteerDelivery.offersWithdraw("written", withdrawable = false))
        for (state in listOf("acknowledged", "failed", "unconfirmed", "withdrawn", "requeued")) assertFalse(state, SteerDelivery.offersWithdraw(state, true))
    }
}
