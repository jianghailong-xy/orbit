package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.toast.OrbitToasts
import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode

/**
 * The tray above the composer on the session page (docs/mocks/steer-tray, decided 2026-10-16; OrbitKit PendingTrayWiringTests), over
 * the controlled server: a message sent while a turn runs waits there and enters the conversation only when the model reads it; a
 * queued message can be Steered into the running turn; withdrawing one returns its words to the composer; and Send, held while a turn
 * runs, queues the message for the next turn instead.
 */
class PendingTrayShellTest : ComposerShellTest() {
    private val steerId = "01a0cca7-8609-70ed-a0e2-d4b55b832b81"
    private val queuedId = "01a0cca7-8609-70ed-a0e2-d4b55b832b82"
    private val tray = hasAnyAncestor(hasTestTag("pending-tray"))
    private val conversation = hasAnyAncestor(hasTestTag("transcript-list"))
    private val turns = "POST sessions/${ComposerShell.SESSION}/turns"

    /** A turn running on [engine]: the reader's steer written into it, which nothing has read yet, and a message queued behind it. */
    private fun running(engine: String = "claude") {
        ComposerShell.session = ComposerShell.fields("""{"status":"RUNNING","runState":"RUNNING","engine":"$engine","provider":"$engine"}""")
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","ts":"2026-10-16T09:40:00.000Z","payload":{"text":"Fix the export"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Running the suite"}}"""),
            ComposerShell.obj("""{"type":"user","seq":3,"turnId":"$steerId","ts":"2026-10-16T09:41:00.000Z",
                "payload":{"text":"then push it to main","steer":true,"delivery":"written","withdrawable":true}}"""))
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[{"turnId":"$queuedId","kind":"message",
            "placement":"queued","content":"and update the changelog","attachments":[],"createdAt":"2026-10-16T09:42:00.000Z"}]""".encodeToByteArray()) }
    }

    private fun input() = compose.onNodeWithTag("composer-input").fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    @Test fun whatNothingHasReadWaitsInTheTrayAndEntersTheConversationWhereItIsRead() {
        running(); signIn(); openSession()
        await { has(hasText("and update the changelog") and tray) }
        assertTrue(has(hasText("then push it to main") and tray))
        assertTrue(has(hasText("Waiting to be read") and tray))
        assertTrue(has(hasText("Queued for next turn") and tray))
        assertFalse("not part of the conversation yet", has(hasText("then push it to main") and conversation))
        assertFalse("nor of the queue's tail", has(hasTestTag("queued:$queuedId")))
        val trayBottom = compose.onNodeWithTag("pending-tray").fetchSemanticsNode().boundsInRoot.bottom
        assertTrue("directly above the composer", trayBottom <= compose.onNodeWithTag("session-composer").fetchSemanticsNode().boundsInRoot.top)

        // Claude reads it at its next boundary: it leaves the tray, and is drawn after what was written before the reading.
        ComposerShell.push("""{"type":"assistant","seq":4,"turnId":"t-0","payload":{"text":"The suite passed"}}""")
        ComposerShell.push("""{"type":"user_delivery","seq":5,"turnId":"t-0","payload":{"turnId":"$steerId","delivery":"acknowledged"}}""")
        await { has(hasText("then push it to main") and conversation) }
        assertFalse(has(hasText("then push it to main") and tray))
        val order = compose.onNodeWithTag("transcript-list").fetchSemanticsNode().children.map { it.config.getOrNull(SemanticsProperties.TestTag) }
        assertTrue("after the reply written before it was read: $order", order.indexOf("event:3") > order.indexOf("event:4"))
    }

    @Test fun steerSendsAQueuedMessageIntoTheRunningTurn() {
        running(); signIn(); openSession()
        await { has(hasTestTag("pending-tray-steer")) }
        assertEquals("only the queued row offers it", 1, compose.onAllNodesWithTag("pending-tray-steer").fetchSemanticsNodes().size)
        compose.onNodeWithTag("pending-tray-steer").performClick()
        await { ComposerShell.calls.contains("POST sessions/${ComposerShell.SESSION}/turns/$queuedId/steer") }
        // On its way into the turn now: nothing to press but its Withdraw.
        await { !has(hasTestTag("pending-tray-steer")) }
        assertEquals(2, compose.onAllNodes(hasText("Sending…") and tray or (hasText("Waiting to be read") and tray)).fetchSemanticsNodes().size)
        assertFalse(has(hasText("Queued for next turn") and tray))
    }

    @Test fun aRefusedSteerSaysWhyAndTheMessageStaysQueued() {
        running()
        ComposerShell.answers["POST sessions/${ComposerShell.SESSION}/turns/$queuedId/steer"] = { ApiResponse(409, """{"statusCode":409,
            "code":"CURRENT_WORK_UNAVAILABLE","reason":"STEER_UNSUPPORTED","message":"this runtime or runner does not support acknowledged CURRENT_WORK delivery"}"""
            .encodeToByteArray()) }
        signIn(); openSession()
        OrbitToasts.clear()
        await { has(hasTestTag("pending-tray-steer")) }
        compose.onNodeWithTag("pending-tray-steer").performClick()
        await { OrbitToasts.feed.value.transient?.message == "Couldn't send it into this turn" }
        assertEquals("This agent can't take a message mid-turn. It stays queued for the next turn.", OrbitToasts.feed.value.transient?.detail)
        await { has(hasTestTag("pending-tray-steer")) }
        assertTrue(has(hasText("Queued for next turn") and tray))
    }

    @Test fun withdrawingAMessageReturnsItsWordsToTheComposerUnderTheDraft() {
        running(); signIn(); openSession()
        await { has(hasTestTag("pending-tray-withdraw")) }
        compose.onNodeWithTag("composer-input").performTextInput("a draft")
        await { input() == "a draft" }
        // The steer's trash: the first row, the first one sent.
        compose.onAllNodesWithTag("pending-tray-withdraw")[0].performClick()
        await { ComposerShell.calls.contains("DELETE sessions/${ComposerShell.SESSION}/turns/$steerId") }
        await { input() == "a draft\n\nthen push it to main" }
        assertFalse("taken back, it leaves the tray", has(hasText("then push it to main") and tray))
        assertTrue(has(hasText("and update the changelog") and tray))
        // And the queued message the same way, by the queue's door.
        compose.onNodeWithTag("pending-tray-withdraw").performClick()
        await { ComposerShell.calls.contains("DELETE sessions/${ComposerShell.SESSION}/turns/$queuedId") }
        await { input() == "a draft\n\nthen push it to main\n\nand update the changelog" }
        await { !has(hasTestTag("pending-tray")) }
    }

    @Test fun sendHeldWhileATurnRunsQueuesTheMessageForTheNextTurn() {
        running(); signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("and tag the release")
        await { has(hasTestTag("composer-send") and isEnabled() and hasText("Send")) }
        compose.onNodeWithTag("composer-send").performTouchInput { longClick() }
        await { has(hasTestTag("composer-queue-next-turn")) }
        assertTrue(shows("Queue for next turn"))
        assertNull("the hold is not a send as well", ComposerShell.body(turns))
        compose.onNodeWithTag("composer-queue-next-turn").performClick()
        await { ComposerShell.body(turns) != null }
        assertEquals("NEXT_TURN", ComposerShell.body(turns)!!.text("intent"))
        assertEquals("and tag the release", ComposerShell.body(turns)!!.text("content"))

        // A tap sends as it always has, and the server places it.
        await { input() == "" }
        compose.onNodeWithTag("composer-input").performTextInput("and write the notes")
        await { has(hasTestTag("composer-send") and isEnabled() and hasText("Send")) }
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.bodies.count { it.first == turns } == 2 }
        assertNull(ComposerShell.body(turns)!!["intent"])
    }

    /** Kimi, DeepSeek Harness, OpenCode and Antigravity take no message mid-turn: nothing offers to send one into the turn, nor to queue
     * one instead of it. */
    @Test fun anEngineThatTakesNoMessageMidTurnOffersNeitherWay() {
        running(engine = "kimi"); signIn(); openSession()
        await { has(hasText("and update the changelog") and tray) }
        assertFalse(has(hasTestTag("pending-tray-steer")))
        compose.onNodeWithTag("composer-input").performTextInput("and tag the release")
        await { has(hasTestTag("composer-send") and isEnabled() and hasText("Send")) }
        compose.onNodeWithTag("composer-send").performTouchInput { longClick() }
        compose.waitForIdle()
        assertFalse(has(hasTestTag("composer-queue-next-turn")))
    }

    /** The tray as a phone draws it — a steer waiting to be read, a queued message with its picture, a queued command — and Send's
     * offer while a turn runs, as PNGs under app/build/evidence/steer-tray (not committed; the board's ⑥,
     * docs/mocks/steer-tray/05b-proposal-phone.png). A shot that drew nothing fails. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theTrayAsAPhoneDrawsIt() {
        running()
        val picture = "01a0cca7-8609-70ed-a0e2-d4b55b832b91"
        ComposerShell.attachments = mapOf(picture to ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF4F7DF3.toInt()) }.compress(Bitmap.CompressFormat.PNG, 100, out)
        }.toByteArray())
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[
            {"turnId":"$queuedId","kind":"message","placement":"queued","content":"and update the changelog once the release is out",
              "attachments":[{"id":"$picture","mimeType":"image/png"}],"createdAt":"2026-10-16T09:42:00.000Z"},
            {"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b83","kind":"shell","placement":"queued","content":"npm test",
              "attachments":[],"createdAt":"2026-10-16T09:43:00.000Z"}]""".encodeToByteArray()) }
        signIn(); openSession()
        await { has(hasText("!npm test") and tray) }
        await { ComposerShell.calls.any { it.startsWith("GET attachments/") } }
        shot("tray")
        compose.onNodeWithTag("composer-input").performTextInput("and tag the release")
        await { has(hasTestTag("composer-send") and isEnabled() and hasText("Send")) }
        compose.onNodeWithTag("composer-send").performTouchInput { longClick() }
        await { has(hasTestTag("composer-queue-next-turn")) }
        shot("queue-for-next-turn")
        // The offer is a menu in a window of its own, which the page's own shot does not hold: that window drawn the same way.
        val menu = (compose.onNode(isPopup()).fetchSemanticsNode().root as ViewRootForTest).view.rootView
        save("queue-for-next-turn-menu", Bitmap.createBitmap(menu.width, menu.height, Bitmap.Config.ARGB_8888).also { menu.draw(Canvas(it)) })
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        save(name, bitmap)
    }

    private fun save(name: String, bitmap: Bitmap) {
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/steer-tray/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
    }
}
