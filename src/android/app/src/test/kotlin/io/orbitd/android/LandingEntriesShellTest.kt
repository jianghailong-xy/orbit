package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsActions
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
 * OPEN_LANDING / ABANDON, the source session's label — each opening the landing's project's Landings window focused on it (owner
 * 2026-10-27, revision 28); and the sessions page's one Landings row, the window it opens at its bottom, and the page's counts that
 * exclude LANDING rows.
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

    /** A · the Landing card: one job names its landing at the card's foot, and pressing it opens the session. */
    @Test fun theLandingCardsFootOpensItsLanding() {
        ProjectShell.inFlightJobs = "[${job("j-1")}]"; ProjectShell.landing = landingView; ProjectShell.landingTitle = "Land · Wire the page"
        openPage()
        await { exists(hasTestTag("landing-card:open-landing")) }
        compose.onNodeWithTag("landing-card:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landings-window")) }
        // The landing it names, focused in its project's window: its card, named by its task, opened in place.
        await { text("landing:task-name") == "Wire the page" && exists(hasTestTag("landing:open-arrow"), unmerged = true) }
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
        await { exists(hasTestTag("landings-window")) }
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
        await { exists(hasTestTag("landings-window")) }
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
        await { exists(hasTestTag("landings-window")) }
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

    /** C⁵ · the receipt the coordinator conversation's merge line opens names the round's landing at its foot, and it opens the
     *  round in its project's window. */
    @Test fun theReceiptsFootOpensTheRoundsLanding() {
        val made = """{"sha":"8d5a868e90df","at":"${ago(7)}","automatic":false,"revert":null}"""
        val merged = candidate("MERGED", landingId = landing, merged = made)
        ProjectShell.promotion = merged; ProjectShell.merged = "[$merged]"; ProjectShell.landing = landingView
        openPage()
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
        await { exists(hasTestTag("merge:pr-1:line")) }
        compose.onNodeWithTag("merge:pr-1:line").performClick()
        await { exists(hasTestTag("promotion-receipt:open-landing")) }
        compose.onNodeWithTag("promotion-receipt:open-landing").assert(hasText("Open landing", substring = true)).performClick()
        await { exists(hasTestTag("landings-window")) }
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
        await { exists(hasTestTag("landings-window")) }
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
        await { exists(hasTestTag("landings-window")) }
    }

    // MARK: the Landings row and the Landings window (owner 2026-10-27, docs/mocks/landings-one-window)

    /** An instant [minutes] into today, in this device's own zone: a settlement the window files under Today whenever the test runs. */
    private fun today(minutes: Long): String = java.time.LocalDate.now().atStartOfDay(java.time.ZoneId.systemDefault()).toInstant()
        .plusSeconds(minutes * 60).toString()

    private val flightStarted = ago(5)
    private val awaitStarted = ago(42)

    /** The project's landings: one waiting for a decision, one in flight ([flight]), one task landed today, and today's round of
     *  merging, which merged — its record joined to its session by `landingSessionId`. */
    private fun landings(flight: String = landingRow("l-flight", "Land · Wire the page", flightStarted, "IN_FLIGHT")) = """[$flight,
            ${landingRow("l-await", "Land · Ledger migration order", awaitStarted, "AWAITING_DECISION")},
            ${landingRow("l-settled", "Land · Payout retry budget", ago(120), "SETTLED", settledAs = "LANDED", settledAt = today(2))},
            ${landingRow("l-round", "Merge project/launch → main · #4", ago(150), "SETTLED", subject = "PROMOTION", settledAs = "MERGED",
                settledAt = today(4))}]"""

    private fun project() {
        ProjectShell.landings = landings()
        ProjectShell.merged = """[${candidate("MERGED", landingId = "l-round",
            merged = """{"sha":"8d5a868e90df","at":"${today(3)}","automatic":true,"revert":null}""").replace(""""landsAs":"MERGE_COMMIT",""",
            """"landsAs":"MERGE_COMMIT","landsTreeSha":"5e5bfca23aa1",""")}]"""
        ProjectShell.landing = landingView
        ProjectShell.coordinatorStatus = """{"state":"LIVE","coordination":{"session":{"id":"${ProjectShell.COORD}"}}}"""
    }

    /** F · the sessions page's one Landings row, under the coordinator: the most urgent landing's mark (one waits: ✕), how long it has
     *  waited, and today's counts — and the page still counts only its conversations. The whole row opens the project's window, where
     *  the settled ones are rows in their day and the ones in hand cards under Now, in the order they started. */
    @Test fun theLandingsRowSumsUpTheProjectsLandingsAndOpensItsWindow() {
        project()
        openPage()
        await { exists(hasTestTag("landings-row")) }
        await { text("page-bar-subtitle") == "Project · 4 sessions" }
        assertTrue(exists(hasText("Landings") and isHeading()))
        await { text("landings-row:line") == "1 waiting for a decision · 1 in flight · 1 landed · 1 merged into main today" }
        assertEquals("42m", text("landings-row:time"))
        assertTrue("one waits for a decision: the red ✕", exists(hasTestTag("landings-row:mark:fail"), unmerged = true))
        // The timeline is sessions alone: no merge row, no landing row.
        assertFalse(exists(hasTestTagPrefix("project-merge-row:")))
        assertFalse(exists(hasTestTagPrefix("landing-entry:")))
        compose.onNodeWithTag("landings-row").performClick()
        await { exists(hasTestTag("landings-window")) && exists(hasTestTag("landing-entry:l-flight")) }
        await { text("page-bar-subtitle") == "Run by Orbit · Launch" }
        assertTrue(exists(hasTestTag("landings:day:Today")) && exists(hasTestTag("landings:day:Now")))
        // Today: the round that merged, one row with its record, and the task that landed, oldest first.
        assertEquals(listOf("Payout retry budget", "Merged into main"), texts("landing-row:title"))
        assertEquals(listOf("Landed", "8d5a868 · 1 task · automatically"), texts("landing-row:detail"))
        assertEquals(listOf("✓", "⇢"), texts("landing-row:mark"))
        // Now: the cards, in the order they started, each named by its task.
        assertEquals(listOf("Ledger migration order", "Wire the page"), texts("landing:task-name"))
        assertTrue(top("landings:day:Today") < top("landings:day:Now"))
        assertTrue(top("landing-entry:l-await") < top("landing-entry:l-flight"))
        // Only the cards read their landing; the settled rows read nothing until they are opened.
        await { ProjectShell.calls.contains("GET sessions/l-await") && ProjectShell.calls.contains("GET sessions/l-flight") }
        assertFalse(ProjectShell.calls.contains("GET sessions/l-settled"))
        assertFalse(ProjectShell.calls.contains("GET sessions/l-round"))
        assertEquals("Orbit runs these landings — nothing to type here.", text("landings:footer-line"))
        assertTrue(exists(hasTestTag("landings:open-coordinator")))
    }

    /** F′ · a card that waits for a decision carries the doors to the people who make it: the coordinator, and the task. */
    @Test fun aWaitingCardCarriesTheDoorsToThePeopleWhoDecide() {
        project()
        openPage()
        openWindow()
        val waiting = hasAnyAncestor(hasTestTag("landing-entry:l-await"))
        await { exists(hasTestTag("landing:wait:open_coordinator") and waiting) && exists(hasTestTag("landing:wait:open_task") and waiting) }
        compose.onNode(hasTestTag("landing:wait:open_coordinator") and waiting).assert(hasText("Open coordinator"))
        compose.onNode(hasTestTag("landing:wait:open_task") and waiting).assert(hasText("Open task"))
        assertFalse("the card in flight waits for nobody",
            exists(hasTestTagPrefix("landing:wait:") and hasAnyAncestor(hasTestTag("landing-entry:l-flight"))))
        compose.onNode(hasTestTag("landing:wait:open_task") and waiting).performClick()
        await { ProjectShell.calls.contains("GET tasks/t-landing") }
    }

    /** F″ · a settled row opens in place to its record — read once, when it is opened — with an up arrow, and folds again; the task's
     *  two ways in end it. */
    @Test fun aSettledRowOpensInPlaceToItsRecordAndFolds() {
        project()
        openPage()
        openWindow()
        val row = "landing-row:l-settled"
        compose.onNodeWithTag(row).performClick()
        await { exists(hasTestTag("landing:link:task") and hasAnyAncestor(hasTestTag("landing-entry:l-settled"))) }
        assertTrue(exists(hasTestTag("landing:open-arrow") and hasAnyAncestor(hasTestTag("landing-entry:l-settled")), unmerged = true))
        assertTrue(exists(hasTestTag("landing:link:source") and hasAnyAncestor(hasTestTag("landing-entry:l-settled"))))
        assertEquals(1, ProjectShell.calls.count { it == "GET sessions/l-settled" })
        compose.onNodeWithTag(row).performClick()
        await { !exists(hasTestTag("landing:link:task") and hasAnyAncestor(hasTestTag("landing-entry:l-settled"))) }
        compose.onNodeWithTag(row).performClick()
        await { exists(hasTestTag("landing:link:task") and hasAnyAncestor(hasTestTag("landing-entry:l-settled"))) }
        compose.mainClock.advanceTimeBy(20_000)
        compose.waitForIdle()
        assertEquals("a settled row is read once, never polled", 1, ProjectShell.calls.count { it == "GET sessions/l-settled" })
    }

    /** F‴ · a merge into main opens to its receipt first — what is now on main, the check that passed, the tree that landed — then its
     *  round's own record. */
    @Test fun aMergeRowOpensToItsReceiptThenItsRecord() {
        project()
        openPage()
        openWindow()
        compose.onNodeWithTag("landing-row:l-round").performClick()
        await { exists(hasTestTag("landing:receipt")) }
        assertEquals("Now on main · 1 task", text("landing:receipt-heading"))
        assertTrue(exists(hasText("Fix D1") and hasAnyAncestor(hasTestTag("landing:receipt")), unmerged = true))
        assertEquals("✓ Passed on the combined tree · 6m 12s", text("landing:receipt-check"))
        assertEquals("Landed exactly the tested tree 5e5bfca · as a merge commit", text("landing:receipt-tree"))
        await { ProjectShell.calls.contains("GET sessions/l-round") }
    }

    /** F⁗ · a long-press on a settled row opens its menu — the ways to look at its work, no door — and on a card in hand, the old
     *  page's menu with its doors; the window's own ⋯ has the coordinator and the project, and nothing else. */
    @Test fun eachLandingsMenuIsItsOwnAndTheWindowsIsTheTwoWaysOut() {
        project()
        openPage()
        openWindow()
        compose.onNodeWithTag("landing-row:l-settled").performSemanticsAction(SemanticsActions.OnLongClick)
        await { menuItems() == listOf("Open task", "Open source session", "Open coordinator") }
        assertEquals("the menu reads the row's landing, once", 1, ProjectShell.calls.count { it == "GET sessions/l-settled" })
        menuItem("Open coordinator").performClick()
        await { exists(hasTestTag("transcript-list")) }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        openedWindow()
        compose.onNode(hasTestTag("landing-status-card") and hasAnyAncestor(hasTestTag("landing-entry:l-flight")))
            .performSemanticsAction(SemanticsActions.OnLongClick)
        await { menuItems() == listOf("Open task", "Open source session", "Open coordinator", "Stop landing") }
        menuItem("Stop landing").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/tasks/t-landing/integration/stop") }
        await { menuItems().isEmpty() }
        compose.onNodeWithTag("landings-more").performClick()
        await { menuItems() == listOf("Open coordinator", "Open Project") }
        menuItem("Open Project").performClick()
        await { exists(hasTestTag("project-detail")) }
    }

    /** F⁵ · a card whose read says it settled moves into its day: the window reads its lists again at once. */
    @Test fun aCardThatSettlesMovesIntoItsDay() {
        project()
        openPage()
        openWindow()
        await { exists(hasTestTag("landing-status-card") and hasAnyAncestor(hasTestTag("landing-entry:l-flight"))) }
        val lists = ProjectShell.calls.count { it.startsWith("GET sessions?view=completed") }
        // The server settles l-flight: its view says so, and so do the lists.
        ProjectShell.landings = landings(flight = landingRow("l-flight", "Land · Wire the page", flightStarted, "SETTLED", settledAs = "LANDED",
            settledAt = today(6)))
        ProjectShell.landing = landingView.replace(""""settledAt":null,"settledAs":null""", """"settledAt":"${today(6)}","settledAs":"LANDED"""")
        compose.mainClock.advanceTimeBy(4_100)
        await { ProjectShell.calls.count { it.startsWith("GET sessions?view=completed") } > lists }
        await { exists(hasTestTag("landing-row:l-flight")) }
        assertFalse(exists(hasTestTag("landing-status-card") and hasAnyAncestor(hasTestTag("landing-entry:l-flight"))))
    }

    /** F⁶ · a project that has never had a landing draws no Landings row at all — no heading over nothing. */
    @Test fun aProjectThatNeverHadALandingHasNoLandingsRow() {
        ProjectShell.landings = "[]"
        openPage()
        // The completed member arrives in the same read as the landings: once the header counts it, the row has been decided.
        await { text("page-bar-subtitle") == "Project · 4 sessions" }
        compose.waitForIdle()
        assertFalse("no bare Landings heading", exists(hasText("Landings") and isHeading()))
        assertFalse(exists(hasTestTag("landings-row")))
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
        await { exists(hasTestTag("landings-window")) && text("landing:task-name") != null }
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

    private fun openWindow() {
        await { exists(hasTestTag("landings-row")) }
        compose.onNodeWithTag("landings-row").performClick()
        openedWindow()
    }
    private fun openedWindow() =
        await { exists(hasTestTag("landings-window")) && exists(hasTestTag("landing-row:l-settled")) && exists(hasTestTag("landing-entry:l-flight")) }
    private fun menuItem(text: String) = compose.onNode(hasText(text) and hasAnyAncestor(isPopup()) and hasClickAction())

    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    /** Every node's words under [tag], top to bottom. */
    private fun texts(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes()
        .sortedBy { it.positionInRoot.y }.mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }
    private fun top(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().first().positionInRoot.y
    private fun hasTestTagPrefix(prefix: String) = SemanticsMatcher("tag starts with $prefix") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun app() = compose.activity.application as OrbitApplication
}
