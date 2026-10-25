package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The reader's new pieces on their own: reasoning still being written (A06-11) and the fade into the composer band (A06-12). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ReaderPiecesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val reasoning = (1..40).joinToString("\n\n") { "Step $it of weighing the options." }

    /** iOS 471b2afbb: a stretch still being written is open, held to about 160 dp at its newest line, and folds on a tap. */
    @Test fun reasoningStillBeingWrittenIsOpenBoundedAtItsNewestLineAndFoldsOnATap() {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Column { LiveThinking("", reasoning) {} } } } }
        compose.waitForIdle()
        compose.onNodeWithText("Thinking…", useUnmergedTree = true).assertIsDisplayed()
        val fold = compose.onNodeWithTag("thinking-fold")
        fold.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
        val box = compose.onNodeWithTag("thinking-live").fetchSemanticsNode().boundsInRoot
        with(compose.density) { assertTrue("held to 160 dp, not ${box.height.toDp()}", box.height <= 160.dp.toPx() + 1) }
        compose.onNodeWithText("Step 40 of weighing the options.", substring = true, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Step 1 of weighing the options.", substring = true, useUnmergedTree = true).assertIsNotDisplayed()
        fold.performClick()
        compose.onNodeWithTag("thinking-live").assertDoesNotExist()
        fold.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        fold.performClick()
        compose.onNodeWithTag("thinking-live").assertExists()
    }

    /** iOS 9d3751ec2: the list's own pixels dissolve over its last 20 dp — fully at the edge, not at all above the fade. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theFadeDissolvesTheListsLastTwentyDpIntoWhatLiesUnderIt() {
        compose.runOnUiThread { compose.activity.setContent {
            Box(Modifier.size(200.dp).background(Color.White).testTag("page")) {
                Box(Modifier.fillMaxSize().fadesIntoComposerBand().background(Color.Black))
            }
        } }
        compose.waitForIdle()
        // The window as it draws (the project's shot tests draw the same way; PixelCopy is not available here).
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val page = compose.onNodeWithTag("page").fetchSemanticsNode()
        val x = (page.positionInWindow.x + page.size.width / 2).toInt()
        val bottom = page.positionInWindow.y + page.size.height
        val fade = with(compose.density) { COMPOSER_BAND_FADE.toPx() }
        fun grey(y: Float) = ((bitmap.getPixel(x, y.toInt()) shr 16) and 0xFF) / 255f
        assertEquals("above the fade the list is whole", 0f, grey(bottom - fade - 4), 0.02f)
        assertTrue("half-way down the fade it is half gone: ${grey(bottom - fade / 2)}", grey(bottom - fade / 2) in 0.3f..0.7f)
        assertEquals("at its edge what lies under it shows", 1f, grey(bottom - 1), 0.08f)
    }
}
