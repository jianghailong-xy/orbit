package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import java.io.File
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/**
 * A session held by its runner's self-update, on its page in the production shell (board 5's phone, board 2 ② and ⑤ of
 * docs/mocks/runner-update-drain; web `RunnerUpdatingQueued` and `RunnerUpdatingTag`): with nothing sent yet the page says why,
 * centred, with how long it has waited; once the reader's message is there its foot row says `Queued · runner updating`, and the tag
 * opens the update's account. The list row the page reads it from is the server's (`queuedReason` rides on the list only). Shots go to
 * `$ORBIT_RUNNER_UPDATING_SHOTS`, or the module's `build/reports/runner-updating-shots`, which CI keeps with its reports.
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RunnerUpdatingShellTest : ComposerShellTest() {
    private val output: File by lazy {
        File(System.getenv("ORBIT_RUNNER_UPDATING_SHOTS") ?: "build/reports/runner-updating-shots").also { it.mkdirs() }
    }

    /** Board 2's case: studio-mac draining for 0.1.254 behind two turns, for 38 minutes and 5 seconds. */
    private fun held(updateNow: Boolean = false, stopping: Boolean = false) {
        // A runner that takes Update Now says so, with the release it drains for and the owner's turns in flight (GET /runners).
        val takesUpdateNow = if (!updateNow) "" else """"capabilities":["self-update-now/v1"],
            "selfUpdate":{"state":"waitingForIdle","phase":"draining","targetVersion":"0.1.254","turnsInFlight":2,"turnsAtDrain":2},
            "updateTurns":[{"id":"34A07cOtherSession0001","title":"Backfill missing shard rows","startedAt":"${Instant.now().minusSeconds(112 * 60L + 5)}"},
            {"id":"34A07cOtherSession0002","title":"Why are 11-08 metrics zero","startedAt":"${Instant.now().minusSeconds(47 * 60L + 5)}"}],"""
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"studio-mac","online":true,"status":"ONLINE",$takesUpdateNow
            "version":"0.1.253","engines":[{"engine":"claude","installed":true,"auth":"yes"}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}}""")
        val since = Instant.now().minusSeconds(38 * 60L + 5).toString()
        ComposerShell.session = ComposerShell.fields("""{"title":"Why is the send stuck on the queue","status":"PENDING","runStatus":"PENDING",
            "runState":"QUEUED","queuedReason":"runner_updating","queuedActive":2,"queuedLimit":null,
            "queuedRunnerUpdate":{"stopping":$stopping,"targetVersion":"0.1.254","since":"$since","turns":[{"id":"34A07cOtherSession0001","title":"Backfill missing shard rows"},
            {"id":"34A07cOtherSession0002","title":"Why are 11-08 metrics zero"}]}}""")
    }

    private val description = "studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows " +
        "and Why are 11-08 metrics zero. This session starts right after."

    private fun text(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        .config[SemanticsProperties.Text].joinToString("") { it.text }

    @Test fun anEmptyConversationSaysWhyCentred() {
        held(); signIn(); openSession()
        await { has(hasTestTag("runner-updating"), unmerged = true) }
        assertEquals("Runner updating", text("runner-updating:title"))
        assertEquals(description, text("runner-updating:description"))
        assertEquals("Waiting 38 min", text("runner-updating:waited"))
        assertFalse("no foot row with no message to put it under", has(hasTestTag("runner-updating-foot"), unmerged = true))
        assertFalse(shows("No messages yet"))
        // Later… is on the page for the session's runner; Update Now… only for a runner that takes it, which this one does not say.
        assertTrue(shows("Later…")); assertFalse(shows("Update Now…"))
        shot("android-runner-updating-empty")
    }

    /** Board 5's left phone, then its confirmation: the runner takes Update Now, so the page offers it beside Later…. */
    @Test fun aRunnerThatTakesUpdateNowIsOfferedItWithItsTurns() {
        held(updateNow = true); signIn(); openSession()
        await { has(hasTestTag("runner-updating"), unmerged = true) && shows("Update Now…") }
        assertTrue(shows("Later…"))
        shot("android-runner-updating-update-now")
        compose.onNodeWithTag("runner-update-now").performClick()
        await { has(hasTestTag("runner-update-now-sheet:title"), unmerged = true) }
        assertEquals("Update studio-mac now?", text("runner-update-now-sheet:title"))
        assertEquals("It stops these turns, installs 0.1.254 and restarts — usually under a minute. Each one then continues where it stopped, " +
            "with a note that the update interrupted it.", text("runner-update-now-sheet:message"))
        assertTrue(has(hasText("Backfill missing shard rows")) && has(hasText("running 1 h 52 min")) && has(hasText("running 47 min")))
        compose.onNodeWithTag("runner-update-now:confirm").assertTextEquals("Interrupt 2 Turns and Update")
    }

    /** Board runner-stopping ①: a runner that is stopping, not updating, says so, and offers neither Later… nor Update Now…, even one
     *  that takes Update Now. */
    @Test fun aRunnerThatIsStoppingOffersNeitherLaterNorUpdateNow() {
        held(updateNow = true, stopping = true); signIn(); openSession()
        await { has(hasTestTag("runner-updating"), unmerged = true) }
        assertEquals("Runner stopping", text("runner-updating:title"))
        assertEquals("studio-mac is stopping. It starts no new work until 2 turns finish: Backfill missing shard rows " +
            "and Why are 11-08 metrics zero. This session starts once studio-mac is back.", text("runner-updating:description"))
        assertFalse(shows("Later…")); assertFalse(shows("Update Now…"))
    }

    @Test fun theHeldMessagesFootRowSaysWhyAndOpensTheAccount() {
        held()
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"${Instant.now().minusSeconds(38 * 60L)}",
            "payload":{"text":"Why is the send stuck? It has said Queued for half an hour."}}"""))
        signIn(); openSession()
        await { has(hasTestTag("runner-updating-foot"), unmerged = true) }
        val foot = compose.onNodeWithTag("runner-updating-foot", useUnmergedTree = true).onChildren().fetchSemanticsNodes()
            .map { it.config[SemanticsProperties.Text].joinToString("") { t -> t.text } }
        assertEquals(listOf("Queued", "·", "runner updating"), foot)
        assertFalse("the foot row says it, not the page's block", has(hasTestTag("runner-updating"), unmerged = true))
        shot("android-runner-updating")
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        await { has(hasTestTag("runner-updating-pop"), unmerged = true) }
        assertEquals("studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.\nWaiting 38 min.",
            text("runner-updating-pop:text"))
        assertTrue(has(hasText("Runner updating") and hasAnyAncestor(isDialog())))
        draw("android-runner-updating-popover", compose.activity.window.decorView, ShadowDialog.getLatestDialog()!!.window!!.decorView)
    }

    private fun shot(name: String) = draw(name, compose.activity.window.decorView)

    /** The views as one PNG, each at its place on screen, and never a blank one. */
    private fun draw(name: String, vararg views: android.view.View) {
        compose.waitForIdle()
        val base = views.first()
        assertTrue("$name: the view was never laid out", base.width > 0 && base.height > 0)
        val bitmap = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        views.forEach { view ->
            val at = IntArray(2).also(view::getLocationOnScreen)
            canvas.save(); canvas.translate(at[0].toFloat(), at[1].toFloat()); view.draw(canvas); canvas.restore()
        }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> ${File(output, "$name.png")}")
        bitmap.recycle()
    }
}
