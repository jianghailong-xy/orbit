package io.orbitd.android.reader

import io.orbitd.android.directory.RunningOverLimit
import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.runtime.CompositionLocalProvider
import io.orbitd.android.cards.LocalQueuedHeld
import io.orbitd.android.cards.QueuedFoot
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

    @Test fun theBlockSaysWhyAndHowLongWithNoButtonsUntilLaterIsHanded() {
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

    /** A runner that is stopping, not updating (board runner-stopping): its own title, tag and account. */
    @Test fun aRunnerThatIsStoppingSaysSoOnTheBlockAndTheFootRow() {
        val stopping = gate.copy(queuedRunnerUpdate = gate.queuedRunnerUpdate!!.copy(stopping = true))
        compose.setContent { OrbitTheme { Column { RunnerUpdatingQueued(stopping, "HPC", {}, now = now); RunnerUpdatingFoot(stopping, "HPC", now = now) } } }
        assertEquals("Runner stopping", text("runner-updating:title"))
        assertEquals("HPC is stopping. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. " +
            "This session starts once HPC is back.", text("runner-updating:description"))
        assertEquals("runner stopping", text("runner-updating-foot:reason"))
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Runner stopping") and hasAnyAncestor(isDialog())).assertExists()
        assertEquals("HPC starts no new turns until 2 turns finish, then stops. This message is sent once it is back.\nWaiting 38 min.",
            text("runner-updating-pop:text"))
    }

    /** docs/mocks/queued-card-runner-updating ②: a queued card's line reads the update's tag in place of `Queued`, Cancel beside it. */
    @Test fun aQueuedTurnTheUpdateHoldsSaysSoOnItsOwnLineWithCancelBesideIt() {
        var cancelled = 0
        compose.setContent { OrbitTheme { Column {
            CompositionLocalProvider(LocalQueuedHeld provides { RunnerUpdatingFoot(gate, "HPC", now = now) }) { QueuedFoot { cancelled++ } }
        } } }
        assertEquals("runner updating", text("runner-updating-foot:reason"))
        compose.onNodeWithTag("queued-foot:cancel").performClick()
        assertEquals(1, cancelled)
    }

    @Test fun aQueuedTurnNothingHoldsStillReadsQueued() {
        compose.setContent { OrbitTheme { QueuedFoot {} } }
        assertTrue(compose.onAllNodesWithTag("runner-updating-foot", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Queued").assertExists()
    }

    private val full = QueuedGate("runner_at_capacity", 16, queuedLimit = 16, queuedHeldByJobs = 0, since = now.minusSeconds(5 * 60L).toString(),
        runNowAvailable = true)

    private fun openFull(gate: QueuedGate, press: () -> Unit) {
        compose.setContent { OrbitTheme {
            RunnerUpdatingFoot(gate, "HPC", now = now, runNow = { RunNowAction(gate, "HPC", 16, 16, pending = false, press = press) })
        } }
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        compose.waitForIdle()
    }

    /** docs/mocks/queued-run-now ①. */
    @Test fun aFullRunnersPopoverOffersRunNowWithWhatItDoesUnderIt() {
        var pressed = 0
        openFull(full) { pressed++ }
        assertEquals("HPC is running 16 of 16 sessions. This message is sent as soon as one finishes.\nWaiting 5 min.", text("runner-updating-pop:text"))
        assertEquals("Starts it as the 17th session on HPC. This turn only; the limit stays 16.", text("run-now:note"))
        compose.onNodeWithTag("run-now").assertTextEquals("Run now").assertIsEnabled().performClick()
        assertEquals(1, pressed)
    }

    /** ③: at the extra cap the button explains, it does not run. */
    @Test fun aRefusedRunNowIsDisabledOverTheServersSentence() {
        val refusal = "HPC is already 2 over its limit, the most it can take. Wait, or stop another session."
        openFull(full.copy(queuedActive = 18, runNowAvailable = false, runNowRefusal = refusal)) {}
        assertEquals(refusal, text("run-now:note"))
        compose.onNodeWithTag("run-now").assertIsNotEnabled()
    }

    @Test fun aServerThatOffersNoRunNowDrawsNoButton() {
        openFull(full.copy(runNowAvailable = false)) {}
        compose.onNodeWithTag("runner-updating-pop:text").assertExists()
        assertTrue(compose.onAllNodesWithTag("run-now").fetchSemanticsNodes().isEmpty())
    }

    @Test fun theUpdatesPopoverHasNoRunNow() {
        compose.setContent { OrbitTheme { RunnerUpdatingFoot(gate, "HPC", now = now, runNow = { RunNowAction(full, "HPC", 16, 16, false) {} }) } }
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertTrue(compose.onAllNodesWithTag("run-now").fetchSemanticsNodes().isEmpty())
    }

    /** ②. */
    @Test fun aTurnOverTheLimitReadsRunningWithItsTagWhichExplainsItself() {
        compose.setContent { OrbitTheme { RunningOverLimitFoot(RunningOverLimit(17, 16, "HPC")) } }
        compose.onNodeWithText("Running").assertExists()
        assertEquals("over limit · 17/16", text("over-limit"))
        compose.onNodeWithTag("over-limit", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals("Started over HPC's limit by you", text("over-limit:hint"))
    }

    @Test fun theTagSitsUnderTheMessageThatOpenedTheTurnStillRunning() {
        fun event(type: String, seq: Long, steer: Boolean = false) = io.orbitd.android.core.realtime.RunEvent(type, seq,
            kotlinx.serialization.json.buildJsonObject { if (steer) put("steer", kotlinx.serialization.json.JsonPrimitive(true)) }, "t$seq")
        assertEquals(1L, openTurnUserSeq(listOf(event("user", 1), event("assistant", 2), event("user", 3, steer = true))))
        assertNull(openTurnUserSeq(listOf(event("user", 1), event("turn_end", 2))))
        assertNull(openTurnUserSeq(emptyList()))
    }

    @Test fun onlyATurnWaitingForItsOwnTurnIsHeld() {
        val event = io.orbitd.android.core.realtime.RunEvent("user", 0, kotlinx.serialization.json.buildJsonObject {}, "t1")
        val turn = QueuedTurn("t1", steer = false, event = event, cards = emptyList(), wake = null)
        assertTrue(turn.heldByUpdate)
        assertFalse(turn.copy(steer = true).heldByUpdate)
        assertFalse(turn.copy(delivery = "failed").heldByUpdate)
    }
}
