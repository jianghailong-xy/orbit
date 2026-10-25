package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.toast.OrbitToasts
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode

/**
 * Under a settled steer on the session page, how it came out (web `UserBubble` and `QueuedTurnMeta`, OrbitApp's meta line), over the
 * controlled server: read, not delivered, or not known to be read — and the words of one that never reached the engine put back in the
 * composer under the draft, whether the transcript holds the steer or only the server's receipt does.
 */
class SteerOutcomeShellTest : ComposerShellTest() {
    private val receiptId = "01a0cca7-8609-70ed-a0e2-d4b55b832b85"
    private val receiptRow = hasAnyAncestor(hasTestTag("queued:" + (ObjectId.canonical(receiptId) ?: receiptId)))
    private val turns = "POST sessions/${ComposerShell.SESSION}/turns"
    private val putBack = hasTestTag("steer-state:put-back")

    /** Three of the reader's steers into a turn: one read, one not delivered, and one nobody can say was read. */
    private fun settled() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Fix the export"}}"""),
            steer(2, "t-1", "then push it to main"), delivery(3, "t-1", "acknowledged"),
            steer(4, "t-2", "and tag the release"), delivery(5, "t-2", "failed", "the engine exited before reading it"),
            steer(6, "t-3", "and write the notes"), delivery(7, "t-3", "unconfirmed"))
    }
    private fun steer(seq: Int, turn: String, text: String) = ComposerShell.obj(
        """{"type":"user","seq":$seq,"turnId":"$turn","payload":{"text":"$text","steer":true,"delivery":"written","withdrawable":true}}""")
    private fun delivery(seq: Int, turn: String, state: String, reason: String? = null) = ComposerShell.obj("""{"type":"user_delivery",
        "seq":$seq,"turnId":"t-0","payload":{"turnId":"$turn","delivery":"$state"${reason?.let { ""","reason":"$it"""" }.orEmpty()}}}""")

    /** A steer no runner echoed, known only from the server's receipt: not delivered, because the turn it was aimed at finished first. */
    private fun receipt() {
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Fix the export"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Exported"}}"""))
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[{"turnId":"$receiptId","kind":"steer",
            "placement":"steer","content":"and tag the release","attachments":[],"delivery":"failed","deliveryCode":"CURRENT_WORK_TARGET_COMPLETED",
            "deliveryReason":"the target turn completed before CURRENT_WORK could be delivered","createdAt":"2026-10-16T09:42:00.000Z"}]"""
            .encodeToByteArray()) }
    }

    private fun input() = compose.onNodeWithTag("composer-input").fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text
    private fun under(seq: Int) = hasAnyAncestor(hasTestTag("event:$seq"))
    /** The row of the event [seq] scrolled into view, once the transcript holds it, and [matcher] found under it. */
    private fun awaitUnder(seq: Int, matcher: SemanticsMatcher) = await {
        runCatching { compose.onNodeWithTag("transcript-list").performScrollToKey("event:$seq") }.isSuccess && has(matcher and under(seq))
    }

    @Test fun aSettledSteerSaysHowItCameOutUnderItsWords() {
        settled(); signIn(); openSession()
        awaitUnder(2, hasText("Read in this turn"))
        assertFalse("read: nothing to put back", has(putBack and under(2)))
        awaitUnder(6, hasText("Couldn't confirm it was read"))
        assertFalse("it may have been acted on: a resend would do the work twice", has(putBack and under(6)))
        awaitUnder(4, hasText("Not delivered"))
        assertTrue("never reached the engine: its words can come back", has(putBack and under(4)))
        // The runner's reason is a long press away.
        compose.onNode(hasText("Not delivered") and under(4)).performTouchInput { longClick() }
        awaitText("the engine exited before reading it")
        // The reader's own message is answered by its reply, and says nothing of its delivery.
        awaitUnder(1, hasText("Fix the export"))
        assertFalse(has(hasTestTag("steer-state") and under(1)))
    }

    @Test fun putBackReturnsTheWordsUnderTheDraftAndSendsNothing() {
        settled(); signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("a draft")
        await { input() == "a draft" }
        awaitUnder(4, putBack)
        compose.onNode(putBack and under(4)).performClick()
        await { input() == "a draft\n\nand tag the release" }
        compose.waitForIdle()
        assertNull("nothing is sent", ComposerShell.body(turns))
        assertFalse("nothing is discarded", ComposerShell.calls.any { it.startsWith("DELETE ") })
        assertTrue("the bubble stays, the record of what happened", has(hasText("and tag the release") and under(4)))
    }

    @Test fun aSteerKnownOnlyFromItsReceiptIsDrawnWithWhyAndDiscardedOnPutBack() {
        receipt(); signIn(); openSession()
        await { has(hasText("and tag the release") and receiptRow) }
        assertTrue(has(hasText("Not delivered") and receiptRow))
        assertTrue("why, in the sender's words", has(hasText("The turn finished before it was read.") and receiptRow))
        assertFalse("not the tray's: it has an outcome", has(hasTestTag("pending-tray")))
        compose.onNodeWithTag("composer-input").performTextInput("a draft")
        await { input() == "a draft" }
        compose.onNode(putBack and receiptRow).performClick()
        await { input() == "a draft\n\nand tag the release" }
        await { ComposerShell.calls.contains("DELETE sessions/${ComposerShell.SESSION}/turns/$receiptId") }
        await { !has(hasText("and tag the release") and receiptRow) }
        assertNull("nothing is sent", ComposerShell.body(turns))
    }

    @Test fun aDiscardTheServerRefusesIsSaidAndTheWordsStayInTheComposer() {
        receipt()
        ComposerShell.answers["DELETE sessions/${ComposerShell.SESSION}/turns/$receiptId"] = {
            ApiResponse(500, """{"statusCode":500,"message":"The queue could not be changed"}""".encodeToByteArray())
        }
        signIn(); openSession()
        OrbitToasts.clear()
        await { has(putBack and receiptRow) }
        compose.onNode(putBack and receiptRow).performClick()
        // A failure's toast stays up until it is dismissed.
        await { OrbitToasts.feed.value.front?.message == "Couldn't discard the message" }
        assertEquals("and tag the release", input())
        // Still the server's, so still drawn — with its way back.
        await { has(putBack and receiptRow) }
    }

    /** The lines as a phone draws them — under a read steer and one not delivered, and under a receipt at the tail's end — as a PNG
     * under app/build/evidence/steer-outcome (not committed). A shot that drew nothing fails. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun howASteerCameOutAsAPhoneDrawsIt() {
        receipt()
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Fix the export"}}"""),
            steer(2, "t-1", "then push it to main"), delivery(3, "t-1", "acknowledged"),
            steer(4, "t-2", "and write the notes"), delivery(5, "t-2", "failed", "the engine exited before reading it"))
        signIn(); openSession()
        await { has(hasText("The turn finished before it was read.") and receiptRow) }
        await { has(hasText("Read in this turn") and under(2)) && has(hasText("Not delivered") and under(4)) }
        shot("settled-and-receipt")
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/steer-outcome/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
    }
}
