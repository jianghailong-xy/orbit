package io.orbitd.android.reader

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.directory.QueuedGate
import io.orbitd.android.directory.QueuedRunnerUpdate
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The queued page's block and the held message's foot row for a runner updating (web `RunnerUpdatingQueued`, `RunnerUpdatingTag`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class RunnerUpdatingViewsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val now = Instant.parse("2026-11-12T12:00:00Z")
    private val gate = QueuedGate("runner_updating", 2, QueuedRunnerUpdate("0.1.254", now.minusSeconds(38 * 60L + 5).toString(),
        listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"), QueuedRunnerUpdate.Turn("b2", "Why are 11-08 metrics zero"))))

    private fun text(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        .config[SemanticsProperties.Text].joinToString("") { it.text }

    @Test fun theBlockSaysWhyAndHowLongWithNoButtons() {
        compose.setContent { OrbitTheme { RunnerUpdatingQueued(gate, "studio-mac", {}, now = now) } }
        assertEquals("Runner updating", text("runner-updating:title"))
        assertEquals("studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and " +
            "Why are 11-08 metrics zero. This session starts right after.", text("runner-updating:description"))
        assertEquals("Waiting 38 min", text("runner-updating:waited"))
        assertTrue(compose.onAllNodes(hasClickAction() and hasText("Later", substring = true)).fetchSemanticsNodes().isEmpty())
    }

    @Test fun noClockNoWaitLine() {
        compose.setContent { OrbitTheme { RunnerUpdatingQueued(gate.copy(queuedRunnerUpdate = gate.queuedRunnerUpdate!!.copy(since = null)), null, {}, now = now) } }
        assertTrue(text("runner-updating:description").startsWith("The runner is updating to 0.1.254."))
        assertTrue(compose.onAllNodesWithTag("runner-updating:waited", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }

    @Test fun theFootRowReadsQueuedRunnerUpdatingAndItsTagOpensTheAccount() {
        compose.setContent { OrbitTheme { RunnerUpdatingFoot(gate, "studio-mac", now = now) } }
        val foot = compose.onNodeWithTag("runner-updating-foot", useUnmergedTree = true).onChildren().fetchSemanticsNodes()
            .map { it.config[SemanticsProperties.Text].joinToString("") { t -> t.text } }
        assertEquals(listOf("Queued", "·", "runner updating"), foot)
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).assertHasClickAction().performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Runner updating") and hasAnyAncestor(isDialog())).assertExists()
        assertEquals("studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.\nWaiting 38 min.",
            text("runner-updating-pop:text"))
    }
}
