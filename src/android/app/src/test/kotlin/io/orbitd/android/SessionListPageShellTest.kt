package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.directory.SessionListCopy
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.CompletableDeferred
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

/** A workspace's session list as iOS draws it on a phone (the owner's pick of 2026-11-04, docs/mocks/android-cold-start-landing): the
 * production Activity, store and navigation over [NavShell]. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionListPageShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    private val plain = hasRowMenu("Options for Plain notes")
    private val review = hasRowMenu("Options for Review navigation")

    /** No page of names to tap, and nothing under the list for Back to return to. */
    @Test fun aLaunchLandsOnTheFirstWorkspacesList() {
        signIn()
        await { exists(plain) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        openDrawer()
        compose.onNode(drawerRow("Alpha")).assertIsSelected()
    }

    /** ☰ and the name; ≡ and ✎. The gear went into ≡, and the list is refreshed by pulling it. Another page keeps its refresh. */
    @Test fun theBarIsTheMenuAndNewSessionAndNothingElse() {
        signIn()
        await { exists(plain) }
        compose.onNodeWithContentDescription("Open navigation").assertExists()
        compose.onNode(hasText("Alpha") and hasAnyAncestor(hasTestTag("app-bar"))).assertExists()
        compose.onNodeWithContentDescription("Session scope, Open").assertExists()
        compose.onNodeWithContentDescription("Start a new session with Alpha").assertIsEnabled()
        compose.onAllNodesWithContentDescription("Workspace settings").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Refresh directory").assertCountEquals(0)
        openDrawer()
        compose.onNode(drawerRow("Tasks")).performClick()
        await { exists(hasContentDescription("Refresh directory")) }
    }

    /** The scope with its tick, the tag rows only when the account has tags, a new folder and the workspace's settings. */
    @Test fun theMenuReadsAsIosDoes() {
        signIn()
        await { exists(plain) }
        compose.onNodeWithContentDescription("Session scope, Open").performClick()
        assertEquals(listOf("Open", "Completed", "Trash", "New Folder…", "Settings"), menuRows())
        compose.onNode(hasText("Open") and hasAnyAncestor(isPopup())).assertIsSelected()
        compose.onNode(hasText("Completed") and hasAnyAncestor(isPopup())).assertIsNotSelected()
        compose.onNode(hasText("Settings") and hasAnyAncestor(isPopup())).performClick()
        await { exists(hasText("Working directory", substring = true)) }
    }

    @Test fun withTagsTheMenuFiltersAndGroupsByThem() {
        NavShell.tags = """[{"id":"t1","name":"Urgent","color":"#FF3B30","position":0}]"""
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionTagged01", "Tagged notes", fields = ""","tags":[{"id":"t1","name":"Urgent","color":"#FF3B30","position":0}]""")))
        signIn()
        await { exists(hasRowMenu("Options for Tagged notes")) && exists(plain) }
        compose.onNodeWithContentDescription("Session scope, Open").performClick()
        await { menuRows().contains("Filter by Tag") }
        assertEquals(listOf("Open", "Completed", "Trash", "Filter by Tag", "Group by Tag", "New Folder…", "Settings"), menuRows())
        compose.onNode(hasText("Filter by Tag") and hasAnyAncestor(isPopup())).performClick()
        assertEquals(listOf("All", "Urgent"), menuRows())
        compose.onNode(hasText("Urgent") and hasAnyAncestor(isPopup())).performClick()
        await { !exists(plain) }
        assertTrue(exists(hasRowMenu("Options for Tagged notes")))
        // The menu names the tag it is narrowed to, and choosing it again clears it.
        compose.onNodeWithContentDescription("Session scope, Open").performClick()
        compose.onNode(hasText("Filter by Tag") and hasText("Urgent") and hasAnyAncestor(isPopup())).performClick()
        compose.onNode(hasText("Urgent") and hasAnyAncestor(isPopup())).assertIsSelected().performClick()
        await { exists(plain) }
        compose.pickFromSessionOptions("Group by Tag")
        await { exists(hasText("Untagged")) }
        compose.onNode(hasText("Urgent") and hasAnyAncestor(hasTestTag("directory-list"))).assertExists()
    }

    @Test fun inTrashTheMenuOffersNoNewFolder() {
        signIn()
        await { exists(plain) }
        compose.pickFromSessionOptions("Trash")
        await { exists(hasText("No trash sessions")) }
        compose.onNodeWithContentDescription("Session scope, Trash").performClick()
        assertEquals(listOf("Open", "Completed", "Trash", "Settings"), menuRows())
    }

    /** No ⋮: a long press is the row's menu, and a tap opens the session. */
    @Test fun aRowsMenuIsItsLongPressAndATapOpensIt() {
        signIn()
        await { exists(plain) }
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        compose.onNode(plain).performScrollTo().performTouchInput { longClick() }
        await { exists(hasText("Complete") and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.waitForIdle()
        compose.onNode(plain).performClick()
        await { exists(hasContentDescription("Back")) && exists(hasContentDescription("Session actions")) }
    }

    /** iOS: nothing waits on a read and nothing about one is drawn beside rows. A read is out: the rows stay, the row's menu works and New
     * session opens its page, which reads its workspace at once. */
    @Test fun neitherARowsMenuNorNewSessionWaitsForARead() {
        signIn()
        await { exists(plain) }
        NavShell.holdOpen = CompletableDeferred()
        app().realtime.refreshDirectory()
        await { !app().realtime.state.value.directoryFresh }
        compose.onNode(plain).assertExists()
        listOf("Loading", "Showing saved", "Connecting", "Waiting for connection").forEach {
            compose.onAllNodesWithText(it, substring = true).assertCountEquals(0)
        }
        compose.onNode(plain).openRowMenu()
        await { exists(hasText("Complete") and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText("Complete") and hasAnyAncestor(isDialog())).assertIsEnabled()
        compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).assertIsEnabled()
        compose.onAllNodesWithText("Refresh the directory before making changes.").assertCountEquals(0)
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Start a new session with Alpha").assertIsEnabled().performClick()
        await { NavShell.calls.any { it == "GET workspaces/${NavShell.ALPHA}" } && exists(hasTestTag("composer-input"), unmerged = true) }
        assertFalse("the directory's read is still out", app().realtime.state.value.directoryFresh)
    }

    /** A launch reads Open. Completed is read when it is chosen, on a pull and behind a change, and not again on the way back from a
     * session opened over it (iOS polls it; an owner's is 18 MB). Left and chosen again, it is read again. */
    @Test fun completedIsReadWhenChosenOnAPullAndBehindAChange() {
        NavShell.lifecycle = mapOf(NavShell.SESSION to "COMPLETED", NavShell.PLAIN to "OPEN")
        signIn()
        await { exists(plain) }
        fun reads() = NavShell.calls.count { it == "GET sessions?view=completed" }
        assertEquals(0, reads())
        assertEquals(0, NavShell.calls.count { it == "GET sessions?view=trash" })
        compose.pickFromSessionOptions("Completed")
        await { exists(review) }
        assertEquals(1, reads())
        assertFalse("Open's row is not this list's", exists(plain))
        compose.onNodeWithContentDescription("Session scope, Completed").assertExists()

        compose.onNode(review).performClick()
        await { exists(hasContentDescription("Back")) }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(review) }
        assertEquals("back from a session the rows are held", 1, reads())

        compose.onNodeWithTag("directory-list").performTouchInput { swipeDown() }
        await { reads() == 2 }

        compose.onNode(review).openRowMenu()
        await { exists(hasText("Move to Open") and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText("Move to Open") and hasAnyAncestor(isDialog())).performClick()
        await { reads() == 3 && exists(hasText("No completed sessions")) }
        assertFalse(exists(review))

        compose.pickFromSessionOptions("Open")
        await { exists(review) }
        compose.pickFromSessionOptions("Completed")
        await { reads() == 4 }
    }

    /** While Completed's read is out the list says Loading…; one that fails says so and offers Retry. */
    @Test fun aScopeNotReadYetSaysLoadingAndAFailedOneSaysWhy() {
        NavShell.lifecycle = mapOf(NavShell.SESSION to "COMPLETED", NavShell.PLAIN to "OPEN")
        signIn()
        await { exists(plain) }
        NavShell.holdScope = CompletableDeferred()
        compose.pickFromSessionOptions("Completed")
        await { exists(hasText("Loading…")) }
        // The capsule and the bar are not waiting for it.
        compose.onNodeWithContentDescription("Session scope, Completed").assertExists()
        NavShell.scopeStatus = 500
        NavShell.holdScope!!.complete(Unit)
        await { exists(hasText("Couldn't load sessions")) }
        NavShell.scopeStatus = null; NavShell.holdScope = null
        compose.onNode(hasText("Retry") and hasAnyAncestor(hasTestTag("directory-list"))).performClick()
        await { exists(review) }
    }

    @Test fun aPullReadsTheOpenListAgainAndARowMovesInPlace() {
        signIn()
        await { exists(plain) }
        val before = NavShell.calls.count { it == "GET sessions?view=open" }
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionFresh001", "Fresh row")))
        compose.onNodeWithTag("directory-list").performTouchInput { swipeDown() }
        await { NavShell.calls.count { it == "GET sessions?view=open" } > before && exists(hasRowMenu("Options for Fresh row")) }
    }

    /** At the foot, in a thumb's reach; out of the way on the way down, back on the way up. Typing searches the server, and the hits take
     * the list's place. */
    @Test fun theSearchIsAtTheFootAndStepsAsideWhileReadingDown() {
        NavShell.extra = mapOf("open" to List(40) { NavShell.row("34A05cSessionMany%04d".format(it), "Row $it") })
        signIn()
        await { exists(hasTestTag("session-search")) && exists(hasRowMenu("Options for Row 0")) }
        val list = compose.onNodeWithTag("directory-list").fetchSemanticsNode().boundsInRoot
        assertTrue(compose.onNodeWithTag("session-search").fetchSemanticsNode().boundsInRoot.top > list.center.y)
        compose.onNodeWithTag("directory-list").performTouchInput { swipeUp() }
        await { !exists(hasTestTag("session-search")) }
        compose.onNodeWithTag("directory-list").performTouchInput { swipeDown(startY = centerY, endY = centerY + 200f) }
        await { exists(hasTestTag("session-search")) }
        compose.onNodeWithTag("session-search").performTextInput("Review")
        await { NavShell.calls.any { it.startsWith("GET sessions/search?q=Review") } && exists(hasText("Found by search")) }
        assertFalse(exists(hasTestTag("directory-list")))
    }

    /** The list's first thing, above the rows, from a list that shows no single session: everything waiting is elsewhere. */
    @Test fun theNeedsYouCapsuleIsAtTheTopOfTheList() {
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionWaiting1", "Waiting row", pending = 1)))
        signIn()
        await { exists(hasTestTag("needs-you-bar")) && exists(hasRowMenu("Options for Waiting row")) }
        assertTrue(compose.onNodeWithTag("needs-you-bar").fetchSemanticsNode().boundsInRoot.bottom <=
            compose.onNodeWithTag("directory-list").fetchSemanticsNode().boundsInRoot.top + 1)
    }

    /** iOS: a list that opens on today would be saying what its rows say. Later sections, and a Pinned that leads, keep their titles. */
    @Test fun theLeadingTodayHasNoTitleAndTheOthersDo() {
        val now = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionToday001", "Today's row", at = now.minusSeconds(60).toString()),
            NavShell.row("34A05cSessionOlder001", "Older row", at = now.minus(3, ChronoUnit.DAYS).toString())))
        signIn()
        await { exists(hasRowMenu("Options for Today's row")) && exists(hasRowMenu("Options for Older row")) }
        compose.onAllNodesWithText("Today").assertCountEquals(0)
        compose.onNodeWithText("2–7 days ago").assertExists()
    }

    /** Folded to its heading, as Notes' Pinned does, and it stays folded: this phone's, across launches and workspaces. */
    @Test fun thePinnedSectionFoldsAndStaysFolded() {
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionPinned01", "Pinned row", fields = ""","pinnedAt":"2026-10-09T01:00:00Z"""")))
        signIn()
        await { exists(hasRowMenu("Options for Pinned row")) }
        val heading = compose.onNodeWithTag("pinned-heading")
        assertEquals(SessionListCopy.PINNED_HIDES, heading.fetchSemanticsNode().config.getOrNull(SemanticsActions.OnClick)?.label)
        heading.performClick()
        await { !exists(hasRowMenu("Options for Pinned row")) }
        assertEquals(SessionListCopy.PINNED_SHOWS, compose.onNodeWithTag("pinned-heading").fetchSemanticsNode().config.getOrNull(SemanticsActions.OnClick)?.label)
        compose.activityRule.scenario.recreate()
        await { exists(hasTestTag("pinned-heading")) && exists(plain) }
        assertFalse(exists(hasRowMenu("Options for Pinned row")))
        compose.onNodeWithTag("pinned-heading").performClick()
        await { exists(hasRowMenu("Options for Pinned row")) }
    }

    /** A folder's row says what the sessions it hides would have said. Its page: its name over its workspace's, ⋯ and ✎, and the scope it was
     * opened from: no ≡, search or capsule of its own. */
    @Test fun aFolderHasARowAndAPageOfItsOwn() {
        NavShell.folders = """[{"id":"34A05cFolderResearch1","workspaceId":"${NavShell.ALPHA}","name":"Research"},
            {"id":"34A05cFolderEmpty0001","workspaceId":"${NavShell.ALPHA}","name":"Empty one"}]"""
        NavShell.extra = mapOf("open" to listOf(NavShell.row("34A05cSessionFiled001", "Filed row", pending = 1, fields = ""","folderId":"34A05cFolderResearch1"""")))
        signIn()
        val row = hasTestTag("folder-row:34A05cFolderResearch1")
        await { exists(row) }
        assertFalse("filed rows are behind their folder", exists(hasRowMenu("Options for Filed row")))
        assertEquals("1 waiting for you", compose.onNode(row).fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
        compose.onNode(row).assert(hasText("Research", substring = true)).assert(hasRowMenu("Options for Research"))
        compose.onNode(row).performClick()
        await { exists(hasRowMenu("Options for Filed row")) }
        compose.onNode(hasText("Research") and hasAnyAncestor(hasTestTag("app-bar")), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Alpha") and hasAnyAncestor(hasTestTag("app-bar")), useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Back").assertExists()
        compose.onNodeWithContentDescription("Start a new session in Research").assertExists()
        compose.onAllNodesWithTag("session-search").assertCountEquals(0)
        compose.onAllNodes(hasContentDescription("Session scope", substring = true)).assertCountEquals(0)
        compose.onAllNodesWithTag("needs-you-bar").assertCountEquals(0)
        // Its ⋯ opens the folder's dialog, which holds a text field and never settles in Robolectric: DirectoryDeviceTest presses it.
        compose.onNodeWithContentDescription("Folder actions").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("folder-row:34A05cFolderEmpty0001")) }
        compose.onNodeWithTag("folder-row:34A05cFolderEmpty0001").performClick()
        await { exists(hasText("Nothing in this folder")) }
    }

    /** No connection: the rows stay and the list says nothing. The drawer heads its workspaces with why, in iOS's words. */
    @Test fun offlineTheRowsStayAndTheDrawerSaysWhy() {
        signIn()
        await { exists(plain) }
        compose.onAllNodesWithTag("drawer-unreachable", useUnmergedTree = true).assertCountEquals(0)
        app().realtime.setNetwork(false)
        await { app().realtime.state.value.controlConnection == ConnectionState.STOPPED && exists(hasTestTag("drawer-unreachable"), unmerged = true) }
        compose.onNode(plain).assertExists()
        compose.onNodeWithContentDescription("Start a new session with Alpha").assertIsEnabled()
        openDrawer()
        compose.onNodeWithText("Can't reach Orbit").assertIsDisplayed()
        compose.onNodeWithText("Couldn't load workspaces").assertIsDisplayed()
        compose.onNode(hasText("Retry") and hasClickAction()).assertIsDisplayed()
        app().realtime.setNetwork(true, "fixture")
        await { app().realtime.state.value.directoryFresh && !exists(hasTestTag("drawer-unreachable"), unmerged = true) }
    }

    /** A read that fails is the same: rows kept, a word in the drawer, and its Retry reads again. */
    @Test fun aReadThatFailsKeepsTheRowsAndItsRetryReadsAgain() {
        signIn()
        await { exists(plain) }
        NavShell.failWorkspaces = 500
        app().realtime.refreshDirectory()
        await { app().realtime.state.value.directoryError != null && exists(hasTestTag("drawer-unreachable"), unmerged = true) }
        compose.onNode(plain).assertExists()
        compose.onAllNodesWithText("Workspaces couldn't be loaded").assertCountEquals(0)
        openDrawer()
        await { exists(hasText("Retry") and hasClickAction()) }
        // Not the wait of the store's backoff, which nothing moves here: the press is what reads.
        NavShell.failWorkspaces = null
        compose.onNode(hasText("Retry") and hasClickAction()).performClick()
        await { app().realtime.state.value.directoryFresh && !exists(hasTestTag("drawer-unreachable"), unmerged = true) }
    }

    /** Deleted from its settings with the directory's read still out, so the list still names it: the app lands on what is left, and never
     * back on the workspace it has just deleted. */
    @Test fun deletingAWorkspaceLandsOnAnotherAndNotBackOnIt() {
        signIn()
        await { exists(plain) }
        compose.pickFromSessionOptions("Settings")
        val delete = hasText("Delete agent") and hasClickAction()
        await { exists(delete) }
        NavShell.holdOpen = CompletableDeferred()
        compose.onNode(delete).performScrollTo().performClick()
        await { exists(delete and hasAnyAncestor(isDialog())) }
        compose.onNode(delete and hasAnyAncestor(isDialog())).performClick()
        await { NavShell.calls.contains("DELETE workspaces/${NavShell.ALPHA}") && exists(hasText("Beta") and hasAnyAncestor(hasTestTag("app-bar"))) }
        compose.onNode(drawerRow("Alpha")).assertExists()
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    private fun menuRows(): List<String> = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
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
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000) { compose.waitForIdle(); condition() }
}
