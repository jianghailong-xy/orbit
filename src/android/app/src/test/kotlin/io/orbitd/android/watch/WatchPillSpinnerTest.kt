package io.orbitd.android.watch

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A08-9 (iOS aaf077310): in the Watching card a running session's pill turns the same spinner, at the same size and inset,
 * as a running task's pill beside it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class WatchPillSpinnerTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    @Test fun aRunningSessionsPillSpinsAsARunningTasksPillDoes() {
        compose.setContent { OrbitTheme {
            Column {
                Box(Modifier.testTag("task")) { WatchTaskStatusPill(WatchTaskPill(WatchTaskPill.Kind.RUNNING, "Running")) }
                Box(Modifier.testTag("session")) { WatchSessionStatusPill(WatchSessionGlyph.of("RUNNING")) }
            }
        } }
        fun spinner(pill: String) = compose.onNode(hasAnyAncestor(hasTestTag(pill)) and
            hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate), useUnmergedTree = true).getBoundsInRoot()
        fun pill(tag: String) = compose.onNodeWithTag(tag).getBoundsInRoot()
        val task = spinner("task")
        val session = spinner("session")
        assertEquals("the same spinner", task.right - task.left, session.right - session.left)
        assertEquals("iOS's 9-point frame, the Tasks list pill's size", 9.dp, session.right - session.left)
        assertEquals(9.dp, session.bottom - session.top)
        assertEquals("the same inset: iOS's 6, not the 7 it had", task.left - pill("task").left, session.left - pill("session").left)
        assertEquals(6.dp, session.left - pill("session").left)
    }
}
