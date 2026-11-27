package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import io.orbitd.android.watch.WatchTaskPill
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The folded Tasks line's right edge (web `SessionCreatedTasksStrip`, iOS `CreatedTasksCard.trailing`): a running task is the spinner
 * alone, in the column where the Background row draws its own, with "Running" kept for TalkBack; any other state is its pill.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class SessionTasksCardLineEndTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    @Test fun aRunningTaskIsTheSpinnerAloneWithItsWordForTalkBack() {
        compose.setContent { OrbitTheme { LineEnd(WatchTaskPill(WatchTaskPill.Kind.RUNNING, "Running")) } }
        compose.onNodeWithTag("session-tasks:spinner").assertExists().assertContentDescriptionEquals("Running")
        compose.onAllNodesWithText("Running").assertCountEquals(0)
        compose.onAllNodesWithTag("pill-spinner", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun anyOtherStateKeepsItsPill() {
        compose.setContent { OrbitTheme { LineEnd(WatchTaskPill(WatchTaskPill.Kind.QUEUED, "Queued")) } }
        compose.onNodeWithText("Queued").assertExists()
        compose.onAllNodesWithTag("session-tasks:spinner").assertCountEquals(0)
    }
}
