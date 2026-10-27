package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.tasks.TaskRunHandoff
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
import org.robolectric.annotation.Config

/**
 * A15 F-22's kind on the task page (A11k): a write holds the page until the page has read it back. A task write carries no revision
 * the server checks, and each Run press names a new trigger, so a Run pressed between the write and its read goes out over the task
 * as it was before the run started: the server refuses it as already running, and the page drew that as the run-conflict card. The
 * server is ProjectShell's, with the task's read held.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1800dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TaskRunShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val task = ProjectShell.TASK

    /** The Run is in and the page's read of it is out: until that read lands nothing on the page can be pressed, and a second Run
     * sends nothing. Once it has, the page draws the run that started — Open the run — with no conflict card. */
    @Test fun noRunIsPressedAgainUntilThePageHasReadTheRunBack() {
        signIn(); open("orbit-task:$task")
        await { enabled("task-run") }
        assertEquals(TaskDetailCopy.runNow, label("task-run"))
        ProjectShell.holdTask = CompletableDeferred()
        val reads = taskReads()
        compose.onNodeWithTag("task-run").performClick()
        await { runs() == 1 && taskReads() > reads }
        compose.waitForIdle()
        // The server has started the run; the page still draws the task before it, and none of its controls can be pressed.
        compose.onNodeWithTag("task-run").assertIsNotEnabled()
        compose.onNodeWithTag("task-assignee").assertIsNotEnabled()
        compose.onNodeWithTag("task-edit-acceptance").assertIsNotEnabled()
        compose.onNodeWithTag("task-run").performClick()
        compose.waitForIdle()
        assertEquals(1, runs())
        assertFalse(exists(hasTestTag("task-run-conflict")))

        ProjectShell.holdTask!!.complete(Unit)
        await { label("task-run") == TaskRunHandoff.openTheRun && enabled("task-edit-acceptance") }
        compose.onNodeWithTag("task-run").assertIsEnabled()
        compose.onNodeWithTag("task-assignee").assertIsEnabled()
        settle()
        assertEquals(1, runs())
        assertFalse(exists(hasTestTag("task-run-conflict")))
    }

    // MARK: helpers

    private fun runs() = ProjectShell.calls.count { it == "POST tasks/$task/execute" }
    private fun taskReads() = ProjectShell.calls.count { it == "GET tasks/$task" }
    private fun enabled(tag: String) = exists(hasTestTag(tag) and isEnabled())
    /** A control's words as it is drawn: the merged node carries its label's text. */
    private fun label(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    /** Lets what a read answered reach the screen, for an assertion that something is NOT drawn. */
    private fun settle() { repeat(3) { compose.waitForIdle(); Thread.sleep(200) }; compose.waitForIdle() }

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
