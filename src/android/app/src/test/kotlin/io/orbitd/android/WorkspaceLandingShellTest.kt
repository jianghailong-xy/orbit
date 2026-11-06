package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** What opening the app does (iOS `resolveDefaultLanding`, `LaunchSnapshot`; docs/mocks/android-cold-start-landing): it lands on the
 * workspace used last, else the first, drawn from what this phone saved as it left the foreground, with nothing said about the read
 * behind it. The production Activity, AuthSession and RealtimeStore over [ColdStart]. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ColdStartApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WorkspaceLandingShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before fun start() = ColdStart.reset()
    @After fun finish() { if (::scenario.isInitialized) scenario.close() }

    private fun title(name: String) = hasText(name) and hasAnyAncestor(hasTestTag("app-bar"))

    @Test fun itLandsOnTheWorkspaceUsedLastBeforeAnyReadAnswers() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.records["last-workspace"] = ColdStart.GAMMA.encodeToByteArray()
        launch()
        await { exists(title("Cached Gamma")) }
        assertFalse(ColdStart.network.isCompleted)
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    @Test fun withNothingRememberedItLandsOnTheFirst() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { exists(title("Cached Alpha")) && shows("Cached review") }
    }

    @Test fun aRememberedWorkspaceTheListNoLongerHasFallsToTheFirst() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.records["last-workspace"] = "34A05gWorkspaceGone001".encodeToByteArray()
        launch()
        await { exists(title("Cached Alpha")) }
    }

    /** iOS: the saved list is no answer. The first read decides again, so a workspace deleted since isn't kept. */
    @Test fun theFirstReadDecidesAgainAndAWorkspaceDeletedSinceIsNotKept() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.records["last-workspace"] = ColdStart.GAMMA.encodeToByteArray()
        launch()
        await { exists(title("Cached Gamma")) }
        ColdStart.network.complete(Unit)
        await { exists(title("Server Alpha")) && shows("Server review") }
    }

    /** …unless something has been opened over the landing since: then it is a place someone chose to be. */
    @Test fun aSessionOpenedOverTheLandingBeforeTheReadAnswersStays() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.server = listOf(ColdStart.DELTA to "Server Delta")
        launch()
        await { shows("Cached review") }
        compose.onNode(hasText("Cached review") and hasClickAction()).performClick()
        await { exists(hasContentDescription("Back")) }
        ColdStart.network.complete(Unit)
        await { (RuntimeEnvironment.getApplication() as OrbitApplication).realtime.state.value.directoryCached.not() }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Back").assertExists()
    }

    /** A link's page stays on top of the landing, and Back from it reaches the list of the workspace it belongs to. */
    @Test fun aLinksPageKeepsItsPlaceAndBackReachesItsWorkspacesList() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.records["last-workspace"] = ColdStart.GAMMA.encodeToByteArray()
        (RuntimeEnvironment.getApplication() as OrbitApplication).realtime.setNetwork(true, "fixture")
        scenario = ActivityScenario.launch(Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:34A05gSessionCached01"))
            .setClass(RuntimeEnvironment.getApplication(), MainActivity::class.java))
        await { (RuntimeEnvironment.getApplication() as OrbitApplication).realtime.state.value.directory != null }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(title("Cached Alpha")) && shows("Cached review") }
    }

    /** A saved list is drawn with nothing said about the read behind it. */
    @Test fun nothingIsSaidBesideRowsWhileTheReadIsOut() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { shows("Cached review") }
        listOf("Loading", "Showing saved", "Connecting", "Waiting for connection", "couldn't be loaded").forEach {
            compose.onAllNodesWithText(it, substring = true).assertCountEquals(0)
        }
    }

    /** No rows yet: a bare spinner, with no name in the bar and no words. */
    @Test fun withNoRowsYetItIsABareSpinner() {
        launch()
        await { exists(hasTestTag("workspaces-loading")) }
        compose.onAllNodesWithText("Workspaces", substring = true).fetchSemanticsNodes().forEach { node ->
            assertFalse("drawn on the page: $node", node.boundsInRoot.left >= 0)
        }
        compose.onAllNodesWithText("Loading", substring = true).assertCountEquals(0)
    }

    /** No rows and the read failed: iOS's words, and Retry reads again and lands. */
    @Test fun withNoRowsAndAFailedReadItSaysSoInIosWords() {
        ColdStart.status = 500
        ColdStart.network.complete(Unit)
        launch()
        await { shows("Workspaces couldn't be loaded") && shows("Request failed — check your connection.") }
        ColdStart.status = null
        // The page's, not the one in the closed drawer, off to the left.
        val retries = compose.onAllNodes(hasText("Retry") and hasClickAction())
        retries[retries.fetchSemanticsNodes().indexOfFirst { it.boundsInRoot.left >= 0 }].performClick()
        await { shows("Server review") }
    }

    /** No rows and no network: the same, once the phone has had its moment to say what network it has. Back online it lands. */
    @Test fun withNoRowsAndNoNetworkItSaysTheSameAndLandsWhenItComesBack() {
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        scenario = ActivityScenario.launch(MainActivity::class.java)
        await { shows("Workspaces couldn't be loaded") && shows("Request failed — check your connection.") }
        ColdStart.network.complete(Unit)
        app.realtime.setNetwork(true, "fixture")
        await { shows("Server review") }
    }

    /** Opened offline: the saved rows are there and the list says nothing about it; the drawer heads its workspaces with why. */
    @Test fun openedOfflineTheSavedRowsAreDrawnAndOnlyTheDrawerSaysSo() {
        ColdStart.cache = ColdStart.CACHED
        scenario = ActivityScenario.launch(MainActivity::class.java)
        await { shows("Cached review") && compose.onAllNodesWithTag("drawer-unreachable", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        listOf("Loading", "Waiting for connection", "couldn't be loaded", "Showing saved").forEach {
            compose.onAllNodesWithText(it, substring = true).assertCountEquals(0)
        }
        compose.onNodeWithContentDescription("Start a new session with Cached Alpha").assertIsEnabled()
    }

    /** No workspace at all, read from the server: that says so, and it is not read off a saved list. */
    @Test fun anEmptyAccountIsDecidedByARead() {
        ColdStart.server = emptyList()
        ColdStart.runners = "[]"
        ColdStart.network.complete(Unit)
        launch()
        await { shows("No workspaces yet") }
    }

    /** As the app leaves the foreground, the list and only Open's rows; and the workspace it was on, as soon as it is on it. */
    @Test fun whatTheNextLaunchDrawsIsSavedAsTheAppLeavesTheForeground() {
        ColdStart.network.complete(Unit)
        launch()
        await { shows("Server review") }
        await { ColdStart.records["last-workspace"]?.decodeToString() == ColdStart.ALPHA }
        assertFalse("not before it leaves", ColdStart.records.containsKey("directory-v1"))
        scenario.moveToState(Lifecycle.State.CREATED)
        await { ColdStart.records.containsKey("directory-v1") }
        val saved = ColdStart.records.getValue("directory-v1").decodeToString()
        assertTrue(saved, saved.contains("Server review") && saved.contains("Server Alpha"))
        assertFalse(saved, saved.contains("completed") || saved.contains("trash"))
    }

    /** The account's appearance is saved with it, so a dark account's first frame is dark (iOS's snapshot holds the user), and a list with
     * recaps off doesn't flip its lines when `users/me` answers. */
    @Test fun theAccountsAppearanceIsDrawnBeforeItsReadAnswers() {
        ColdStart.cache = ColdStart.CACHED_WITH_RECAP
        ColdStart.records["account-appearance"] = """{"theme":"dark","recaps":false}""".encodeToByteArray()
        launch()
        await { shows("The last reply") }
        assertFalse(ColdStart.network.isCompleted)
        assertFalse(shows("The recap"))
        await { !lightBars() }
    }

    @Test fun theAccountsAppearanceIsSavedOnceItIsRead() {
        ColdStart.preferences = """{"theme":"dark","recaps":false}"""
        ColdStart.network.complete(Unit)
        launch()
        await { ColdStart.records["account-appearance"]?.decodeToString() == """{"theme":"dark","recaps":false}""" }
    }

    private fun lightBars(): Boolean {
        var light = true
        scenario.onActivity { light = WindowCompat.getInsetsController(it.window, it.window.decorView).isAppearanceLightStatusBars }
        return light
    }
    private fun launch() {
        (RuntimeEnvironment.getApplication() as OrbitApplication).realtime.setNetwork(true, "fixture")
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000) { compose.waitForIdle(); condition() }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun shows(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
}
