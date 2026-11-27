package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.composer.CloneState
import io.orbitd.android.directory.QueuedClone
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The clone waiting card, full-height and under a transcript, PENDING and CLONING at a percentage, light and dark. Also writes PNGs. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CloneWaitNoticeShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val output: File by lazy { File(System.getProperty("user.dir"), "build/evidence/clone-wait-card").also { it.mkdirs() } }

    private fun show(dark: Boolean, wait: QueuedClone.Wait?, failed: Boolean = false) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.fillMaxWidth().height(300.dp), contentAlignment = Alignment.Center) {
                        CloneWaitNotice(wait, failed, "Studio Mac", compact = false, modifier = Modifier.testTag("full"))
                    }
                    CloneWaitNotice(wait, failed, "Studio Mac", compact = true, modifier = Modifier.testTag("compact"))
                }
            }
        } } }
        compose.waitForIdle()
    }


    private fun shot(name: String) {
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun texts(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test fun pendingAndCloningInLightAndDark() {
        for (dark in listOf(false, true)) {
            val mode = if (dark) "dark" else "light"
            show(dark, QueuedClone.Wait(CloneState.PENDING, null, "acme/widgets"))
            assertEquals(2, texts("clone-wait:title"))
            compose.onAllNodesWithTag("clone-wait:title", useUnmergedTree = true)[0].assertTextEquals("Waiting to clone acme/widgets")
            compose.onAllNodesWithTag("clone-wait:description", useUnmergedTree = true)[1]
                .assertTextEquals("On Studio Mac. This session starts when the clone is done.")
            assertEquals(0, texts("clone-wait:bar"))
            // Only the compact card spins: the full-height card has its own dots.
            assertEquals(1, texts("clone-wait:spinner"))
            shot("pending-$mode")
            show(dark, QueuedClone.Wait(CloneState.CLONING, 42, "acme/widgets"))
            compose.onAllNodesWithTag("clone-wait:title", useUnmergedTree = true)[1].assertTextEquals("Cloning acme/widgets")
            compose.onAllNodesWithTag("clone-wait:percent", useUnmergedTree = true)[0].assertTextEquals("42%")
            assertEquals(2, texts("clone-wait:bar"))
            assertEquals(0, texts("clone-wait:spinner"))
            shot("cloning-42-$mode")
        }
    }

    @Test fun aFailedCloneSaysItsPlainSentence() {
        show(false, null, failed = true)
        compose.onAllNodesWithTag("clone-wait:description", useUnmergedTree = true)[0]
            .assertTextEquals("This session starts once the repository is cloned.")
        compose.onAllNodesWithTag("clone-wait:title", useUnmergedTree = true)[0].assertTextEquals("Clone failed")
    }
}
