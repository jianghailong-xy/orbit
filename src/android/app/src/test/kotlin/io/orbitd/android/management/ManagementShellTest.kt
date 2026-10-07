package io.orbitd.android.management

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The A13 pages inside the real shell, over the controlled server: what a page shows when it is opened again, and what it may still write. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ManagementShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset() }

    @Test fun aCancelledWorkspaceEditIsNotThereWhenTheFormOpensAgain() {
        signIn()
        compose.onNodeWithTag("workspace:${fixture.WORKSPACE}").performClick()
        compose.onNodeWithContentDescription("Workspace settings").performClick()
        await("Smart model selection for tasks")
        name().performTextReplacement("Cancelled edit")
        compose.onNode(hasText("Cancel") and hasClickAction()).performClick()
        await("Fixture session")
        compose.onNodeWithContentDescription("Workspace settings").performClick()
        await("Smart model selection for tasks")
        name().assert(hasText("Alpha"))
        assertTrue(fixture.writes("workspaces/${fixture.WORKSPACE}").isEmpty())
    }

    @Test fun theRunnerNamePageStartsFromTheServerAndNeverWritesAnOldDraftBack() {
        signIn()
        runnerNamePage()
        name("Old alias")
        back()
        await("About")
        // Renamed elsewhere (the web) while the page was closed.
        fixture.runnerAlias = "Web alias"
        compose.onNode(hasText(RunnerCopy.ABOUT_NAME) and hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasSetTextAction() and hasText("Web alias")).fetchSemanticsNodes().isNotEmpty() }
        back()
        await("About")
        compose.waitForIdle()
        assertEquals("No rename goes out when nothing was typed", emptyList<String>(), fixture.writes("runners/${fixture.RUNNER}"))
        assertEquals("Web alias", fixture.runnerAlias)
    }

    @Test fun theSharePanelStopsWritingWhenTheDirectoryIsNoLongerCurrent() {
        signIn()
        compose.onNodeWithTag("workspace:${fixture.WORKSPACE}").performClick()
        await("Fixture session")
        compose.onNodeWithContentDescription("Options for Fixture session").performClick()
        compose.onNode(hasText("Share…") and hasClickAction()).performClick()
        await("Tool calls and output")
        compose.onNode(hasText("Only you") and isSelectable()).assertIsEnabled()
        // The control stream drops: nothing tells this panel any more what the link has become.
        fixture.drop.complete(Unit)
        compose.waitUntil(10_000) { !app().realtime.state.value.directoryFresh }
        compose.waitForIdle()
        compose.onNode(hasText("Only you") and isSelectable()).assertIsNotEnabled()
        compose.onNode(hasText("Tool calls and output") and isToggleable()).assertIsNotEnabled()
    }

    @Test fun theStatusBarFollowsTheAccountsAppearanceNotTheSystems() {
        fixture.theme = "dark"
        signIn()
        compose.waitUntil(10_000) { fixture.calls.contains("GET users/me") }
        compose.waitForIdle()
        val window = compose.activity.window
        assertFalse("Dark app, light system: the status bar's icons must be light",
            WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars)
    }

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(5_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { fixture.signIn(app().session) }
        compose.waitUntil(10_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("workspace:${fixture.WORKSPACE}").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun runnerNamePage() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        compose.onNode(hasText("Settings") and hasClickAction()).performScrollTo().performClick()
        compose.onNode(hasText("Runners") and hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Old alias") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Old alias") and hasClickAction()).performClick()
        await("About")
        compose.onNode(hasText(RunnerCopy.ABOUT_NAME) and hasClickAction()).performScrollTo().performClick()
    }
    private fun name() = compose.onNode(hasSetTextAction() and hasText("Name"))
    private fun name(expected: String) = compose.waitUntil(10_000) {
        compose.onAllNodes(hasSetTextAction() and hasText(expected)).fetchSemanticsNodes().isNotEmpty()
    }
    private fun back() = compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    private fun await(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
}
