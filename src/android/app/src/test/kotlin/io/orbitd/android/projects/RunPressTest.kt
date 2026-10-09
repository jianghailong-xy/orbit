package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The run queue's Run as iOS 6f2a10f9f draws it: the play mark beside the word (no "▶" typed into it), a press at least the
 * platform's 48dp tall and 72dp wide, named by the task it runs, and dead while it cannot be pressed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class RunPressTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var runs = 0

    private fun press(label: String, enabled: Boolean) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            RunPress(label, enabled, "queue:t1:run", "Run Check the lock order") { runs++ }
        } } }
        compose.waitForIdle()
    }

    @Test fun runIsThePlayMarkAndTheWordOnAPressAsTallAsAFinger() {
        press(ProjectPage.runPress, enabled = true)
        compose.onNodeWithTag("queue:t1:run").assertTextEquals(ProjectPage.runPress).assertContentDescriptionEquals("Run Check the lock order")
            .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(72.dp).assertIsEnabled()
        compose.onNodeWithTag("queue:t1:run:play", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("queue:t1:run").performClick()
        assertEquals(1, runs)
    }

    @Test fun aRunThatCannotBePressedIsDeadAndStillSaysWhatItIs() {
        press(ProjectPage.runPressStarting, enabled = false)
        compose.onNodeWithTag("queue:t1:run").assertTextEquals(ProjectPage.runPressStarting).assertIsNotEnabled().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("queue:t1:run").performClick()
        assertEquals(0, runs)
    }
}
