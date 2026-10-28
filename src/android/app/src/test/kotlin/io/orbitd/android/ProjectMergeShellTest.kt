package io.orbitd.android

import android.app.NotificationManager
import android.content.Intent
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.push.PushMessage
import io.orbitd.android.push.PushNotifications
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A11-9 in the production shell (iOS 6b4bef713, 39adc7561): the merge into main is on the project's sessions page — a card under the
 * progress card at each of its four moments, pressed there, and the merges already made among the sessions, each opening its receipt
 * — and the coordinator conversation keeps one line per moment, opening the same review and the same receipt. */
@RunWith(RobolectricTestRunner::class)
// Taller than a phone: with the landing card (A11-11) the page's cards and its timeline no longer all compose at 891 dp.
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1400dp")
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
    /** The owner item a merge's push names (`openItemID`). */
    private val mergeItem = "019a11a9-0000-7000-8000-000000000001"
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun candidate(state: String, conflicts: String = "[]", execution: String? = null, extra: String = "") = """{"promotionId":"pr-1","state":"$state",
        "sourceRef":"refs/heads/project/launch","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":7,"filesChanged":10,
        "taskIds":["t1","t2","t3","t4"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs off by default"},
        {"taskId":"t3","title":"P6 end to end"},{"taskId":"t4","title":"P7 rehearsal"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],
        "conflicts":$conflicts,"landsAs":"MERGE_COMMIT","askedAt":"${ago(130)}","merged":null${execution?.let { ",\"execution\":$it" }.orEmpty()}$extra}"""
    private val criteria = """[{"key":"c1","text":"Notes exist","satisfied":true},{"key":"c2","text":"Contract written","satisfied":true},
        {"key":"c3","text":"Smoke passes","satisfied":false}]"""

    /** A: what would land, the proof it was checked and the two presses; Merge to main carries the candidate's own SHA. */
    @Test fun theAskingCardIsPressedOnTheSessionsPage() {
        ProjectShell.promotion = candidate("READY"); ProjectShell.criteria = criteria
        openPage()
        await { exists(hasTestTag("project-merge-card:asking")) }
        // The task landing on the project branch is its own card, between the progress card and the merge card (A11-11).
        assertEquals(listOf("progress", "landing", "merge", "coordinator"), pageOrder())
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

    /** Before anything is asked, the merge check's live line is the card — grey — wearing the timeline's "Merged into main" row (iOS
     * 3b23aa163): the ring, the word, the live clock at the right and the state under it; and it is not a landing card. */
    @Test fun theMergeCheckRunningIsTheCardsLineNotTheProgressCards() {
        ProjectShell.mergeCheck = true
        openPage()
        await { exists(hasTestTag("project-merge-card:checking")) }
        val head = hasAnyAncestor(hasTestTag("project-merge-card:checking"))
        await { exists(hasTestTag("landing-head:title") and hasText("Merge check") and head, unmerged = true) }
        compose.onNode(hasTestTag("landing-head:detail") and hasText("checking · updated just now") and head, useUnmergedTree = true).assertExists()
        // The live clock at the right: the check started seven minutes before the read, in minutes and seconds.
        compose.onNode(hasTestTag("landing-head:right") and head, useUnmergedTree = true).assert(SemanticsMatcher("a live clock near 7m") { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text?.matches(Regex("[67]m \\d{1,2}s")) == true })
        compose.onNode(hasTestTag("landing-ring:running") and head, useUnmergedTree = true).assertExists()
        compose.onAllNodesWithTag("landing-card").assertCountEquals(0)
        compose.onAllNodes(hasTestTag("landing-head") and hasAnyAncestor(hasTestTag("project-sessions-progress"))).assertCountEquals(0)
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

    /** §3.3 M-T10 (iOS 262153779, web ProjectMergeStrip): a stop asked for on a confirmed merge is the server's `cancelRequested`, never
     * the job's phase. The card says it is cancelling, when the runner stops and that the merge may still go through; the merge job's
     * head carries the clause, Cancel is the dead `Cancel requested` in its place, and the queue's foot goes. Past the push boundary the
     * ask came too late, and the status is the job's own step again. */
    @Test fun aStopAskedForIsTheCancellingCardOnEitherSideOfThePush() {
        fun confirmed(phase: String, extra: String = "") = candidate("CONFIRMED",
            execution = """{"state":"RUNNING","phase":"$phase","startedAt":"${ago(1)}"}""", extra = extra)
        ProjectShell.mergeCheck = true; ProjectShell.mergeJobKind = "LAND_PROMOTION"
        ProjectShell.inFlightJobs = """[{"jobId":"j-merge","kind":"LAND_PROMOTION","state":"RUNNING","phase":"CHECK","taskId":null,"taskTitle":null,
            "promotionId":"pr-1","generation":1,"startedAt":"${ago(1)}","queuedAt":"${ago(2)}","heartbeatAt":"${ago(0)}","runnerName":"wikova",
            "timedOut":false,"limitSeconds":600,"retryable":false},
            {"jobId":"j-task","kind":"LAND_TASK","state":"QUEUED","phase":null,"taskId":"t-2","taskTitle":"Logs off by default","generation":1,
            "startedAt":"${ago(1)}","queuedAt":"${ago(1)}","heartbeatAt":null,"runnerName":null,"timedOut":false,"limitSeconds":null,"retryable":false}]"""
        ProjectShell.promotion = confirmed("CHECK")
        openPage()
        val card = hasAnyAncestor(hasTestTag("project-merge-card:merging"))
        fun headDetail() = compose.onAllNodes(hasTestTag("landing-head:detail") and card, useUnmergedTree = true).fetchSemanticsNodes()
            .firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
        // Nothing asked yet: the merging card as it always was, its Cancel live and the queued landing's way in at its foot.
        await { exists(hasTestTag("project-merge-card:merging")) && exists(hasTestTag("project-merge-card:more-jobs")) }
        title("Re-checking before merging into main…")
        compose.onNodeWithTag("project-merge-card:cancel").assertIsEnabled()
        await { headDetail() != null }
        assertFalse(headDetail()!!.contains("stop requested"))

        // Asked before the push: the cancelling card.
        ProjectShell.promotion = confirmed("CHECK", ""","cancelRequested":true,"pushBoundaryPassed":false""")
        title("Cancelling the merge…")
        compose.onNodeWithTag("project-merge-card:status").assert(hasText("Stops at the runner’s next report, within 30 s · nothing has been pushed"))
        compose.onNodeWithTag("project-merge-card:note").assert(hasText("If the push starts before it stops, the merge goes through and this card says so."))
        compose.onNodeWithTag("project-merge-card:cancel-requested").assertIsNotEnabled().assert(hasText("Cancel requested"))
        assertFalse(exists(hasTestTag("project-merge-card:cancel")))
        assertFalse("a stop asked for draws no queue foot", exists(hasTestTag("project-merge-card:more-jobs"), unmerged = true))
        await { headDetail()?.endsWith(" · stop requested") == true }
        assertTrue(exists(hasTestTag("project-merge-card:open-landing"), unmerged = true))

        // Asked past the push boundary: too late — the push is the fact, so the status line is the job's step again.
        ProjectShell.promotion = confirmed("PUSH", ""","cancelRequested":true,"pushBoundaryPassed":true""")
        title("Too late to cancel — the push has started")
        compose.onNodeWithTag("project-merge-card:status").assert(hasText("confirmed — publishing the tested tree to main"))
        compose.onNodeWithTag("project-merge-card:note").assert(hasText("If the push starts before it stops, the merge goes through and this card says so."))
        compose.onNodeWithTag("project-merge-card:cancel-requested").assertIsNotEnabled()
        assertFalse(exists(hasTestTag("project-merge-card:more-jobs"), unmerged = true))
        assertTrue(headDetail()!!.endsWith(" · stop requested"))
        assertTrue("nothing on the card asked the server for anything", ProjectShell.calls.none { it.startsWith("POST ") })
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

    /** iOS befc9694c: a blocked candidate says who is in front of it when the project's own line is busy — the landing on its branch, and
     * the server's sentence about what holds THAT one — on the card and in the review its Details opens, off the page's landing read. */
    @Test fun theBlockedCardAndItsReviewSayWhatTheMergeIsBehind() {
        ProjectShell.promotion = candidate("BLOCKED", conflicts = """["src/a.go"]""")
        ProjectShell.landTasks = landTasks()
        openPage()
        await { exists(hasTestTag("project-merge-card:blocked-by")) }
        compose.onNodeWithTag("project-merge-card:blocked-by").assert(hasText("Blocked by: $behind"))
        compose.onNodeWithTag("project-merge-card:details").performClick()
        await { exists(hasTestTag("project-merge-review:blocked-by")) }
        listOf("Blocked by", behind).forEach { line ->
            compose.onNode(hasText(line) and hasAnyAncestor(hasTestTag("project-merge-review:blocked-by")), useUnmergedTree = true).assertExists()
        }
        compose.onNodeWithTag("project-merge-review:close").performClick()
        // A line doing nothing on the candidate's branches names nothing.
        ProjectShell.landTasks = landTasks(target = "refs/heads/orbit/elsewhere")
        await { !exists(hasTestTag("project-merge-card:blocked-by")) }
        compose.onNodeWithTag("project-merge-card:why").assert(hasText("1 file conflict with main: src/a.go"))
    }

    /** The coordinator conversation's review of the same blocked candidate says it too: its session read reads the project's line while
     * the candidate is blocked (the coordinator's decision for A11-11, one more read of projects/:id/integration). */
    @Test fun theConversationsReviewOfABlockedCandidateSaysWhatItIsBehind() {
        ProjectShell.promotion = candidate("BLOCKED", conflicts = """["src/a.go"]""")
        ProjectShell.landTasks = landTasks()
        openPage()
        await { exists(hasText("Coordinate launch") and hasClickAction()) }
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
        await { exists(hasTestTag("promotion:pr-1:preview"), unmerged = true) }
        compose.onNodeWithTag("promotion:pr-1:preview").performClick()
        await { exists(hasTestTag("card-review")) && exists(hasTestTag("promotion:pr-1:blocked-by")) }
        listOf("Blocked by", behind).forEach { line ->
            compose.onNode(hasText(line) and hasAnyAncestor(hasTestTag("promotion:pr-1:blocked-by")), useUnmergedTree = true).assertExists()
        }
    }

    private val behind = "“Sync the project line with main” is landing on the project line · queued · " +
        "Waiting to land: the landing of “Fix the 11 Swift failures” is running on this branch first"
    private fun landTasks(target: String = "refs/heads/project/launch") = """[{"taskId":"t9","taskTitle":"Sync the project line with main",
        "integration":{"state":"PENDING_INTEGRATION","landTask":{"jobId":"job-9","state":"QUEUED","phase":null,"targetRef":"$target",
        "blockingReason":{"code":"WAITING_SERIAL_SLOT","summary":"Waiting to land: the landing of “Fix the 11 Swift failures” is running on this branch first"}}}}]"""

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

    /** A merge already made is no row of the page's timeline (owner 2026-10-27, docs/mocks/landings-one-window): the page's Landings
     *  row counts it, and it is a row of the project's Landings window, which opens in place to its receipt — the tasks it put on main
     *  by name, and the check that passed on the combined tree. */
    @Test fun aMergeAlreadyMadeIsARowOfTheLandingsWindowNotOfTheTimeline() {
        ProjectShell.merged = """[${candidate("MERGED").replace("\"merged\":null",
            "\"merged\":{\"sha\":\"8d5a868e90df\",\"at\":\"${ago(7)}\",\"automatic\":false,\"revert\":null}")}]"""
        openPage()
        await { exists(hasTestTag("landings-row")) }
        assertNull("a merge already made draws no card", compose.onAllNodes(hasTestTag("project-merge-card:asking")).fetchSemanticsNodes().firstOrNull())
        // Today: the members by recency, and no merge among them.
        assertEquals(listOf("Today", "Wire tests", "Quota retry", "2–7 days ago", "Shipped docs"), timeline())
        compose.onNodeWithTag("landings-row").performClick()
        await { exists(hasTestTag("landing-row:merge:pr-1")) }
        compose.onNode(hasTestTag("landing-row:merge:pr-1")).assert(hasText("Merged into main", substring = true))
            .assert(hasText("8d5a868 · 4 tasks · by you", substring = true)).performClick()
        await { exists(hasTestTag("landing:receipt")) }
        for (line in listOf("Now on main · 4 tasks", "Fix D1", "P7 rehearsal", "✓ Passed on the combined tree · 6m 12s")) {
            await { exists(hasText(line) and hasAnyAncestor(hasTestTag("landing:receipt")), unmerged = true) }
        }
        // A merge older than landing sessions has no landing of its own to read: its receipt is all there is.
        assertTrue(ProjectShell.calls.none { it.startsWith("GET sessions/merge") })
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

    /** The needs-you bar's merge waiting elsewhere opens its project's sessions page, where its card is (iOS 6b4bef713), and not the
     * coordinator conversation. */
    @Test fun theNeedsYouBarOpensAWaitingMergeOnItsProjectsSessionsPage() {
        ProjectShell.promotion = candidate("READY"); ProjectShell.mergeWaiting = true
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasText("Plain notes") and hasClickAction()) }
        compose.onNode(hasText("Plain notes") and hasClickAction()).performClick()
        await { exists(hasTestTag("needs-you-bar-text") and hasText("Approve merge to main"), unmerged = true) &&
            exists(hasTestTag("needs-you-bar-detail") and hasText("Launch"), unmerged = true) }
        compose.onNodeWithTag("needs-you-bar").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasTestTag("project-merge-card:asking")) }
        assertFalse("the coordinator conversation is not where it opens", ProjectShell.calls.contains("GET sessions/${ProjectShell.COORD}"))
        compose.onNodeWithContentDescription("Back").assertExists()
    }

    /** A11-9's push (iOS 6b4bef713 `Notifications.intent` → `openProjectSessions(_:inColumn: false)`): the tap on the tray entry of a merge
     * waiting on the owner opens its project's sessions page as that project's root — the page showing goes, the drawer's button leads
     * and the project's row is the selected one — with the card to press, not the coordinator conversation the payload also names. A
     * session's alert still opens over the page showing, and Back returns to it. */
    @Test fun theMergesPushOpensItsSessionsPageAsTheProjectsRoot() {
        ProjectShell.promotion = candidate("READY")
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasText("Plain notes") and hasClickAction()) }
        compose.onNode(hasText("Plain notes") and hasClickAction()).performClick()
        await { exists(hasContentDescription("Back")) }
        tap("approve-merge-to-main", "sessionID" to ProjectShell.COORD, "projectID" to launch, "openItemID" to mergeItem)
        await { exists(hasTestTag("project-sessions")) && exists(hasTestTag("project-merge-card:asking")) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        assertFalse("the coordinator conversation is not where it opens", ProjectShell.calls.contains("GET sessions/${ProjectShell.COORD}"))
        compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle()
        compose.onNode(drawerRow("Alpha")).assertIsNotSelected()
        compose.onNode(drawerRow("Launch")).assertIsSelected().performClick()

        tap("approval", "sessionID" to ProjectShell.WORKER)
        await { compose.waitForIdle(); ObjectId.same(app().realtime.state.value.session?.id, ProjectShell.WORKER) }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag("project-merge-card:asking")) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    /** The same tap while signed out survives the sign-in and lands the page as the project's root once the directory is read. */
    @Test fun theMergesPushTappedSignedOutOpensItsSessionsPageAfterSignIn() {
        ProjectShell.promotion = candidate("READY")
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        tap("approve-merge-to-main", "sessionID" to ProjectShell.COORD, "projectID" to launch, "openItemID" to mergeItem)
        signIn()
        await { exists(hasTestTag("project-sessions")) && exists(hasTestTag("project-merge-card:asking")) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle()
        compose.onNode(drawerRow("Launch")).assertIsSelected()
    }

    /** An alert as the server sends it, shown by the production [PushNotifications]; its tray entry's tap is the intent it carries. */
    private fun tap(kind: String, vararg fields: Pair<String, String>) {
        val data = mapOf("version" to "1", "type" to "alert", "registrationKey" to UUID.randomUUID().toString(),
            "eventId" to UUID.randomUUID().toString(), "notificationKey" to "$kind-${UUID.randomUUID()}", "sentAt" to "2026-10-26T00:00:00Z",
            "payload" to buildJsonObject {
                put("title", "Fixture"); put("body", "Read current state"); put("kind", kind)
                fields.forEach { (key, value) -> put(key, value) }
            }.toString())
        val manager = app().getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(true)
        assertTrue(PushNotifications(app()).show(PushMessage.parse(data)!!, data))
        val entry = manager.activeNotifications.single { it.tag == "orbit:${data["registrationKey"]}:${data["notificationKey"]}" }
        val intent = shadowOf(entry.notification.contentIntent).savedIntent
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }.invoke(it, intent)
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)

    private fun title(text: String) = await { exists(hasTestTag("project-merge-card:title") and hasText(text), unmerged = true) }
    private fun inCard(text: String) = await { exists(hasText(text) and hasAnyAncestor(hasTestTagPrefix("project-merge-card:")), unmerged = true) }
    private fun hasTestTagPrefix(prefix: String) = SemanticsMatcher("tag starts with $prefix") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
    private fun texts(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    /** The page's first blocks, top to bottom: the landing card only while one is drawn. */
    private fun pageOrder(): List<String> {
        fun top(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.top
        val progress = top(hasTestTag("project-sessions-progress"))!!
        val landing = top(hasTestTag("landing-card"))
        val merge = top(hasTestTagPrefix("project-merge-card:asking"))!!
        val coordinator = top(hasText("Coordinator") and hasAnyAncestor(hasTestTag("project-sessions")))!!
        return listOfNotNull("progress" to progress, landing?.let { "landing" to it }, "merge" to merge, "coordinator" to coordinator)
            .sortedBy { it.second }.map { it.first }
    }
    /** The timeline under the coordinator: section titles and members. */
    private fun timeline(): List<String> = compose.onAllNodes(hasAnyAncestor(hasTestTag("project-sessions-list")))
        .fetchSemanticsNodes().mapNotNull { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text
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
