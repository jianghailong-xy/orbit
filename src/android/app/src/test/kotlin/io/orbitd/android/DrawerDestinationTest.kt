package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A05-8 (iOS 3d50935b4, 6f5f883c8, 9fb95f4eb): every drawer row is a destination. Another destination's row lands on
 * that destination's root page, with the drawer's button leading it; the row of the destination already showing only
 * closes the drawer; the row drawn as selected is the destination the page belongs to. A project row opens its project
 * as a destination of its own. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DrawerDestinationTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    @Test fun anotherDestinationsRowLandsOnItsRootAndTheCurrentOneOnlyClosesTheDrawer() {
        signIn()
        openDrawer(); row("Tasks").performClick()
        await { compose.onAllNodesWithTag("task:${NavShell.TASK}").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("task:${NavShell.TASK}").performClick()
        await { compose.onAllNodesWithTag("task-assignee").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Back").assertExists()
        // Tasks is showing: its row is the selected one, and pressing it only closes the drawer.
        openDrawer(); row("Tasks").assertIsSelected().performClick()
        compose.onNodeWithTag("task-assignee").assertExists()
        compose.onNodeWithContentDescription("Back").assertExists()
        // A workspace's row: its session list, at the root.
        openDrawer(); row("Alpha").performClick()
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onAllNodesWithTag("task-assignee").assertCountEquals(0)
        openDrawer(); row("Alpha").assertIsSelected(); row("Tasks").assertIsNotSelected()
        // Back to Tasks: the list itself, not the task that was open there before.
        row("Tasks").performClick()
        await { compose.onAllNodesWithTag("task:${NavShell.TASK}").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithTag("task-assignee").assertCountEquals(0)
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    @Test fun aProjectRowOpensItsProjectAsADestinationOfItsOwn() {
        signIn()
        openDrawer(); row("Tasks").performClick()
        await { compose.onAllNodesWithTag("task:${NavShell.TASK}").fetchSemanticsNodes().isNotEmpty() }
        openDrawer()
        await { compose.onAllNodes(drawerRow("Launch")).fetchSemanticsNodes().isNotEmpty() }
        row("Launch").performClick()
        await { compose.onAllNodesWithTag("project-detail").fetchSemanticsNodes().isNotEmpty() }
        // The project's page is the destination's root: the drawer's button leads it, not Back.
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onAllNodesWithTag("task:${NavShell.TASK}").assertCountEquals(0)
        openDrawer(); row("Launch").assertIsSelected(); row("Projects").assertIsNotSelected(); row("Tasks").assertIsNotSelected()
    }

    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun row(text: String) = compose.onNode(drawerRow(text))
    private fun openDrawer() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.waitForIdle()
    }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
