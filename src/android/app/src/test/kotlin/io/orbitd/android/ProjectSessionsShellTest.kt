package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
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

/** A05-6 and A05-7 in the production shell (iOS 164d91245, 86b2ceaa4, 609d4f226, 859fc2e0c, ff3711fdf, aa163019d): a workspace's list
 * draws a project's sessions as one row in its coordinator's place, saying what they say; the row opens the project's sessions page
 * over the list, and Back returns to it; the drawer's project row opens that page as its destination's root. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectSessionsShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    @Test fun theListDrawsTheProjectsSessionsAsOneRowInTheirWords() {
        signIn(); openAlpha()
        // The coordinator and the running member are the project's row; the ordinary session keeps its own.
        compose.onAllNodesWithContentDescription("Options for Coordinate launch").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Options for Wire tests").assertCountEquals(0)
        await { exists(hasContentDescription("Options for Plain notes")) }
        val row = compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}")
        row.assert(hasText("Launch", substring = true))
        // A member in Beta waits on you: the row says so in its words, and its own dot stays this workspace's — a member runs here.
        compose.onNode(hasTestTag("project-row-line") and hasText("Waiting for your confirmation · Quota retry"), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("3/8") and hasAnyAncestor(hasTestTag("project-progress-chip")), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-row-running", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithTag("project-row-needs-you", useUnmergedTree = true).assertCountEquals(0)
        assertEquals("Session running", row.fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
    }

    @Test fun theRowOpensTheProjectsSessionsOverTheListAndBackReturnsToIt() {
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText("Shipped docs")) }
        compose.onNodeWithContentDescription("Back").assertExists()
        // The bar: the project's name over "Project · N sessions", and the button that opens its page.
        await { exists(hasText("Launch") and hasText("Project · 4 sessions")) }
        compose.onNodeWithContentDescription("Open Project").assertExists()
        // Read across workspaces, by project: Open and Completed together, the coordinator first, the rest by recency.
        assertTrue(ProjectShell.calls.any { it == "GET sessions?view=open&projectId=${ProjectShell.LAUNCH}&includeLanding=1" })
        assertTrue(ProjectShell.calls.any { it == "GET sessions?view=completed&projectId=${ProjectShell.LAUNCH}&includeLanding=1" })
        assertEquals(listOf("Coordinator", "Coordinate launch", "Today", "Wire tests", "Quota retry", "2–7 days ago", "Shipped docs"), pageLines())
        compose.onNode(hasTestTag("project-sessions-progress-line") and hasText("3/8 done · 1 running")).assertExists()
        // A task landing on the project branch is a card of its own under the progress card (A11-11), no longer a row of it.
        await { exists(hasTestTag("landing-card")) }
        compose.onNode(hasTestTag("landing-card:what") and hasText("Wire the page"), useUnmergedTree = true).assertExists()
        compose.onAllNodes(hasTestTag("landing-card") and hasAnyAncestor(hasTestTag("project-sessions-progress"))).assertCountEquals(0)
        // No page search and no New session on the page.
        compose.onAllNodes(hasText("Search sessions") and hasAnyAncestor(hasTestTag("project-sessions"))).assertCountEquals(0)
        compose.onAllNodes(hasText("New session") and hasAnyAncestor(hasTestTag("project-sessions"))).assertCountEquals(0)
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
        compose.onAllNodesWithTag("project-sessions").assertCountEquals(0)
    }

    /** A11-11 (iOS 749d995c5, owner decision 2026-10-11): the landing in flight is a card of its own under the progress card, in the
     * merged line's anatomy — the ring turning, "Landing", the live clock, the state and the freshness under it — then the task, and
     * the sentence that takes the reader off the hook. From a server that lists no jobs its press opens the project's page. */
    @Test fun theLandingInFlightIsACardOfItsOwnUnderTheProgressCard() {
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("landing-card")) }
        val progress = compose.onNodeWithTag("project-sessions-progress").fetchSemanticsNode().boundsInRoot
        val card = compose.onNodeWithTag("landing-card").fetchSemanticsNode().boundsInRoot
        assertTrue("the card is under the progress card: $progress / $card", card.top >= progress.bottom)
        compose.onNode(hasTestTag("landing-head:title") and hasText("Landing"), useUnmergedTree = true).assertExists()
        compose.onNode(hasTestTag("landing-head:detail") and hasText("checking · updated just now"), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Nothing to do — it lands on its own.") and hasAnyAncestor(hasTestTag("landing-card")), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-card:body").performClick()
        await { exists(hasTestTag("project-detail")) }
    }

    /** A11-13: both start sheets of this page draw the plan by the card's rule — the task graph while it fits at 0.7, the levels and a
     * "Task graph" press otherwise — off the dependency graph they read as they open. */
    @Test fun theCoordinatorsStartSheetListsAWidePlanByLevelWithTheTaskGraphAPressAway() {
        ProjectShell.started = false; ProjectShell.startRequest = true
        ProjectShell.plan = graph(listOf("a" to "A · Contract", "b" to "B · Server", "c" to "C · Web", "d" to "D · Android"), listOf("a" to "b", "a" to "c", "a" to "d"))
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-review-start")) }
        compose.onNodeWithTag("project-sessions-review-start").performClick()
        await { exists(hasTestTag("project-start-request-task-graph")) }
        compose.onNodeWithTag("project-start-request-plan-graph").assertDoesNotExist()
        compose.onNodeWithTag("project-start-request-level:2").assertExists()
        compose.onNodeWithTag("project-start-request-task-graph").performScrollTo().performClick()
        await { exists(hasTestTag("project-graph-fullscreen")) }
    }

    @Test fun theOwnersStartSheetDrawsAPlanThatFitsAsTheTaskGraph() {
        ProjectShell.started = false
        ProjectShell.plan = graph(listOf("a" to "A · Contract", "b" to "B · Server"), listOf("a" to "b"))
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-start-own")) }
        compose.onNodeWithTag("project-sessions-start-own").performClick()
        await { exists(hasTestTag("project-start-plan-graph")) }
        compose.onNodeWithTag("project-start-task-graph").assertDoesNotExist()
        compose.onNode(hasText("PLAN · 2 TASKS") and hasAnyAncestor(hasTestTag("project-start-sheet"))).assertExists()
    }

    private fun graph(tasks: List<Pair<String, String>>, edges: List<Pair<String, String>>) = """{"marks":[${tasks.joinToString(",") { (id, title) ->
        """{"kind":"TASK","id":"$id","taskId":"$id","title":"$title","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true}""" }}],
        "edges":[${edges.joinToString(",") { (s, t) -> """{"sourceMarkId":"$s","targetMarkId":"$t"}""" }}],"taskCount":${tasks.size},"truncated":false}"""

    @Test fun theRowsMenuOpensTheSessionItSpeaksForItsSessionsAndItsProject() {
        signIn(); openAlpha()
        rowMenu()
        assertEquals(listOf("Open Session", "Sessions", "Open Project", "Pin", "Move…", "Close"), dialogButtons())
        compose.onNode(hasText("Open Session") and hasAnyAncestor(isDialog())).performClick()
        // The member in Beta the line names opens over the list.
        await { ProjectShell.calls.any { it == "GET sessions/${ProjectShell.WAITING}" } }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
        rowMenu(); compose.onNode(hasText("Sessions") and hasAnyAncestor(isDialog())).performClick()
        await { exists(hasTestTag("project-sessions")) }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
        rowMenu(); compose.onNode(hasText("Open Project") and hasAnyAncestor(isDialog())).performClick()
        await { exists(hasTestTag("project-detail")) }
        compose.onNodeWithContentDescription("Back").assertExists()
    }

    /** Pin and Move act on the coordinator; its pin is a write on the coordinator's session. */
    @Test fun pinFromTheRowPinsTheCoordinator() {
        signIn(); openAlpha()
        rowMenu(); compose.onNode(hasText("Pin") and hasAnyAncestor(isDialog())).performClick()
        await { ProjectShell.calls.any { it == "POST sessions/${ProjectShell.COORD}/pin" } }
    }

    /** A project's member is listed where its coordinator is: of its sessions, only the coordinator's row offers Move…. */
    @Test fun aMembersMenuHasNoMoveAndTheCoordinatorsHasIt() {
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasContentDescription("Options for Wire tests")) }
        compose.onNodeWithContentDescription("Options for Wire tests").performClick()
        await { exists(hasText("Rename") and hasAnyAncestor(isDialog())) }
        assertFalse(dialogButtons().contains("Move…"))
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Options for Coordinate launch").performClick()
        await { exists(hasText("Rename") and hasAnyAncestor(isDialog())) }
        assertTrue(dialogButtons().contains("Move…"))
    }

    @Test fun aMemberOpensOverThePageAndTheProjectButtonOpensItsPage() {
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasText("Shipped docs") and hasClickAction()) }
        compose.onNode(hasText("Shipped docs") and hasClickAction()).performClick()
        await { ProjectShell.calls.any { it == "GET sessions/${ProjectShell.DONE}" } }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-sessions")) }
        compose.onNodeWithContentDescription("Open Project").performClick()
        await { exists(hasTestTag("project-detail")) }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-sessions")) }
    }

    /** The drawer's project row: the project's sessions page as its destination's root — the drawer's button, not Back, leads it. */
    @Test fun theDrawersProjectRowOpensTheSessionsPageAsItsRoot() {
        signIn(); openAlpha()
        openDrawer(); await { exists(drawerRow("Launch")) }
        compose.onNode(drawerRow("Launch")).performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText("Shipped docs")) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        openDrawer(); compose.onNode(drawerRow("Launch")).assertIsSelected(); compose.onNode(drawerRow("Alpha")).assertIsNotSelected()
    }

    @Test fun aProjectNobodyStartedSaysSoAndItsCoordinatorsRequestOpensTheStartCard() {
        ProjectShell.started = false; ProjectShell.startRequest = true
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-review-start")) }
        compose.onNode(hasTestTag("project-sessions-progress-line") and hasText("Not started · 8 tasks")).assertExists()
        compose.onNode(hasText("Ready to start") and hasAnyAncestor(hasTestTag("project-sessions-start"))).assertExists()
        compose.onNode(hasText("Project branch · Automatic on · 3 at a time")).assertExists()
        compose.onNode(hasText("asked 2h ago")).assertExists()
        compose.onNodeWithTag("project-sessions-review-start").assert(hasText("Review and start"))
            .assert(SemanticsMatcher("its hint") { it.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.OnClick)?.label ==
                "Opens the start card: the criteria, the plan and how it runs." })
        compose.onNodeWithTag("project-sessions-review-start").performClick()
        await { exists(hasTestTag("project-start-request-sheet")) }
    }

    @Test fun nobodyAskingLeavesTheOwnersOwnStart() {
        ProjectShell.started = false
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-start-own")) }
        compose.onNode(hasText("The coordinator hasn’t asked yet")).assertExists()
        compose.onNodeWithTag("project-sessions-start-own").assert(hasText("Start…")).performClick()
        await { exists(hasTestTag("project-start-sheet")) }
    }

    /** A project with no sessions says so; one whose sessions cannot be read says why, with Retry. */
    @Test fun anEmptyProjectSaysSoAndAFailedReadSaysWhyWithRetry() {
        signIn(); openAlpha()
        openDrawer(); await { exists(drawerRow("Quiet")) }
        compose.onNode(drawerRow("Quiet")).performClick()
        await { exists(hasTestTag("project-sessions-empty")) }
        compose.onNodeWithText("No sessions").assertExists()
        ProjectShell.quietStatus = 500
        openDrawer(); compose.onNode(drawerRow("Alpha")).performClick()
        openDrawer(); compose.onNode(drawerRow("Quiet")).performClick()
        await { exists(hasText("Couldn't load sessions")) }
        compose.onNodeWithText("The project's sessions are unavailable.").assertExists()
        ProjectShell.quietStatus = 200
        compose.onNodeWithText("Retry").performClick()
        await { exists(hasTestTag("project-sessions-empty")) }
    }

    /** A05-7's ending (docs/mocks/project-done-sessions-page, owner decision 2026-10-10): a project that is done draws
     * "This project is done" where its progress card was — the same settled card the conversation draws — off the document the page
     * reads for that state alone (the sidebar's rows are the Open projects, so a done one has none). */
    @Test fun aProjectThatIsDoneDrawsItsEndingInTheProgressCardsPlace() {
        ProjectShell.done = true
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-ending-settled")) }
        val ending = hasAnyAncestor(hasTestTag("project-sessions-ending-settled"))
        compose.onNode(hasText("This project is done") and ending, useUnmergedTree = true).assertExists()
        compose.onNode(hasText("recorded by Orbit") and ending, useUnmergedTree = true).assertExists()
        compose.onNode(hasTestTag("project-sessions-ending-settled-tally"), useUnmergedTree = true)
            .assert(hasText("6 criteria · 5 on main · 1 no code to land"))
        // The card it stands in for — one that would say nothing but "Done" — is gone, and the document was read for it.
        compose.onAllNodesWithTag("project-sessions-progress").assertCountEquals(0)
        assertTrue(ProjectShell.calls.any { it == "GET projects/${ProjectShell.LAUNCH}" })
        // The members are still the page's own list, drawn under the ending.
        await { exists(hasText("Shipped docs")) }
    }

    /** The ending's badge follows the recorder, and a read without the projection's counts — a server before the owner's done door —
     * keeps the progress card, which then says the status the members carry. */
    @Test fun theEndingNamesItsRecorderAndAnOlderReadKeepsTheProgressCard() {
        ProjectShell.done = true; ProjectShell.doneBy = "OWNER"; ProjectShell.doneCounts = false
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions-progress-line") and hasText("Done")) }
        compose.onAllNodesWithTag("project-sessions-ending-settled").assertCountEquals(0)
        // The current read, recorded by the owner: the same ending, spelled by its badge.
        ProjectShell.doneCounts = true
        await { exists(hasTestTag("project-sessions-ending-settled")) }
        compose.onNode(hasText("recorded by you") and hasAnyAncestor(hasTestTag("project-sessions-ending-settled")),
            useUnmergedTree = true).assertExists()
        compose.onAllNodesWithTag("project-sessions-progress").assertCountEquals(0)
    }

    /** A05-9 (iOS 62b7009ca): a member moved to Trash leaves the page on the press, and the project's row in the list with it — the
     * row stops saying a member runs here — while the server has yet to answer. */
    @Test fun aMemberMovedToTrashLeavesThePageAndItsProjectRowOnThePress() {
        signIn(); openAlpha()
        compose.onNodeWithTag("project-row-running", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        await { exists(hasText("Project · 4 sessions")) && exists(hasContentDescription("Options for Wire tests")) }
        val answer = CompletableDeferred<Unit>()
        ProjectShell.holdDelete = answer
        memberAction("Wire tests", "Move to Trash")
        settled { ProjectShell.calls.any { it == "DELETE sessions/${ProjectShell.WORKER}" } }
        compose.onAllNodesWithContentDescription("Options for Wire tests").assertCountEquals(0)
        await { exists(hasText("Project · 3 sessions")) }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
        compose.onAllNodesWithTag("project-row-running", useUnmergedTree = true).assertCountEquals(0)
        assertFalse(toastShows("Moved to Trash"))
        answer.complete(Unit)
        await { toastShows("Moved to Trash") }
        settled { app().trashing.ids.value.isEmpty() }
        compose.onAllNodesWithTag("project-row-running", useUnmergedTree = true).assertCountEquals(0)
    }

    /** A05-9: a member read that left before a move to Trash settled — here the page's first read, still out when the move was taken
     * and let go — answers with the row in its Completed list. It is read again rather than written, so the row stays gone. */
    @Test fun aMemberReadFromBeforeTheMoveSettledDoesNotPutTheRowBack() {
        signIn(); openAlpha()
        val early = CompletableDeferred<Unit>()
        ProjectShell.holdMembers = early
        compose.onNodeWithTag("project-row:${ProjectShell.LAUNCH}").performClick()
        settled { completedReads() == 1 }
        ProjectShell.holdMembers = null
        // Drawn from the app's own lists while the page's read is out.
        await { exists(hasContentDescription("Options for Shipped docs")) }
        memberAction("Shipped docs", "Move to Trash")
        await { toastShows("Moved to Trash") }
        settled { app().trashing.ids.value.isEmpty() && app().trashing.releases == 1L }
        compose.onAllNodesWithContentDescription("Options for Shipped docs").assertCountEquals(0)
        val before = completedReads()
        early.complete(Unit)
        settled { completedReads() > before }
        compose.waitForIdle()
        compose.onAllNodesWithContentDescription("Options for Shipped docs").assertCountEquals(0)
        await { exists(hasText("Project · 3 sessions")) }
    }

    /** A11-2's rest: a drawer project row counts what waits on you as M2's iOS does (`ProjectAttention.drawerMark`, a
     * `NeedsYouCountCapsule`) — the four owner items by their counts, the coordinator asking to start the project, and asking to
     * record it done — and a project with nothing waiting carries no count. */
    @Test fun aDrawerProjectRowCountsWhatWaitsOnYou() {
        val since = "2026-10-05T00:00:00Z"
        ProjectShell.attention = """{"ownerItems":[{"kind":"COORDINATOR_QUESTION","count":1,"oldestWaitingSince":"$since"},
            {"kind":"ESCALATED","count":2,"oldestWaitingSince":"$since"},{"kind":"SOMETHING_NEW","count":4,"oldestWaitingSince":"$since"}],
            "startRequest":{"waitingSince":"$since"},"doneRequest":{"waitingSince":"$since"}}"""
        signIn(); openAlpha()
        openDrawer(); await { exists(drawerRow("Launch")) }
        await { compose.onAllNodesWithTag("drawer-project-needs-you:${ProjectShell.LAUNCH}", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("drawer-project-needs-you:${ProjectShell.LAUNCH}", useUnmergedTree = true).assert(hasContentDescription("5 waiting for you"))
        compose.onAllNodesWithTag("drawer-project-needs-you:${ProjectShell.QUIET}", useUnmergedTree = true).assertCountEquals(0)
        compose.onNode(drawerRow("Launch")).assert(hasContentDescription("5 waiting for you"))
    }

    /** A05f: the drawer's projects as M2's iOS draws them (`CompactShell.projectRows`, `projectRow`, `projectsRow`): under "Projects" and
     * how many there are; the one waiting on you first, though the server lists it last (`ProjectAttention.drawerProjects`); the other
     * marked running, its coordinator's turn under way in the Open list (`drawerMark`, `coordinatorPulses`); and the Projects row
     * counting the projects waiting on you, not their items (`needsYouCount`). The spinner turns only while the drawer is on screen. */
    @Test fun theDrawersProjectsAreHeadedOrderedMarkedAndCountedAsOnIOS() {
        ProjectShell.coordinatorWorking = true
        ProjectShell.quietAttention = """{"ownerItems":[{"kind":"COORDINATOR_QUESTION","count":2,"oldestWaitingSince":"2026-10-05T00:00:00Z"}]}"""
        signIn(); openAlpha()
        openDrawer(); await { exists(drawerRow("Quiet")) && exists(drawerRow("Launch")) }
        await { compose.onAllNodesWithTag("drawer-project-running:${ProjectShell.LAUNCH}", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("drawer-group:Projects").assert(hasText("Projects")).assert(hasText("2"))
        assertEquals(listOf("Quiet", "Launch"), drawerProjectRows())
        compose.onNode(drawerRow("Launch")).assert(hasContentDescription("Running"))
        compose.onNode(drawerRow("Quiet")).assert(hasContentDescription("2 waiting for you"))
        compose.onNodeWithTag("projects-drawer-count", useUnmergedTree = true).assert(hasText("1")).assert(hasContentDescription("1 waiting on you"))
        compose.onNode(drawerRow("Projects")).assert(hasContentDescription("1 waiting on you"))
        // Closed, the drawer stays composed: its spinner goes, its counts stay.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onAllNodesWithTag("drawer-project-running:${ProjectShell.LAUNCH}", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithTag("drawer-project-needs-you:${ProjectShell.QUIET}", useUnmergedTree = true).assertExists()
    }

    /** A wait on the fixture or the store, not the screen: it idles the UI on every look, or the store's coroutines (on the main
     * looper) would never run. */
    private fun settled(condition: () -> Boolean) = await { compose.waitForIdle(); condition() }
    private fun completedReads() = ProjectShell.calls.count { it == "GET sessions?view=completed&projectId=${ProjectShell.LAUNCH}&includeLanding=1" }
    private fun toastShows(text: String) = exists(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    private fun memberAction(session: String, action: String) {
        compose.onNodeWithContentDescription("Options for $session").performScrollTo().performClick()
        await { exists(hasText(action) and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText(action) and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        compose.waitForIdle()
    }
    private fun pageLines(): List<String> = compose.onAllNodes(hasAnyAncestor(hasTestTag("project-sessions"))).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
        .filter { it in setOf("Coordinator", "Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older", "Coordinate launch", "Wire tests", "Quota retry", "Shipped docs") }
    private fun dialogButtons(): List<String> = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun rowMenu() {
        compose.onNodeWithContentDescription("Options for Launch").performClick()
        await { exists(hasText("Open Session") and hasAnyAncestor(isDialog())) }
    }
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    /** The drawer's project rows, top to bottom. */
    private fun drawerProjectRows() = compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.map { it.text }?.firstOrNull { it == "Launch" || it == "Quiet" } }
    private fun openDrawer() { compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle() }
    private fun openAlpha() {
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
    }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
