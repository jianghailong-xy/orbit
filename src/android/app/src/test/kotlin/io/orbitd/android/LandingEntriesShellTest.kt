package io.orbitd.android

import android.content.Intent
import android.net.Uri
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

/**
 * A-2 in the production shell: 方案 A's explicit ways into a landing session (contract §2.9 LS6) — the Landing card's foot and rows,
 * the jobs list's rows, the merge round's head row, its CONFIRMED foot and its receipt, the owner card's and the project Open items'
 * OPEN_LANDING / ABANDON — and the Landings group, the source session's label and the page's counts that exclude LANDING rows.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1800dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingEntriesShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(minutes: Long): String = Instant.now().minusSeconds(minutes * 60).toString()
    private fun q(value: String?): String = value?.let { "\"$it\"" } ?: "null"

    /** The landing view `GET sessions/<LANDING>` answers. */
    private val landingView: String get() = """{"sessionId":"$landing","projectId":"$launch","subject":"TASK","taskId":"t-landing",
        "promotionId":null,"episode":1,"openedAt":"${ago(600)}","settledAt":null,"settledAs":null,"checks":[],
        "currentAttempt":{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":1,"phase":"CHECK","round":1,"step":null,"claim":1,
        "runnerName":"wikova","sourceSessionId":"$landing","targetRef":"refs/heads/project/launch","startedAt":"${ago(110)}",
        "heartbeatAt":"${ago(0)}","outputMovedAt":"${ago(6)}","progressProtocol":"v2",
        "check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"},"liveness":"LIVE",
        "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false},"todos":[],"generations":[]}"""

    private fun job(id: String, state: String = "RUNNING", kind: String = "LAND_TASK", landingId: String? = ProjectShell.LANDING,
        timedOut: Boolean = false) = """{"jobId":"$id","kind":"$kind","state":"$state","phase":"CHECK","taskId":"t-$id","taskTitle":"Wire the page",
        "generation":1,"startedAt":"${ago(60)}","queuedAt":"${ago(90)}","heartbeatAt":"${ago(0)}","runnerName":"wikova","timedOut":$timedOut,
        "limitSeconds":600,"retryable":false${landingId?.let { ",\"landingSessionId\":\"$it\"" }.orEmpty()}}"""

    private fun candidate(state: String, landingId: String? = null, merged: String? = null) = """{"promotionId":"pr-1","state":"$state","sourceRef":"refs/heads/project/launch",
        "sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":7,"filesChanged":10,"taskIds":["t1"],"tasks":[{"taskId":"t1","title":"Fix D1"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],"conflicts":[],
        "landsAs":"MERGE_COMMIT","askedAt":"${ago(130)}","merged":${merged ?: "null"}${landingId?.let { ",\"landingSessionId\":\"$it\"" }.orEmpty()}}"""

    private fun xe5(id: String = "item-xe5", landingId: String? = landing, jobId: String? = "j-1") = """{"itemId":"$id","kind":"LANDING_LEASE_EXPIRED",
        "title":"A landing stopped reporting","detailLine":"The runner stopped reporting","assignee":"OWNER","assigneeReason":"ESCALATED",
        "waitingSince":"${ago(120)}","escalatedAt":"${ago(120)}","landingSessionId":${q(landingId)},"integrationJobId":${q(jobId)},
        "actions":["ABANDON","OPEN_LANDING"],"primaryAction":"ABANDON",
        "requiredAction":"The runner stopped reporting; abandon this landing, or wait for the runner to come back.",
        "lease":{"jobKind":"LAND_TASK","generation":2,"phase":"REBASE","claimGeneration":1,"round":1,"checkCount":3,"runner":"workstation-gpu",
        "progressProtocol":"v2","pushReported":false,"lastReportAt":"${ago(300)}"}}"""

    private fun landingOnly(id: String = "item-landing") = """{"itemId":"$id","kind":"INTEGRATION_ERROR","title":"An integration stopped",
        "detailLine":"the job ended with an error","assignee":"OWNER","assigneeReason":"ESCALATED","waitingSince":"${ago(60)}","escalatedAt":"${ago(60)}",
        "landingSessionId":"$landing","actions":["OPEN_LANDING"],"requiredAction":"Open the landing to read the attempt."}"""

    private fun landingRow(id: String, title: String, createdAt: String, state: String, subject: String = "TASK", settledAs: String? = null,
        settledAt: String? = null) = """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$createdAt","lastTurnAt":"$createdAt",
        "sessionKind":"LANDING","landing":{"subject":"$subject","state":"$state","settledAs":${q(settledAs)},"settledAt":${q(settledAt)}},
        "projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"LANDING"}}"""

    private fun holder(landingId: String, kind: String = "INTEGRATION_CHECK_FAILED", assignee: String = "COORDINATOR") =
        """{"itemId":"item-holder","kind":"$kind","title":"Checks failed","waitingSince":"${ago(30)}","assignee":"$assignee","landingSessionId":"$landingId"}"""

    /** A · the Landing card: one job names its landing at the card's foot, and pressing it opens the session. */
    @Test fun theLandingCardsFootOpensItsLanding() {
        ProjectShell.inFlightJobs = "[${job("j-1")}]"; ProjectShell.landing = landingView; ProjectShell.landingTitle = "Land · Wire the page"
        openPage()
        await { exists(hasTestTag("landing-card:open-landing")) }
        compose.onNodeWithTag("landing-card:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landing-page")) }
        assertEquals("Land · Wire the page", text("landing:title"))
        assertFalse(exists(hasTestTag("transcript-list")))
        await { ProjectShell.calls.contains("GET sessions/$landing") }
    }

    /** B · the jobs list: every row names its own landing beside Retry; a row pressed opens the session, not the task. */
    @Test fun aJobsListsRowOpensItsLanding() {
        ProjectShell.inFlightJobs = "[${job("j-1")},${job("j-2", state = "QUEUED")}]"; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("landing-card")) }
        compose.onNodeWithTag("landing-card:body").performClick()
        await { exists(hasTestTag("landing-job:j-2:open-landing")) }
        compose.onNodeWithTag("landing-job:j-2:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landing-page")) }
        assertTrue(ProjectShell.calls.none { it == "GET tasks/t-j-2" })
    }

    /** C · the merge round: the checking card's whole head row opens the round's landing, and "+N job queued · All jobs ›" opens the
     * list behind it. */
    @Test fun theMergeChecksHeadRowOpensTheRoundsLandingAndTheQueueOpensTheList() {
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "CHECK_PROMOTION")},${job("j-2", state = "QUEUED", kind = "LAND_TASK")}]"
        ProjectShell.mergeCheck = true; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("project-merge-card:checking")) }
        compose.onNodeWithTag("project-merge-card:more-jobs", useUnmergedTree = true).assertTextEquals("+1 job queued")
        compose.onNodeWithTag("project-merge-card:landing").performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** C‴′ · a timed-out merge TO MAIN has no re-run: its one door is Abandon. */
    @Test fun aTimedOutMergeToMainOffersOnlyAbandon() {
        ProjectShell.promotion = candidate("MERGED"); ProjectShell.mergeCheck = true; ProjectShell.mergeJobKind = "LAND_PROMOTION"
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "LAND_PROMOTION", timedOut = true)}]"
        openPage()
        await { exists(hasTestTag("project-merge-card:abandon")) }
        assertFalse("a merge that stopped at the push has no re-run", exists(hasTestTag("project-merge-card:rerun")))
        compose.onNodeWithTag("project-merge-card:abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
    }

    /** C′ · a CONFIRMED card names the round's landing at its foot (and says so in grey when the candidate names none). */
    @Test fun theConfirmedCardsFootOpensItsLanding() {
        ProjectShell.promotion = candidate("CONFIRMED", landingId = landing); ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("project-merge-card:merging")) }
        compose.onNodeWithTag("project-merge-card:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** C″ · a timed-out merge check draws Re-run the check and Abandon; each sends its own door and nothing else is drawn. */
    @Test fun aTimedOutMergeChecksTwoDoorsSendTheirOwnRoutes() {
        ProjectShell.promotion = candidate("MERGED"); ProjectShell.mergeCheck = true
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "CHECK_PROMOTION", timedOut = true)}]"
        openPage()
        await { exists(hasTestTag("project-merge-card:rerun")) && exists(hasTestTag("project-merge-card:abandon")) }
        compose.onNodeWithTag("project-merge-card:cancel").assertDoesNotExist()
        compose.onNodeWithTag("project-merge-card:abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
        compose.onNodeWithTag("project-merge-card:rerun").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/integration/retry") }
        assertEquals("""{"reason":"Re-run the timed-out check from the merge card."}""",
            ProjectShell.bodies["POST projects/$launch/promotions/pr-1/integration/retry"])
    }

    /** C‴ · a merge round that names no landing keeps main's press: the head row opens the jobs list, not a session. */
    @Test fun aMergeRoundWithNoLandingKeepsTheJobsListAsItsWayIn() {
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "CHECK_PROMOTION", landingId = null)},${job("j-2", state = "QUEUED")}]"
        ProjectShell.mergeCheck = true
        openPage()
        await { exists(hasTestTag("project-merge-card:landing")) }
        compose.onNodeWithTag("project-merge-card:landing").performClick()
        await { exists(hasTestTag("landing-jobs-sheet")) }
        assertTrue(ProjectShell.calls.none { it.startsWith("GET sessions/") })
    }

    /** C⁗ · a BLOCKED round draws no landing entrance at all: the reader is being asked to look at what blocks it. */
    @Test fun aBlockedMergeRoundDrawsNoLandingEntrance() {
        ProjectShell.promotion = candidate("BLOCKED", landingId = landing)
        ProjectShell.merged = "[]"
        ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("project-merge-card:blocked")) }
        assertFalse(exists(hasTestTag("project-merge-card:landing")))
        assertFalse(exists(hasTestTag("project-merge-card:open-landing")))
        assertFalse(exists(hasTestTag("project-merge-card:all-jobs")))
    }

    /** C⁵ · the receipt a "Merged into main" row opens names the round's landing at its foot. */
    @Test fun theReceiptsFootOpensTheRoundsLanding() {
        val made = """{"sha":"8d5a868e90df","at":"${ago(7)}","automatic":false,"revert":null}"""
        val merged = candidate("MERGED", landingId = landing, merged = made)
        ProjectShell.promotion = merged; ProjectShell.merged = "[$merged]"; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("project-merge-row:pr-1")) }
        compose.onNodeWithTag("project-merge-row:pr-1").performClick()
        await { exists(hasTestTag("promotion-receipt:open-landing")) }
        compose.onNodeWithTag("promotion-receipt:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** D · the project page's Open items: X-E5's Abandon sends the owner's door, and an OPEN_LANDING-only row opens the session. */
    @Test fun theOpenItemsDoorsSendAbandonAndOpenTheLanding() {
        ProjectShell.needsYouItems = "[${xe5()},${landingOnly()}]"; ProjectShell.landing = landingView
        openProjectPage()
        await { exists(hasTestTag("project-open-items")) }
        compose.onNodeWithTag("project-open-items").performClick()
        await { exists(hasTestTag("open-item:item-xe5:action")) && exists(hasTestTag("open-item:item-landing:action")) }
        compose.onNodeWithTag("open-item:item-xe5:action").assertTextEquals("Abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
        compose.onNodeWithTag("project-open-items").performClick()
        await { exists(hasTestTag("open-item:item-landing:action")) }
        compose.onNodeWithTag("open-item:item-landing:action").assertTextEquals("Open landing").performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** E · the coordinator's exception card: Abandon is the lead and sends the door; Open landing opens the session. */
    @Test fun theExceptionCardsLandingDoorsSendAbandonAndOpenTheLanding() {
        ProjectShell.needsYouItems = "[${xe5()}]"; ProjectShell.landing = landingView
        openPage()
        await { exists(hasText("Coordinate launch") and hasClickAction()) }
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
        await { exists(hasTestTag("item:item-xe5:ABANDON")) && exists(hasTestTag("item:item-xe5:OPEN_LANDING")) }
        // The heading is the fact the item is about, and Abandon leads the doors.
        compose.onNodeWithTag("item:item-xe5:heading", useUnmergedTree = true).assert(hasText("Now yours — no report from the runner for ", substring = true))
        val lead = compose.onNodeWithTag("item:item-xe5:ABANDON").fetchSemanticsNode().boundsInRoot.top
        val look = compose.onNodeWithTag("item:item-xe5:OPEN_LANDING").fetchSemanticsNode().boundsInRoot.top
        assertTrue("Abandon is the lead door", lead < look)
        compose.onNodeWithTag("item:item-xe5:ABANDON").assertTextEquals("Abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
        compose.onNodeWithTag("item:item-xe5:OPEN_LANDING").assertTextEquals("Open landing").performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** F · the Landings group: the waiting one and the last day's settled ones, under the coordinator; an in-flight landing and a
     * merged round are absent; everything older folds into one line that opens; a row opens the landing session. */
    @Test fun theLandingsGroupFiltersFoldsAndOpensItsRows() {
        ProjectShell.landings = """[${landingRow("l-flight", "Land · moving", ago(5), "IN_FLIGHT")},
            ${landingRow("l-await", "Land · stopped", ago(42), "AWAITING_DECISION")},
            ${landingRow("l-settled", "Land · landed", ago(120), "SETTLED", settledAs = "LANDED", settledAt = ago(60))},
            ${landingRow("l-merged", "Merge → main", ago(150), "SETTLED", subject = "PROMOTION", settledAs = "MERGED", settledAt = ago(90))},
            ${landingRow("l-old-a", "Land · old", ago(2 * 24 * 60), "SETTLED", settledAs = "LANDED", settledAt = ago(2 * 24 * 60))},
            ${landingRow("l-old-b", "Land · nothing", ago(3 * 24 * 60), "SETTLED", settledAs = "NOTHING_TO_LAND", settledAt = ago(3 * 24 * 60))}]"""
        ProjectShell.needsYouItems = "[${holder("l-await")}]"; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("landing-row:l-await")) && exists(hasTestTag("landing-row:l-settled")) }
        // The page's header counts the conversations, never the landings: the coordinator, two members and the completed one.
        await { text("page-bar-subtitle") == "Project · 4 sessions" }
        await { exists(hasTestTag("landing-row:l-await") and hasText("Checks failed · with the coordinator", substring = true)) }
        assertFalse("an in-flight landing is the Landing card's", exists(hasTestTag("landing-row:l-flight")))
        assertFalse("a merged round is the timeline's own row", exists(hasTestTag("landing-row:l-merged")))
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier · 1 landed · 1 nothing to land"))
        assertFalse("the older landings start folded", exists(hasTestTag("landing-row:l-old-a")))
        compose.onNodeWithTag("landings:earlier").performClick()
        await { exists(hasTestTag("landing-row:l-old-a")) && exists(hasTestTag("landing-row:l-old-b")) }
        compose.onNodeWithTag("landing-row:l-settled").performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    /** F′ · a count of 0 is left out of the fold's line, and the fold still opens to every older row, the cancelled one too. */
    @Test fun theLandingsFoldLeavesOutAZeroCount() {
        ProjectShell.landings = """[${landingRow("l-await", "Land · stopped", ago(42), "AWAITING_DECISION")},
            ${landingRow("l-old-a", "Land · old", ago(2 * 24 * 60), "SETTLED", settledAs = "LANDED", settledAt = ago(2 * 24 * 60))},
            ${landingRow("l-old-c", "Land · cancelled", ago(3 * 24 * 60), "SETTLED", settledAs = "CANCELLED", settledAt = ago(3 * 24 * 60))}]"""
        openPage()
        await { exists(hasTestTag("landing-row:l-await")) && exists(hasTestTag("landings:earlier")) }
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier · 1 landed"))
        assertFalse("no zero segment", exists(hasTestTag("landings:earlier") and hasText("nothing to land", substring = true)))
        compose.onNodeWithTag("landings:earlier").performClick()
        await { exists(hasTestTag("landing-row:l-old-a")) && exists(hasTestTag("landing-row:l-old-c")) }
    }

    /** F″ · older landings that neither landed nor had nothing to land still fold, under the bare `Earlier` — no count, no new
     *  word — and the fold opens to them. */
    @Test fun theLandingsFoldIsABareEarlierOverWhatItDoesNotCount() {
        ProjectShell.landings = """[${landingRow("l-await", "Land · stopped", ago(42), "AWAITING_DECISION")},
            ${landingRow("l-old-c", "Land · cancelled", ago(2 * 24 * 60), "SETTLED", settledAs = "CANCELLED", settledAt = ago(2 * 24 * 60))},
            ${landingRow("l-old-h", "Land · handled", ago(3 * 24 * 60), "SETTLED", settledAs = "HANDLED", settledAt = ago(3 * 24 * 60))},
            ${landingRow("l-old-d", "Land · declined", ago(4 * 24 * 60), "SETTLED", settledAs = "DECLINED", settledAt = ago(4 * 24 * 60))}]"""
        openPage()
        await { exists(hasTestTag("landing-row:l-await")) && exists(hasTestTag("landings:earlier")) }
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier"))
        assertFalse("no count in the fold's line", exists(hasTestTag("landings:earlier") and hasText("Earlier ·", substring = true)))
        assertFalse("the older landings start folded", exists(hasTestTag("landing-row:l-old-c")))
        compose.onNodeWithTag("landings:earlier").performClick()
        await { exists(hasTestTag("landing-row:l-old-c")) && exists(hasTestTag("landing-row:l-old-h")) && exists(hasTestTag("landing-row:l-old-d")) }
        assertTrue(exists(hasTestTag("landing-row:l-old-h") and hasText("Handled", substring = true)))
    }

    /** F‴ · with nothing older there is no fold. */
    @Test fun theLandingsGroupHasNoFoldWithNothingOlder() {
        ProjectShell.landings = """[${landingRow("l-await", "Land · stopped", ago(42), "AWAITING_DECISION")},
            ${landingRow("l-cancelled", "Land · cancelled", ago(120), "SETTLED", settledAs = "CANCELLED", settledAt = ago(60))}]"""
        openPage()
        await { exists(hasTestTag("landing-row:l-await")) && exists(hasTestTag("landing-row:l-cancelled")) }
        assertTrue(exists(hasText("Landings") and isHeading()))
        assertFalse("no fold with nothing older", exists(hasTestTag("landings:earlier")))
    }

    /** F⁗ · a group with nothing to list is no group: an in-flight landing is the Landing card's, a merged round the timeline's. */
    @Test fun theLandingsGroupIsAbsentWithNothingToList() {
        ProjectShell.landings = """[${landingRow("l-flight", "Land · moving", ago(5), "IN_FLIGHT")},
            ${landingRow("l-merged", "Merge → main", ago(3 * 24 * 60), "SETTLED", subject = "PROMOTION", settledAs = "MERGED", settledAt = ago(3 * 24 * 60))}]"""
        openPage()
        // The completed member arrives in the same read as the landings: once the header counts it, the group has been decided.
        await { text("page-bar-subtitle") == "Project · 4 sessions" }
        compose.waitForIdle()
        assertFalse("no bare Landings heading", exists(hasText("Landings") and isHeading()))
        assertFalse(exists(hasTestTag("landings:earlier")))
        assertFalse(exists(hasTestTag("landing-row:l-merged")))
    }

    /** G · the source code session's derived label: what the platform did with its work, opening the landing generation. */
    @Test fun theSourceSessionsLandingLabelOpensItsLanding() {
        ProjectShell.landing = landingView
        ProjectShell.sourceLanding = """{"landingSessionId":"$landing","subject":"TASK","state":"RUNNING","phase":"CHECK","settledAs":null,
            "targetRef":"refs/heads/project/launch"}"""
        signIn(); open("orbit-session:${ProjectShell.WORKER}")
        await { exists(hasTestTag("source-landing")) }
        compose.onNodeWithTag("source-landing:ring", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("source-landing").assertTextEquals("Landing · checking ›").performClick()
        await { exists(hasTestTag("landing-page")) }
    }

    // MARK: helpers

    private fun openPage() {
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:$launch")) }
        compose.onNodeWithTag("project-row:$launch").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText("Coordinate launch") and hasClickAction()) }
    }

    private fun openProjectPage() {
        openPage()
        compose.onNodeWithTag("project-sessions-open-project").performClick()
        await { exists(hasTestTag("project-detail")) }
    }

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

    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun app() = compose.activity.application as OrbitApplication
}
