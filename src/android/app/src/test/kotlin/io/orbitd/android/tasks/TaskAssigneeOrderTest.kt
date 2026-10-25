package io.orbitd.android.tasks

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.NavShell
import io.orbitd.android.NavShellApplication
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A05-2: the Tasks list's Set assignee and the task page's Assignee picker offer the workspaces in the drawer's order
 * (iOS `orderedAgents`, fbbc3dc7a): the server's order with the workspaces that have no runner moved to the bottom. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TaskAssigneeOrderTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    @Test fun setAssigneeListsTheWorkspacesWithARunnerFirst() {
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Tasks").performClick()
        await { compose.onAllNodesWithTag("task:${NavShell.TASK}").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tasks-options").performClick()
        compose.onNodeWithText(TaskListCopy.selectTasks).performClick()
        compose.onNodeWithTag("task:${NavShell.TASK}").performClick()
        compose.onNode(hasText(TaskListCopy.setAssignee) and hasAnyAncestor(hasTestTag("tasks-bulk-bar"))).performClick()
        val offered = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
            .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") }
        assertEquals(listOf("Alpha", "Beta", "Spare", TaskListCopy.unassigned, "Cancel"), offered)
    }

    @Test fun theTaskPagesAssigneePickerListsTheWorkspacesWithARunnerFirst() {
        signIn()
        open("orbit-task:${NavShell.TASK}")
        await { compose.onAllNodesWithTag("task-assignee").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("task-assignee").performScrollTo().performClick()
        val offered = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
            .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
        assertEquals(listOf(TaskListCopy.unassigned, "Alpha", "Beta", "Spare"), offered)
    }

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
