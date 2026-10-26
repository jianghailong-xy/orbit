package io.orbitd.android

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.projects.RunSettings
import java.time.Duration
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * A15 F-22 in the production shell: a write on the project page holds the page until the page has read it back. How it runs'
 * Automatic and At most go out under the revision the page read, and a write moves that revision on; a press between the write and
 * its read would go out under the old one and come back "Not saved". The server is ProjectShell's, with Launch's document read held.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1800dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectRunSettingsShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH

    /** The write is in and its read is out: until that read lands nothing on How it runs can be pressed, and a press on Automatic
     * sends nothing. Once it has, the next press goes out under the revision the write moved to. */
    @Test fun noSettingIsPressedAgainUntilThePageHasReadTheWriteBack() {
        ProjectShell.configRevision = 1
        openSettings()
        ProjectShell.holdDocument = CompletableDeferred()
        val reads = documentReads()
        compose.onNodeWithTag("project-automatic").assertIsOn().performClick()
        await { patches() == 1 && documentReads() > reads }
        assertEquals("""{"automatic":false,"expectedConfigRevision":"1"}""", lastPatch())
        compose.waitForIdle()
        // The server is at revision 2; the page still holds revision 1.
        compose.onNodeWithTag("project-automatic").assertIsNotEnabled()
        compose.onNodeWithTag("project-at-most-plus").assertIsNotEnabled()
        compose.onNodeWithTag("project-pause").assertIsNotEnabled()
        compose.onNodeWithTag("project-automatic").performClick()
        compose.waitForIdle()
        assertEquals(1, patches())

        ProjectShell.holdDocument!!.complete(Unit)
        await { enabled("project-automatic") }
        compose.onNodeWithTag("project-automatic").assertIsOff().performClick()
        await { patches() == 2 }
        assertEquals("""{"automatic":true,"expectedConfigRevision":"2"}""", lastPatch())
        await { enabled("project-automatic") }
        assertEquals(3, ProjectShell.configRevision)
        assertFalse(exists(hasTestTag("project-notice")))
    }

    /** At most's write goes once its presses stop. Due while another write's read is still out, it waits for that read — the number
     * still showing where the presses stopped — and goes under the revision the read brought, rather than being dropped. */
    @Test fun atMostsWriteWaitsForTheReadOfAWriteThatWentFirst() {
        ProjectShell.configRevision = 1
        openSettings()
        ProjectShell.holdDocument = CompletableDeferred()
        val reads = documentReads()
        compose.onNodeWithTag("project-at-most-plus").performClick()
        compose.onNodeWithTag("project-at-most").assertTextEquals("3 ${RunSettings.tasksAtATime(3)}")
        compose.onNodeWithTag("project-automatic").performClick()
        await { patches() == 1 && documentReads() > reads }
        assertEquals("""{"automatic":false,"expectedConfigRevision":"1"}""", lastPatch())
        idle(1_000)
        assertEquals(1, patches())
        compose.onNodeWithTag("project-at-most").assertTextEquals("3 ${RunSettings.tasksAtATime(3)}")

        ProjectShell.holdDocument!!.complete(Unit)
        idle(100)
        await { patches() == 2 }
        assertEquals("""{"maxConcurrentTasks":3,"expectedConfigRevision":"2"}""", lastPatch())
        await { enabled("project-at-most-plus") }
        assertEquals(3, ProjectShell.maxConcurrentTasks)
        assertEquals(3, ProjectShell.configRevision)
        compose.onNodeWithTag("project-at-most").assertTextEquals("3 ${RunSettings.tasksAtATime(3)}")
        assertFalse(exists(hasTestTag("project-notice")))
    }

    /** A crossing's answer holds its row until the page has read the answer back. Until then the row is being answered: its second
     * press stays up, spinning and dead — it cannot send the key once more over an answer the server has taken, which it would
     * refuse as spent — and its first press does not come back over the row read before the answer (iOS's order: `answerCrossing`
     * closes the question after `decideCrossing`'s read). Once the read lands, the row says what the answer left: the task moved. */
    @Test fun aCrossingIsAnsweredOnceWhileThePageReadsTheAnswerBack() {
        val row = "34A11jCrossingMove0001"
        val key = "c".repeat(64)
        ProjectShell.crossings = """[{"id":"$row","fromProjectId":"$launch","toProjectId":"34A11jProjectOther0002","kind":"MOVE_TASK",
            "crossingKey":"$key","state":"PENDING","title":"Wire the drain watchdog","requestedAt":"2026-10-26T09:00:00.000Z",
            "subjectTaskId":"34A11jTaskMoved0000003","subjectTask":{"title":"Wire the drain watchdog"},
            "fromProject":{"title":"Launch","status":"OPEN"},"toProject":{"title":"Runner hardening","status":"OPEN"}}]"""
        signIn(); open("orbit-project:$launch")
        scrollTo("crossing:$row:approve")
        compose.onNodeWithTag("crossing:$row:approve").performClick()
        scrollTo("crossing:$row:answer")
        ProjectShell.holdDocument = CompletableDeferred()
        val reads = documentReads()
        compose.onNodeWithTag("crossing:$row:answer").performClick()
        await { decisions(row) == 1 && documentReads() > reads }
        assertEquals("""{"decision":"APPROVE","acknowledgedCrossingKey":"$key"}""", ProjectShell.bodies["POST projects/$launch/handoffs/$row/decision"])
        compose.waitForIdle()
        // The server has taken the answer and the page's read of it is out: no Approve… or Refuse… again, the question still asked.
        compose.onAllNodesWithTag("crossing:$row:approve").assertCountEquals(0)
        compose.onAllNodesWithTag("crossing:$row:refuse").assertCountEquals(0)
        compose.onNodeWithText("Approve moving “Wire the drain watchdog” from Launch to Runner hardening?").assertExists()
        compose.onNode(hasAnyAncestor(hasTestTag("crossing:$row:answer")) and hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate),
            useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("crossing:$row:cancel").assertIsNotEnabled()
        compose.onNodeWithTag("crossing:$row:answer").assertIsNotEnabled().performClick()
        compose.waitForIdle()
        assertEquals(1, decisions(row))

        ProjectShell.holdDocument!!.complete(Unit)
        await { !exists(hasTestTag("crossing:$row:confirm")) }
        compose.onNodeWithTag("crossing:$row:meaning").assertTextEquals("the task was moved when this request was confirmed")
        compose.onAllNodesWithTag("crossing:$row:approve").assertCountEquals(0)
        assertEquals(1, decisions(row))
        assertFalse(exists(hasTestTag("crossing:$row:refusal")))
    }

    // MARK: helpers

    private fun openSettings() {
        signIn(); open("orbit-project:$launch")
        scrollTo("project-automatic")
        await { enabled("project-automatic") }
    }
    private fun patches() = ProjectShell.calls.count { it == "PATCH projects/$launch" }
    private fun lastPatch() = ProjectShell.bodies["PATCH projects/$launch"]
    private fun documentReads() = ProjectShell.calls.count { it == "GET projects/$launch" }
    private fun decisions(row: String) = ProjectShell.calls.count { it == "POST projects/$launch/handoffs/$row/decision" }
    private fun enabled(tag: String) = exists(hasTestTag(tag) and isEnabled())
    /** The app's own scope runs on the main looper, whose clock moves only when told. */
    private fun idle(millis: Long) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis)); compose.waitForIdle() }
    private fun scrollTo(tag: String) = await { runCatching { compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag(tag)) }.isSuccess }

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
