package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * One conversation with both kinds of interrupt, as session 34dLFOCjLz8KqyCiaECec recorded them on 2026-10-13: the owner's
 * Stop (claude's interrupt names the Stop's request), then the runner restarting under a turn still in flight
 * (`reason: runner_restart`, runner-go's watchShutdownDrain). Only the second row is the runner's doing, and says so (web
 * and iOS say the same), and neither prints its payload under its title. The production session page over [ComposerShell];
 * the screen goes to a PNG under `src/android/build/evidence/interrupt-rows-android/` once the rows read right.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class InterruptRowsTest : ComposerShellTest() {
    private fun event(seq: Long, type: String, payload: String) = ComposerShell.obj("""{"type":"$type","seq":$seq,"payload":$payload}""")
    private fun row(seq: Long) = hasAnyAncestor(hasTestTag("event:$seq"))

    @Test fun anInterruptRowSaysWhetherTheRunnerRestartCutTheTurnOff() {
        ComposerShell.events = listOf(
            event(1, "user", """{"text":"Why was it sent twice?"}"""),
            event(2, "assistant", """{"text":"Reading the delivery path."}"""),
            event(3, "interrupt", """{"requestId":"req-22-1"}"""),
            event(4, "turn_end", """{"subtype":"interrupted"}"""),
            event(5, "user", """{"text":"Carry on."}"""),
            event(6, "assistant", """{"text":"Back on the delivery path."}"""),
            event(7, "interrupt", """{"reason":"runner_restart"}"""))
        signIn(); openSession()
        await { shows("Back on the delivery path.") }

        assertTrue("the Stop reads as one", has(hasText("Interrupted") and row(3), unmerged = true))
        assertFalse(has(hasText("runner restarted", substring = true) and row(3), unmerged = true))
        assertTrue("the restart says so", has(hasText("Interrupted — the runner restarted") and row(7), unmerged = true))
        // Each title is its whole row: neither payload is printed under it, as the rows once did, raw.
        for (raw in listOf("{\"requestId\"", "req-22-1", "{\"reason\"", "runner_restart"))
            assertFalse("$raw is on screen", has(hasText(raw, substring = true), unmerged = true))
        shot("interrupt-rows")
    }

    /** The screen as a PNG, and never a blank one, with the semantics tree beside it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val output = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory && File(it, "docs/evidence").isDirectory }
            .let { File(it, "src/android/build/evidence/interrupt-rows-android") }.also { it.mkdirs() }
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out (${view.width}×${view.height})", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank — the graphics mode drew nothing", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }
}
