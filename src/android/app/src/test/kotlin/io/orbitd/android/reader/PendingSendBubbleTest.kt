package io.orbitd.android.reader

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Surface
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Only a `Sending…` bubble is dimmed; a `Not sent` one is drawn at full strength, as the sent bubble is (web `.chat-sending`).
 * Read from the drawn pixels: each bubble's fill, just inside its leading edge. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PendingSendBubbleTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun onlyTheSendingBubbleIsDimmed() {
        compose.setContent {
            OrbitTheme { Surface { Column {
                PendingSendBubble("Ship it", emptyList(), sending = true, reason = null, retry = null, putBack = null, open = {})
                PendingSendBubble("Ship it", emptyList(), sending = false, reason = "the session has ended", retry = {}, putBack = {}, open = {})
                SentBubble("Ship it", emptyList()) {}
            } } }
        }
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val drawn = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(drawn)) }
        fun fill(state: String): String {
            val bubble = compose.onNode(hasTestTag("user-bubble") and hasAnyAncestor(hasTestTag("pending-send:$state")),
                useUnmergedTree = true).fetchSemanticsNode().boundsInWindow
            return Integer.toHexString(drawn.getPixel(bubble.left.toInt() + 4, bubble.center.y.toInt()))
        }
        assertEquals("Not sent is drawn at full strength", fill("sent"), fill("not-sent"))
        assertNotEquals("Sending… is dimmed", fill("sent"), fill("sending"))
    }
}
