package io.orbitd.android

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.time.Instant
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

/** A11-9 in the production shell (iOS 6b4bef713, 39adc7561): the merge into main is on the project's sessions page — a card under the
 * progress card at each of its four moments, pressed there, and the merges already made among the sessions, each opening its receipt
 * — and the coordinator conversation keeps one line per moment, opening the same review and the same receipt. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectMergeShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun candidate(state: String, conflicts: String = "[]", execution: String? = null) = """{"promotionId":"pr-1","state":"$state",
        "sourceRef":"refs/heads/project/launch","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":7,"filesChanged":10,
        "taskIds":["t1","t2","t3","t4"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs off by default"},
        {"taskId":"t3","title":"P6 end to end"},{"taskId":"t4","title":"P7 rehearsal"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],
        "conflicts":$conflicts,"landsAs":"MERGE_COMMIT","askedAt":"${ago(130)}","merged":null${execution?.let { ",\"execution\":$it" }.orEmpty()}}"""
    private val criteria = """[{"key":"c1","text":"Notes exist","satisfied":true},{"key":"c2","text":"Contract written","satisfied":true},
        {"key":"c3","text":"Smoke passes","satisfied":false}]"""

    /** A: what would land, the proof it was checked and the two presses; Merge to main carries the candidate's own SHA. */
    @Test fun theAskingCardIsPressedOnTheSessionsPage() {
        ProjectShell.promotion = candidate("READY"); ProjectShell.criteria = criteria
        openPage()
        await { exists(hasTestTag("project-merge-card:asking")) }
        assertEquals(listOf("progress", "merge", "coordinator"), pageOrder())
        title("Merge into main?")
        inCard("Needs you"); inCard("project/launch · 7 commits ahead of main"); inCard("4 tasks · 10 files")
        assertEquals(listOf("Fix D1", "Logs off by default", "P6 end to end"), texts("project-merge-card:task"))
        inCard("+1 more"); inCard("✓ Checks passed · no conflicts")
        // The clocks are the core tests' to pin; here the footnote says when it was asked.
        await { exists(hasText("asked 2h 1", substring = true) and hasAnyAncestor(hasTestTag("project-merge-card:asking")), unmerged = true) }
        await { exists(hasTestTag("project-merge-card:criteria") and hasText("2 of 3 met on this branch — merging does not close the project")) }
        compose.onNodeWithTag("project-merge-card:confirm").assert(hasText("Merge to main")).performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/confirm") }
        assertEquals("""{"sourceSha":"5e5bfca23aa1"}""", ProjectShell.bodies["POST projects/$launch/promotions/pr-1/confirm"])
        // B: the door's answer is drawn at once — under way, with Cancel while its job has not reached the push.
        await { exists(hasTestTag("project-merge-card:merging")) }
        title("Merge into main confirmed")
        inCard("confirmed — waiting for merge execution")
        inCard("Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t.")
        compose.onNodeWithTag("project-merge-card:mark:merge", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-merge-card:cancel").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/cancel") }
        await { !exists(hasTestTag("project-merge-card:merging")) }
    }

    @Test fun notNowAnswersTheCandidateAndTheCardGoes() {
        ProjectShell.promotion = candidate("READY")
        openPage()
        await { exists(hasTestTag("project-merge-card:decline")) }
        compose.onNodeWithTag("project-merge-card:decline").assert(hasText("Not now")).performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/decline") }
        await { !exists(hasTestTag("project-merge-card:asking")) }
    }

    /** A press the server refused says so under the card, in the console's words, and the card stays as the server has it. */
    @Test fun aRefusedPressSaysWhyUnderTheCard() {
        ProjectShell.promotion = candidate("READY"); ProjectShell.pressStatus = 409
        openPage()
        await { exists(hasTestTag("project-merge-card:confirm")) }
        compose.onNodeWithTag("project-merge-card:confirm").performClick()
        await { exists(hasTestTag("project-merge-card:error")) }
        compose.onNodeWithTag("project-merge-card:error").assert(hasText("That merge was not confirmed — The candidate moved on."))
        compose.onNodeWithTag("project-merge-card:asking").assertExists()
    }

    /** Before anything is asked, the merge check's live line is the card — grey — and no longer the progress card's. */
    @Test fun theMergeCheckRunningIsTheCardsLineNotTheProgressCards() {
        ProjectShell.mergeCheck = true
        openPage()
        await { exists(hasTestTag("project-merge-card:checking")) }
        await { exists(hasText("Merge check", substring = true) and hasAnyAncestor(hasTestTag("landing-row")) and
            hasAnyAncestor(hasTestTag("project-merge-card:checking")), unmerged = true) }
        compose.onAllNodes(hasTestTag("landing-row") and hasAnyAncestor(hasTestTag("project-sessions-progress"))).assertCountEquals(0)
    }

    /** B while its job runs: the step it reached, the job's live line in the card, and a Cancel that goes dead at the push. */
    @Test fun aMergeAtThePushCannotBeCalledBack() {
        ProjectShell.promotion = candidate("CONFIRMED", execution = """{"state":"RUNNING","phase":"PUSH","startedAt":"${ago(1)}"}""")
        openPage()
        await { exists(hasTestTag("project-merge-card:merging")) }
        title("Merging into main…")
        inCard("confirmed — publishing the tested tree to main")
        compose.onNodeWithTag("project-merge-card:cancel").assertIsNotEnabled()
    }

    /** D: why it cannot merge, who has it, the coordinator one press away — and the whole of it in Details. */
    @Test fun theBlockedCardSaysWhyAndWhoHasIt() {
        ProjectShell.promotion = candidate("BLOCKED", conflicts = """["src/a.go","src/b.go"]""")
        ProjectShell.holder = """{"itemId":"item-1","kind":"INTEGRATION_CONFLICT","title":"Merge conflict","waitingSince":"${ago(125)}",
            "assignee":"COORDINATOR","promotionId":"pr-1"}"""
        openPage()
        await { exists(hasTestTag("project-merge-card:blocked")) }
        title("Can’t merge into main yet")
        inCard("2 files conflict with main: src/a.go, src/b.go")
        await { exists(hasText("Coordinator is resolving it · 2h", substring = true) and hasAnyAncestor(hasTestTag("project-merge-card:resolving")), unmerged = true) }
        compose.onNodeWithTag("project-merge-card:mark:warning", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-merge-card:details").performClick()
        await { exists(hasTestTag("project-merge-review")) }
        compose.onNodeWithTag("project-merge-review:title").assert(hasText("Merge to main blocked"))
        await { exists(hasText("2 files conflict with main: src/a.go, src/b.go") and hasAnyAncestor(hasTestTag("project-merge-review"))) }
        compose.onNodeWithTag("project-merge-review:resolving").assertIsNotEnabled()
        compose.onNodeWithTag("project-merge-review:close").performClick()
        await { !exists(hasTestTag("project-merge-review")) }
        compose.onNodeWithTag("project-merge-card:coordinator").performClick()
        await { ProjectShell.calls.contains("GET sessions/${ProjectShell.COORD}") }
    }

    /** Main's 8297b18a3: a blocked candidate nobody holds does not name the coordinator. */
    @Test fun aBlockedCandidateNobodyHoldsHasNoResolvingPress() {
        ProjectShell.promotion = candidate("BLOCKED")
        openPage()
        await { exists(hasTestTag("project-merge-card:blocked")) && ProjectShell.calls.contains("GET projects/$launch/open-items") }
        inCard("the checks on the combined tree did not pass")
        // Once the items have come back without one, nobody is named.
        await { compose.onAllNodesWithTag("project-merge-card:resolving", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("project-merge-card:details").assertExists()
    }

    /** A merge already made is a row on the timeline at its own instant, and opens its receipt: the tasks it put on main by name. */
    @Test fun aMergeAlreadyMadeIsATimelineRowThatOpensItsReceipt() {
        ProjectShell.merged = """[${candidate("MERGED").replace("\"merged\":null",
            "\"merged\":{\"sha\":\"8d5a868e90df\",\"at\":\"${ago(7)}\",\"automatic\":false,\"revert\":null}")}]"""
        openPage()
        await { exists(hasTestTag("project-merge-row:pr-1")) }
        assertNull("a merge already made draws no card", compose.onAllNodes(hasTestTag("project-merge-card:asking")).fetchSemanticsNodes().firstOrNull())
        // Today: the members by recency, and the merge in front of the first one older than it.
        assertEquals(listOf("Today", "Wire tests", "MERGE", "Quota retry", "2–7 days ago", "Shipped docs"), timeline())
        compose.onNode(hasTestTag("project-merge-row:pr-1")).assert(hasText("Merged into main", substring = true))
            .assert(hasText("8d5a868 · 4 tasks · by you", substring = true)).assert(hasText("m ago", substring = true)).performClick()
        await { exists(hasTestTag("promotion-receipt")) }
        compose.onNodeWithTag("promotion-receipt:title").assert(hasText("✓ Merged into main"))
        await { exists(hasText("8d5a868 · merge of project/launch · by you · ", substring = true) and hasAnyAncestor(hasTestTag("promotion-receipt"))) }
        for (line in listOf("FROM ORBIT", "4 tasks", "Fix D1", "P7 rehearsal",
                "✓ Passed on the combined tree · npm test · 6m 12s", "exactly the tested tree 5e5bfca · as a merge commit", "7 commits · 10 files")) {
            await { exists(hasText(line) and hasAnyAncestor(hasTestTag("promotion-receipt"))) }
        }
        compose.onAllNodes(hasText("Undo") and hasAnyAncestor(hasTestTag("promotion-receipt"))).assertCountEquals(0)
    }

    /** Details opens the conversation's own review over the page, read off the page's model and pressed there. */
    @Test fun detailsOpensTheReviewWithEveryRowAndItsPresses() {
        ProjectShell.promotion = candidate("READY"); ProjectShell.criteria = criteria
        openPage()
        await { exists(hasTestTag("project-merge-card:details")) }
        compose.onNodeWithTag("project-merge-card:details").performClick()
        await { exists(hasTestTag("project-merge-review")) }
        compose.onNodeWithTag("project-merge-review:title").assert(hasText("Merge to main"))
        for (line in listOf("project/launch · 7 commits ahead of main", "4 landed on the branch", "Fix D1", "Logs off by default", "P6 end to end", "P7 rehearsal",
                "✓ Passed on the combined tree · npm test · 6m 12s", "no conflicts", "exactly the tested tree 5e5bfca · as a merge commit", "10 files")) {
            await { exists(hasText(line) and hasAnyAncestor(hasTestTag("project-merge-review"))) }
        }
        await { exists(hasText("2 of 3 met on this branch — merging does not close the project") and hasAnyAncestor(hasTestTag("project-merge-review"))) }
        compose.onNodeWithTag("project-merge-review:DECLINE_MERGE").assert(hasText("Not now")).performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/decline") }
        await { !exists(hasTestTag("project-merge-review")) }
    }

    /** The coordinator conversation: the candidate is one line that opens the same review, pressed through the conversation's doors,
     * and the merge already made is one line that opens its receipt. */
    @Test fun theConversationKeepsOneLinePerMoment() {
        ProjectShell.promotion = candidate("READY")
        ProjectShell.merged = """[${candidate("MERGED").replace("\"promotionId\":\"pr-1\"", "\"promotionId\":\"pr-0\"").replace("\"merged\":null",
            "\"merged\":{\"sha\":\"8d5a868e90df\",\"at\":\"${ago(60 * 26)}\",\"automatic\":true,\"revert\":\"git revert -m 1 8d5a868e90df\"}")}]"""
        openPage()
        await { exists(hasText("Coordinate launch") and hasClickAction()) }
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
        await { exists(hasTestTag("promotion:pr-1:preview"), unmerged = true) }
        await { exists(hasText("Merge into main is waiting for you"), unmerged = true) && exists(hasText("· Review"), unmerged = true) }
        compose.onAllNodes(hasText("View details & act")).assertCountEquals(0)
        compose.onNodeWithTag("promotion:pr-1:preview").performClick()
        await { exists(hasTestTag("card-review")) && exists(hasTestTag("promotion:pr-1:CONFIRM_MERGE")) }
        await { exists(hasText("Fix D1") and hasAnyAncestor(hasTestTag("promotion-review"))) }
        compose.onNodeWithTag("card-review:title").assert(hasText("Merge to main"))
        await { compose.onAllNodes(hasTestTag("promotion:pr-1:CONFIRM_MERGE") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("promotion:pr-1:CONFIRM_MERGE").assert(hasText("Merge to main")).performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/confirm") || exists(hasTestTag("promotion:pr-1:error")) }
        assertTrue("the conversation's door refused: ${texts("promotion:pr-1:error")}", ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/confirm"))
        assertEquals("""{"sourceSha":"5e5bfca23aa1"}""", ProjectShell.bodies["POST projects/$launch/promotions/pr-1/confirm"])
        compose.onNodeWithTag("card-review:close").performClick()
        await { !exists(hasTestTag("card-review")) }
        // The merge already made: its record's line, opening its receipt — an automatic merge says how to take it back out.
        await { exists(hasTestTag("merge:pr-0:line") and hasText("✓ Merged into main · 8d5a868 · 4 tasks · automatically")) }
        compose.onNodeWithTag("merge:pr-0:line").performClick()
        await { exists(hasTestTag("promotion-receipt")) }
        compose.onNodeWithTag("promotion-receipt:title").assert(hasText("✓ Merged into main automatically"))
        await { exists(hasText("git revert -m 1 8d5a868e90df") and hasAnyAncestor(hasTestTag("promotion-receipt"))) }
    }

    private fun title(text: String) = await { exists(hasTestTag("project-merge-card:title") and hasText(text), unmerged = true) }
    private fun inCard(text: String) = await { exists(hasText(text) and hasAnyAncestor(hasTestTagPrefix("project-merge-card:")), unmerged = true) }
    private fun hasTestTagPrefix(prefix: String) = SemanticsMatcher("tag starts with $prefix") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
    private fun texts(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    /** The page's first three blocks, top to bottom. */
    private fun pageOrder(): List<String> {
        fun top(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.top
        val progress = top(hasTestTag("project-sessions-progress"))!!
        val merge = top(hasTestTagPrefix("project-merge-card:asking"))!!
        val coordinator = top(hasText("Coordinator") and hasAnyAncestor(hasTestTag("project-sessions")))!!
        return listOf("progress" to progress, "merge" to merge, "coordinator" to coordinator).sortedBy { it.second }.map { it.first }
    }
    /** The timeline under the coordinator: section titles, members, and MERGE for a merge's row. */
    private fun timeline(): List<String> = compose.onAllNodes(hasAnyAncestor(hasTestTag("project-sessions-list")) or hasTestTagPrefix("project-merge-row:"))
        .fetchSemanticsNodes().mapNotNull { node ->
            val tag = node.config.getOrNull(SemanticsProperties.TestTag)
            if (tag?.startsWith("project-merge-row:") == true) "MERGE"
            else node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text
                ?.takeIf { it in setOf("Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older", "Wire tests", "Quota retry", "Shipped docs") }
        }
    private fun openPage() {
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:$launch")) }
        compose.onNodeWithTag("project-row:$launch").performClick()
        // The coordinator's row: a merge card above it can push the last members out of the lazy list's composed rows.
        await { exists(hasTestTag("project-sessions")) && exists(hasText("Coordinate launch") and hasClickAction()) }
    }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
