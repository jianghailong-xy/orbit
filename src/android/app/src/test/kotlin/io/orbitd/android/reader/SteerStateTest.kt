package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Under a settled steer, how it came out (web `Transcript.tsx`'s `UserBubble` and `SteerState`, OrbitApp's meta line): its state in every
 * client's words under each of the reader's steers the conversation draws — and a steer known only from the server's receipt, drawn at
 * the end of the queued tail with why it did not land (web `WorkspaceView.tsx`'s `QueuedTurnMeta`).
 */
class SteerStateTest {
    private fun event(seq: Long, type: String, turn: String? = null, payload: String = "{}") =
        RunEvent(type, seq, Wire.json.parseToJsonElement(payload), turn)
    private fun steer(seq: Long, turn: String, text: String = "then push it to main", delivery: String = "written", extra: String = "") =
        event(seq, "user", turn, """{"text":"$text","steer":true,"delivery":"$delivery","withdrawable":true$extra}""")
    private fun delivery(seq: Long, turn: String, state: String, reason: String? = null) = event(seq, "user_delivery",
        payload = """{"turnId":"$turn","delivery":"$state"${reason?.let { ""","reason":"$it"""" }.orEmpty()}}""")
    private fun said(seq: Long, text: String) = event(seq, "assistant", payload = """{"text":"$text"}""")
    private val opening = event(1, "user", "t0", """{"text":"fix the export"}""")
    private fun objects(json: String) = Wire.json.parseToJsonElement(json).jsonArray.map { it.jsonObject }
    /** What the conversation draws, row by row: the words, and under one of the reader's steers how it came out. */
    private fun lines(events: List<RunEvent>, receipts: List<JsonObject> = emptyList(), holds: Boolean = true) =
        transcriptRows(events, receipts, holds).map { row -> row.event.body() + row.steer?.let { " · " + SteerDelivery.label(it.delivery) }.orEmpty() }

    @Test fun eachDeliverySaysItsStateInEveryClientsWords() {
        val said = linkedMapOf(null to "Sending…", "enqueued" to "Sending…", "written" to "Waiting to be read", "acknowledged" to "Read in this turn",
            "requeued" to "Queued for next turn instead", "failed" to "Not delivered", "unconfirmed" to "Couldn't confirm it was read",
            "a word this client does not know" to "Sending…")
        said.forEach { (delivery, words) -> assertEquals("$delivery", words, SteerDelivery.label(delivery)) }
        assertEquals("the warning tone: it did not land, or nobody can say it did", listOf("failed", "unconfirmed"),
            said.keys.filter(SteerDelivery::undelivered))
    }

    @Test fun aSettledSteerSaysHowItCameOutUnderItsWords() {
        for ((state, words) in listOf("acknowledged" to "Read in this turn", "failed" to "Not delivered", "unconfirmed" to "Couldn't confirm it was read")) {
            val events = listOf(opening, steer(2, "t1"), said(3, "still testing"), delivery(4, "t1", state), said(5, "done"))
            assertEquals(state, listOf("fix the export", "still testing", "then push it to main · $words", "done"), lines(events))
        }
        // Its echo can say so itself; and a delivery that did not land carries the runner's reason with it.
        assertEquals(listOf("fix the export", "then push it to main · Read in this turn"), lines(listOf(opening, steer(2, "t1", delivery = "acknowledged"))))
        val failed = listOf(opening, steer(2, "t1"), delivery(3, "t1", "failed", "the engine exited before reading it"))
        assertEquals(SteerOutcome("failed", "the engine exited before reading it"), transcriptRows(failed).last().steer)
    }

    @Test fun theLatestWordOnItIsTheOneSaid() {
        val events = listOf(opening, steer(2, "t1", delivery = "enqueued"), delivery(3, "t1", "written"), said(4, "reading"), delivery(5, "t1", "acknowledged"))
        assertEquals(SteerOutcome("acknowledged"), transcriptRows(events).single { it.event.seq == 2L }.steer)
        // A delivery names its turn in any spelling.
        val turn = "01a0cca7-8609-70ed-a0e2-d4b55b832b71"
        val spelled = listOf(opening, steer(2, turn.uppercase()), delivery(3, ObjectId.toPublic(turn), "acknowledged"))
        assertEquals("acknowledged", transcriptRows(spelled).last().steer?.delivery)
    }

    @Test fun theServersReceiptSaysHowOneNoRunnerSpokeForCameOut() {
        val turn = "01a0cca7-8609-70ed-a0e2-d4b55b832b72"
        val events = listOf(opening, steer(2, turn), said(3, "working"))
        val receipts = objects("""[{"turnId":"${turn.uppercase()}","kind":"steer","placement":"steer","content":"then push it to main",
            "attachments":[],"delivery":"failed","deliveryCode":"CURRENT_WORK_TARGET_COMPLETED",
            "deliveryReason":"the target turn completed before CURRENT_WORK could be delivered"}]""")
        assertEquals(listOf("fix the export", "working", "then push it to main · Not delivered"), lines(events, receipts))
        assertEquals("the server's reason rides with it", "the target turn completed before CURRENT_WORK could be delivered",
            transcriptRows(events, receipts).last().steer?.reason)
        // The runner's own word that it failed is the one said, never the receipt over it — and the tail draws neither.
        val told = events + delivery(4, turn, "failed", "the engine exited")
        assertEquals(SteerOutcome("failed", "the engine exited"), transcriptRows(told, receipts).last().steer)
        assertTrue(undeliveredTail(receipts, told).isEmpty())
    }

    @Test fun onlyTheReadersOwnSteersSayHowTheyCameOut() {
        val wake = "<background-job-wake>\n    bgj_fixture｜job｜echo done｜Check result\n      ended｜completed｜exit code 0\n      output tail:\n        done\n</background-job-wake>"
        val events = listOf(
            // A message, not a steer: its reply answers it.
            event(1, "user", "t0", """{"text":"fix the export","delivery":"acknowledged"}"""),
            // Another session's message, a job's wake written into the turn, and a task's brief: none of them the reader's words.
            steer(2, "t1", text = "from elsewhere", delivery = "acknowledged", extra = ""","sessionMessage":{"fromSessionId":"session-2","fromTitle":"There"}"""),
            steer(3, "t2", text = "", delivery = "acknowledged", extra = ""","controlPlaneNote":${JsonPrimitive(wake)}"""),
            steer(4, "t3", text = "a brief", delivery = "failed", extra = ""","taskStart":{"taskId":"task-1","title":"Ship it"}"""))
        assertEquals(listOf(1L, 2L, 3L, 4L), transcriptRows(events).map { it.event.seq })
        assertTrue(transcriptRows(events).all { it.steer == null })
    }

    @Test fun aWindowShortOfTheTailSaysHowEachOfItsSteersStands() {
        val events = listOf(opening, steer(2, "t1"), said(3, "an older reply"), steer(4, "t2", text = "and tag it", delivery = "withdrawn"))
        assertEquals("one the engine dropped unread says nothing", listOf("fix the export", "then push it to main · Waiting to be read",
            "an older reply", "and tag it"), lines(events, holds = false))
    }

    @Test fun aSteerKnownOnlyFromItsReceiptIsDrawnAtTheTailsEndWithWhyItDidNotLand() {
        val failed = "01a0cca7-8609-70ed-a0e2-d4b55b832b73"
        val unconfirmed = "01a0cca7-8609-70ed-a0e2-d4b55b832b74"
        val rows = objects("""[
            {"turnId":"q1","kind":"message","placement":"queued","content":"a brief","attachments":[],"authoredByOrbit":true},
            {"turnId":"$failed","kind":"steer","placement":"steer","content":"and tag the release","attachments":[],"delivery":"failed",
              "deliveryCode":"CURRENT_WORK_TARGET_COMPLETED","deliveryReason":"the target turn completed before CURRENT_WORK could be delivered"},
            {"turnId":"$unconfirmed","kind":"steer","placement":"steer","content":"and write the notes","attachments":[],"delivery":"unconfirmed",
              "deliveryCode":"CURRENT_WORK_SESSION_REAPED"},
            {"turnId":"r1","kind":"steer","placement":"steer","content":"from elsewhere","attachments":[],"delivery":"failed",
              "sessionMessage":{"fromSessionId":"s-2","fromTitle":"There"}},
            {"turnId":"r2","kind":"steer","placement":"steer","content":"an acceptance round","attachments":[],"delivery":"failed","authoredByOrbit":true}]""")
        val events = listOf(opening, said(2, "working"))
        val tail = undeliveredTail(rows, events)
        assertEquals("the reader's own, never what Orbit filed", listOf(failed, unconfirmed), tail.map { it.turnId })
        assertEquals(listOf("and tag the release", "and write the notes"), tail.map { it.event.fields.string("text") })
        assertEquals(listOf("Not delivered", "Couldn't confirm it was read"), tail.map { SteerDelivery.label(it.delivery) })
        assertEquals(listOf("The turn finished before it was read.", "The runner disappeared while it was being delivered."),
            tail.map { SteerDelivery.failureExplanation(it.deliveryCode, it.deliveryReason) })
        assertEquals("the server's reason too", "the target turn completed before CURRENT_WORK could be delivered", tail[0].deliveryReason)
        assertFalse("not the tray's: it has an outcome", tail.any { it.inTray })
        assertFalse("nothing to cancel", tail.any { it.cancelable })
        assertEquals("nor a row of the queue's", listOf("q1"), queuedTail(rows, events).map { it.turnId })
        // Once the window holds its echo — or its runner's word that it was not delivered — that is what says how it came out.
        assertEquals(listOf(unconfirmed), undeliveredTail(rows, events + steer(3, failed.uppercase(), text = "and tag the release")).map { it.turnId })
        assertEquals(listOf(failed), undeliveredTail(rows, events + delivery(3, ObjectId.toPublic(unconfirmed), "unconfirmed")).map { it.turnId })
    }
}
