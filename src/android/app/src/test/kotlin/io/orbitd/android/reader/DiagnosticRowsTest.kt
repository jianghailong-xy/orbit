package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import java.io.File
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Codex model-catalog refresh that timed out ten times in one session (2026-10-28), on the production session page over
 * [ComposerShell], beside a notice and an unrelated ERROR line. The refresh is one row with its count, grey with only its mark in the
 * warning tone, as web draws `.chat-notice.chat-diagnostic` and iOS `DiagnosticNoticeRow`; the notice keeps the warning tone; the
 * ERROR stays red. The colours are read off the drawn pixels, and each theme's screen goes to a PNG under
 * `src/android/build/evidence/diagnostic-rows-android/`.
 */
abstract class DiagnosticRows : ComposerShellTest() {
    abstract val theme: String
    /** ui/OrbitTheme.kt's colours for the theme: `onSurfaceVariant`, `outline`, `OrbitColors.needsYou` and `error`. */
    abstract val grey: Int
    abstract val dim: Int
    abstract val warning: Int
    abstract val red: Int

    private fun event(seq: Long, type: String, payload: String) = ComposerShell.obj("""{"type":"$type","seq":$seq,"payload":$payload}""")
    private fun row(seq: Long) = hasAnyAncestor(hasTestTag("event:$seq"))
    private fun refreshFailed(minute: Int) =
        "2026-10-28T15:$minute:06.979719Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out"

    @Test fun aDiagnosticIsGreyBehindItsMarkWhileANoticeKeepsTheWarningTone() {
        val diagnostic = """{"component":"model_catalog","severity":"WARN","impact":"degraded","recoverable":true,"code":"timeout"}"""
        val notice = "Switched to Wikova · Pro — the 5-hour window on Zhang Min · Plus is spent"
        ComposerShell.events = listOf(
            event(1, "user", """{"text":"Which models can this session use?"}"""),
            event(2, "assistant", """{"text":"Reading the model catalog."}""")) +
            // As the session logged it: ten refreshes, the first five stored by an older runner, the rest with the diagnostic.
            (0 until 10).map { i ->
                event(3L + i, "system", """{"stderr":${JsonPrimitive(refreshFailed(13 + i))}${if (i >= 5) ""","diagnostic":$diagnostic""" else ""}}""")
            } + listOf(
            event(13, "system", """{"notice":${JsonPrimitive(notice)},"noticeKind":"pool-member-switched"}"""),
            event(14, "system", """{"stderr":"2026-10-28T15:23:07.112233Z ERROR codex_core::codex: stream error: request timed out"}"""),
            event(15, "assistant", """{"text":"The catalog is the one this session already had."}"""))
        signIn(); openSession()
        await { shows("The catalog is the one this session already had.") }

        // One row for the ten reports, in the first one's place: its label, the engine's words and the count.
        val label = hasText("model_catalog · timeout") and row(3)
        val words = hasText("failed to refresh available models: request timed out") and row(3)
        assertTrue(has(label, unmerged = true))
        assertTrue(has(words, unmerged = true))
        assertTrue(has(hasText("×10") and row(3), unmerged = true))
        assertFalse("the stamp, level and module are not on the row",
            has(hasText("codex_models_manager", substring = true) and row(3), unmerged = true))
        for (seq in 4L..12L) assertFalse("report $seq has no row of its own", has(hasTestTag("event:$seq")))

        val screen = draw()
        val noticeWords = hasText(notice) and row(13)
        val error = hasText("stream error: request timed out", substring = true) and row(14)
        assertTrue("the diagnostic's words are grey", grey in colours(screen, words))
        assertFalse("not in the warning tone", warning in colours(screen, words))
        assertTrue("its label is dim", dim in colours(screen, label))
        assertTrue("its mark keeps the warning tone", warning in colours(screen, hasTestTag("event:3")))
        assertTrue("the notice keeps the warning tone", warning in colours(screen, noticeWords))
        assertFalse("and is not grey", grey in colours(screen, noticeWords))
        assertTrue("the unrelated ERROR stays red", red in colours(screen, error))
        shot(screen, theme)
    }

    private fun draw(): Bitmap {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue("the view was never laid out (${view.width}×${view.height})", view.width > 0 && view.height > 0)
        return Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
    }

    /** Every colour drawn inside the one node [matcher] finds. */
    private fun colours(screen: Bitmap, matcher: SemanticsMatcher): Set<Int> {
        val bounds = compose.onNode(matcher, useUnmergedTree = true).fetchSemanticsNode().boundsInWindow
        val left = bounds.left.toInt().coerceIn(0, screen.width)
        val top = bounds.top.toInt().coerceIn(0, screen.height)
        val width = bounds.right.toInt().coerceIn(left, screen.width) - left
        val height = bounds.bottom.toInt().coerceIn(top, screen.height) - top
        assertTrue("$matcher is drawn nowhere on the screen", width > 0 && height > 0)
        val pixels = IntArray(width * height)
        screen.getPixels(pixels, 0, width, left, top, width, height)
        return pixels.toSet()
    }

    /** The screen as a PNG, with the semantics tree beside it. */
    private fun shot(screen: Bitmap, name: String) {
        val output = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory && File(it, "docs/evidence").isDirectory }
            .let { File(it, "src/android/build/evidence/diagnostic-rows-android") }.also { it.mkdirs() }
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString(Int.MAX_VALUE) })
        val file = File(output, "$name.png")
        file.outputStream().use { screen.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${screen.width}×${screen.height} -> $file")
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DiagnosticRowsTest : DiagnosticRows() {
    override val theme = "light"
    override val grey = 0xFF555861.toInt()
    override val dim = 0xFF757881.toInt()
    override val warning = 0xFF985900.toInt()
    override val red = 0xFFB3261E.toInt()
}

/** Dark: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp-night-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DiagnosticRowsDarkTest : DiagnosticRows() {
    override val theme = "dark"
    override val grey = 0xFFBFC2CA.toInt()
    override val dim = 0xFF93969E.toInt()
    override val warning = 0xFFFFC66D.toInt()
    override val red = 0xFFFFB4AB.toInt()
}
