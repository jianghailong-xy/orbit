package io.orbitd.android

import android.content.Intent
import android.net.Uri
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A-1 in the production shell: a session the server calls LANDING is drawn as the landing page — never the reader (no
 * composer, no session menu, no `sessions/:id/events`), its status card, the server's timeline and the ⋮ menu's doors — and
 * a link reaches it even before its session row exists (contract §2.9 LS1/LS6; mockups v4 07). A conversation still opens
 * the reader; every door sends the server's route, and a refusal is said in the server's own words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1800dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingSessionShellTest {
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
    private fun ago(seconds: Long) = java.time.Instant.now().minusSeconds(seconds).toString()

    /** The landing view `GET sessions/<LANDING>` answers, with one attempt and — when asked — the server's timeline. */
    private fun view(kind: String = "LAND_TASK", subject: String = "TASK", taskId: String? = "t-landing", promotionId: String? = null,
        state: String = "RUNNING", liveness: String? = "LIVE", timedOut: Boolean = false, retryable: Boolean = false,
        pastPush: Boolean = false, claim: Int = 1, round: Int? = 1, phase: String? = "CHECK", runner: String = "wikova",
        settledAt: String? = null, settledAs: String? = null, timeline: String? = null): String {
        val attempt = """{"jobId":"j-1","kind":"$kind","state":"$state","generation":1,"phase":${phase?.let { "\"$it\"" } ?: "null"},
            "round":${round ?: "null"},"step":null,"claim":$claim,"runnerName":"$runner","sourceSessionId":"$landing",
            "targetRef":"refs/heads/project/launch","startedAt":"${ago(110)}","heartbeatAt":"${ago(0)}","outputMovedAt":"${ago(6)}",
            "progressProtocol":"v2","check":${if (state == "RUNNING") """{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"}""" else "null"},
            "liveness":${liveness?.let { "\"$it\"" } ?: "null"},"blockingReason":null,"timedOut":$timedOut,"limitSeconds":600,
            "retryable":$retryable,"pushBoundaryPassed":$pastPush}"""
        return """{"sessionId":"$landing","projectId":"$launch","subject":"$subject","taskId":${taskId?.let { "\"$it\"" } ?: "null"},
            "promotionId":${promotionId?.let { "\"$it\"" } ?: "null"},"episode":4,"openedAt":"${ago(3600)}",
            "settledAt":${settledAt?.let { "\"$it\"" } ?: "null"},"settledAs":${settledAs?.let { "\"$it\"" } ?: "null"},
            "checks":[],"currentAttempt":$attempt,"todos":[],"generations":[]${timeline?.let { ""","timeline":$it""" }.orEmpty()}}"""
    }

    /** The server's timeline of one attempt, as the landing view carries it. */
    private fun timeline(entry: String) = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,
        "state":"RUNNING","entries":[$entry]}],"facts":[]}"""

    @Test fun aLandingLinkDrawsTheLandingPageAndNeverTheReader() {
        ProjectShell.landing = view(); ProjectShell.landingTitle = "Land · Wire the page"
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing-page")) }
        assertEquals("Land · Wire the page", text("landing:title"))
        assertEquals("Landing", text("landing:chip"))
        assertEquals("Run by Orbit · runner wikova", text("landing:sub"))
        assertEquals("Landing", text("landing-head:title"))
        assertTrue(text("landing-head:detail")!!.startsWith("checking · output "))
        // The page's own reads: the detail it draws from, and the project's facts beside it.
        await { ProjectShell.calls.count { it == "GET sessions/$landing" } >= 1 }
        await { ProjectShell.calls.contains("GET projects/$launch/integration") }
        // Nothing of the conversation: no transcript, no composer, no session menu — and no session event stream.
        assertFalse(exists(hasTestTag("transcript-list")))
        assertFalse(exists(hasContentDescription("Session actions")))
        assertFalse(exists(hasTestTag("session-menu")))
        assertTrue(ProjectShell.calls.none { it.startsWith("GET sessions/$landing/events") })
    }

    @Test fun aConversationStillOpensTheReader() {
        signIn(); open("orbit-session:${ProjectShell.COORD}")
        await { exists(hasTestTag("transcript-list")) }
        assertFalse(exists(hasTestTag("landing-page")))
    }

    /** LS1: the row is inserted only after the first claim commits; the pre-generated id still draws the page, titling
     *  the subject from its task. */
    @Test fun aLandingWhoseRowIsNotInsertedStillDraws() {
        ProjectShell.landing = view(); ProjectShell.landingTitle = null
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing-page")) }
        await { text("landing:title") == "Land · Wire the page" }
        await { ProjectShell.calls.contains("GET tasks/t-landing") }
        assertEquals("Land · Wire the page", text("landing:title"))
    }

    @Test fun theMenuListsTheWaysToLookThenTheStopAndTheStopSendsItsRoute() {
        ProjectShell.landing = view()
        ProjectShell.coordinatorStatus = """{"state":"LIVE","coordination":{"session":{"id":"${ProjectShell.COORD}"}}}"""
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing-more")) }
        menu()
        assertEquals(listOf("Open task", "Open source session", "Open coordinator", "Stop landing"), items())
        item("Stop landing").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/tasks/t-landing/integration/stop") }
        // The same menu never carries the session menu's rows or a Copy Link (LS6).
        listOf("Share…", "Copy Link", "Rename…", "Move…", "Tags…", "Move to Trash").forEach { assertFalse(items().contains(it)) }
    }

    @Test fun theStopGoesAwayPastThePushBoundary() {
        ProjectShell.landing = view(pastPush = true)
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing-page")) }
        menu()
        assertEquals(listOf("Open task", "Open source session"), items())
    }

    /** J-T9 and J-T10: a timed-out LAND_TASK offers the server's Retry and Abandon, and each press is its own request. */
    @Test fun aTimedOutTaskOffersRetryAndAbandonAndEachPlacesItsRequest() {
        ProjectShell.landing = view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true)
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:retry")) && exists(hasTestTag("landing:abandon")) }
        assertEquals("Timed out", text("landing-head:right"))
        assertTrue(text("landing:timeout-line")!!.startsWith("Runner wikova took it at"))
        compose.onNodeWithTag("landing:retry").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/retry") }
        compose.onNodeWithTag("landing:abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
    }

    /** Revision 16: a timed-out merge check re-runs that check (no Retry, no Cancel) and can still be abandoned. */
    @Test fun aTimedOutCheckOffersRerunTheCheckAndAbandon() {
        ProjectShell.landing = view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "CHECK_PROMOTION",
            timedOut = true, liveness = "LEASE_EXPIRED")
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CHECKING","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main"}"""
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:rerun")) && exists(hasTestTag("landing:abandon")) }
        assertFalse(exists(hasTestTag("landing:retry")))
        compose.onNodeWithTag("landing:rerun").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/promotions/pr-1/integration/retry") }
        // RetryIntegrationDto.reason is required: a bodyless press is refused before the queue is asked.
        assertEquals("""{"reason":"Re-run the timed-out check from the landing page."}""",
            ProjectShell.bodies["POST projects/$launch/promotions/pr-1/integration/retry"])
        compose.onNodeWithTag("landing:abandon").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/integration/jobs/j-1/abandon") }
    }

    @Test fun aRefusalIsSaidInTheServersOwnWords() {
        ProjectShell.landing = view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true)
        ProjectShell.doorStatus = 409; ProjectShell.doorMessage = "The job is no longer running."
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:retry")) }
        compose.onNodeWithTag("landing:retry").performClick()
        await { text("landing:refusal") != null }
        assertEquals("Retry failed — The job is no longer running.", text("landing:refusal"))
    }

    /** A15 F-22's kind on this page (A11k): a door holds the page until the page has read the press back. Pressed before then, a door
     *  would go out over the claim the press has just moved on, and the server refuses it. Once the read lands, the doors are the new
     *  claim's. */
    @Test fun noDoorIsPressedAgainUntilThePageHasReadThePressBack() {
        ProjectShell.landing = view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true)
        // Retry hands the job its next claim, which runs; a door on the claim that timed out is refused from then on.
        ProjectShell.landingAfterDoor = view(claim = 2)
        signIn(); open("orbit-session:$landing")
        await { enabled("landing:retry") && enabled("landing:abandon") }
        ProjectShell.holdLanding = CompletableDeferred()
        val reads = landingReads()
        compose.onNodeWithTag("landing:retry").performClick()
        await { jobDoors("retry") == 1 && landingReads() > reads }
        compose.waitForIdle()
        // The server has moved the job on; the page still draws the claim that timed out, and none of its doors can be pressed, on
        // the card or in the menu.
        compose.onNodeWithTag("landing:retry").assertIsNotEnabled()
        compose.onNodeWithTag("landing:abandon").assertIsNotEnabled().performClick()
        menu(); item("Abandon").performClick()
        compose.waitForIdle()
        assertEquals(0, jobDoors("abandon"))
        assertEquals(1, jobDoors("retry"))

        ProjectShell.holdLanding!!.complete(Unit)
        await { !exists(hasTestTag("landing:retry"), unmerged = true) && !exists(hasTestTag("landing:abandon"), unmerged = true) }
        // The running claim's own door goes out.
        menu()
        assertEquals(listOf("Open task", "Open source session", "Stop landing"), items())
        item("Stop landing").performClick()
        await { ProjectShell.calls.contains("POST projects/$launch/tasks/t-landing/integration/stop") }
        settle()
        assertFalse(exists(hasTestTag("landing:refusal"), unmerged = true))
        assertEquals(0, jobDoors("abandon"))
        assertEquals(1, jobDoors("retry"))
    }

    /** The page's poll that leaves while a press is out carries the page as it was then, press and all. Landing after the press has
     *  read itself back, it must not put the doors down again — every later poll would carry them down, and none would come back. */
    @Test fun aPollThatLeftDuringAPressDoesNotHoldTheDoorsDownAfterIt() {
        ProjectShell.landing = view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true)
        signIn(); open("orbit-session:$landing")
        await { enabled("landing:retry") && enabled("landing:abandon") }
        val press = CompletableDeferred<Unit>()
        val poll = CompletableDeferred<Unit>()
        ProjectShell.holdLandingReads.addAll(listOf(press, poll))
        val reads = landingReads()
        compose.onNodeWithTag("landing:retry").performClick()
        await { jobDoors("retry") == 1 && landingReads() == reads + 1 }
        // The poll comes round (4 s for a running attempt) while the press's read is out.
        compose.mainClock.advanceTimeBy(4_100)
        await { landingReads() == reads + 2 }
        press.complete(Unit)
        await { enabled("landing:retry") && enabled("landing:abandon") }
        poll.complete(Unit)
        settle()
        compose.onNodeWithTag("landing:abandon").assertIsEnabled().performClick()
        await { jobDoors("abandon") == 1 }
    }

    /** The status card's V6 line is the server's liveness, drawn under the same head every landing surface wears. */
    @Test fun theCardSaysTheServersStepTheClaimAndTheOutputsAge() {
        ProjectShell.landing = view(liveness = "QUIET")
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:live")) }
        assertEquals("1m 50s of 60m", text("landing-head:right"))
        assertTrue(text("landing-head:detail")!!.startsWith("checking · no output for"))
        assertEquals("Task acceptance 1m 50s of 60m", text("landing:budget"))
    }

    /** A settled subject draws its outcome and its read-only footer, and polls nothing more (§2.7a). */
    @Test fun aSettledLandingDrawsItsOutcomeAndStops() {
        ProjectShell.landing = view(state = "RUNNING", settledAt = ago(60), settledAs = "LANDED")
        signIn(); open("orbit-session:$landing")
        await { exists(hasText("Landed") and hasAnyAncestor(hasTestTag("landing-status-card")), unmerged = true) }
        assertEquals("This landing is complete — nothing to type here.", text("landing:footer-line"))
        val reads = ProjectShell.calls.count { it == "GET sessions/$landing" }
        Thread.sleep(5_500)
        compose.waitForIdle()
        assertEquals("a settled landing is not polled", reads, ProjectShell.calls.count { it == "GET sessions/$landing" })
    }

    /** The server's timeline is drawn, and a finished check opens its log from the line's own selectors. */
    @Test fun theServersTimelineIsDrawnAndItsCheckOpensTheLog() {
        ProjectShell.landing = view(timeline = timeline("""{"kind":"CHECK_FINISHED","at":"${ago(600)}","claim":1,"round":1,
            "check":{"name":"TASK_ACCEPTANCE","index":1},"text":"Task acceptance failed · exit 1"}"""))
        ProjectShell.landingLog = """{"jobId":"j-1","entries":[{"claim":1,"round":1,"seq":0,"text":"FAILED something\n","truncatedBytes":0}],"nextCursor":null}"""
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:section:j-1")) }
        assertEquals("Generation 1", text("landing:section-title:j-1"))
        compose.onNodeWithTag("landing:log:0").performClick()
        await { exists(hasTestTag("landing:log-text")) }
        assertEquals("FAILED something\n", text("landing:log-text"))
        await { ProjectShell.calls.any { it.startsWith("GET sessions/$landing/landing/log?jobId=j-1") } }
    }

    /** The marks read the line's fields, not its sentence: a reworded pass keeps its ✓ and stays one line, and a failed
     *  check whose sentence says `passed` draws ✗ and reads its tail inline. */
    @Test fun theTimelinesMarksReadTheLinesFieldsNotItsSentence() {
        ProjectShell.landing = view(state = "CHECK_FAILED", timeline = timeline("""{"kind":"CHECK_FINISHED","at":"${ago(900)}","claim":1,
            "round":1,"check":{"name":"TASK_ACCEPTANCE","index":1},"data":{"exitCode":0,"expectedExitCode":0,"timedOut":false},
            "text":"Task acceptance green · 3m 52s"},
            {"kind":"CHECK_FINISHED","at":"${ago(600)}","claim":1,"round":1,"check":{"name":"MERGE_CHECK","index":2},
            "data":{"exitCode":1,"expectedExitCode":0,"timedOut":false},"text":"Merge check passed · 1m 10s"},
            {"kind":"RESULT","at":"${ago(300)}","claim":1,"data":{"state":"LANDED"},"text":"Put on project/launch · 8ed0ea7"},
            {"kind":"RESULT","at":"${ago(200)}","claim":1,"data":{"state":"READY"},"text":"Ready to merge into fix/passed-x"}"""))
        ProjectShell.landingLog = """{"jobId":"j-1","entries":[{"claim":1,"round":1,"seq":0,"text":"FAILED something\n","truncatedBytes":0}],"nextCursor":null}"""
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:mark:3")) }
        assertEquals(listOf("✓", "✗", "✓", "✗"), (0..3).map { text("landing:mark:$it") })
        // Only the check that did not pass reads its tail inline (05 g): its last lines in the dark block, not the whole log.
        await { exists(hasTestTag("landing:inline-output")) }
        assertEquals(1, compose.onAllNodesWithTag("landing:inline-output", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals("FAILED something", inlineText())
        assertFalse("the whole log opens only from Log ›", exists(hasTestTag("landing:log-block"), unmerged = true))
        val logs = ProjectShell.calls.filter { it.startsWith("GET sessions/$landing/landing/log?") }
        assertTrue(logs.any { it.contains("check=2") })
        assertTrue(logs.none { it.contains("check=1") })
    }

    /** A merge check that ends READY passed: its result line draws ✓. A merge to main that answers READY handed the candidate back
     *  to be checked again (M-T12, J-T13) and keeps its ✗. The section's job kind decides, beside the line's state. */
    @Test fun aMergeCheckThatEndsReadyDrawsACheckmark() {
        ProjectShell.landing = view(kind = "CHECK_PROMOTION", subject = "PROMOTION", taskId = null, promotionId = "p-1", state = "READY",
            timeline = """{"sections":[{"title":"Merge check · 1","jobId":"j-1","kind":"CHECK_PROMOTION","generation":1,"state":"READY",
            "entries":[{"kind":"RESULT","at":"${ago(900)}","claim":1,"data":{"state":"READY"},"text":"Ready to merge into main"}]},
            {"title":"Merge to main · 1","jobId":"j-2","kind":"LAND_PROMOTION","generation":1,"state":"READY",
            "entries":[{"kind":"RESULT","at":"${ago(600)}","claim":1,"data":{"state":"READY"},"text":"Ready to merge into main"}]}],"facts":[]}""")
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:section:j-2")) }
        val marks = compose.onAllNodesWithTag("landing:mark:0", useUnmergedTree = true).fetchSemanticsNodes()
            .map { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text } }
        assertEquals(listOf("✓", "✗"), marks)
    }

    /** A merge check that ended READY passed and waits for the owner: its card writes no `Stopped · not landed`. */
    @Test fun aMergeCheckThatEndedReadyWritesNoStoppedLine() {
        ProjectShell.landing = view(kind = "CHECK_PROMOTION", subject = "PROMOTION", taskId = null, promotionId = "p-1", state = "READY")
        signIn(); open("orbit-session:$landing")
        await { text("landing-head:detail") == "Passed the check · waiting for the owner" }
        assertEquals("Merge check", text("landing-head:title"))
        assertEquals("Ready", text("landing-head:right"))
        assertFalse(exists(hasTestTag("landing:failure"), unmerged = true))
        assertFalse(exists(hasText("Stopped · not landed"), unmerged = true))
    }

    /** A cancelled landing really stopped, and its card still says so. */
    @Test fun aCancelledLandingStillSaysItStopped() {
        ProjectShell.landing = view(state = "CANCELLED")
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:failure"), unmerged = true) }
        assertEquals("Stopped · not landed", text("landing:failure"))
    }

    // MARK: a failed check's tail (A11-20 b; iOS and web `LandingInlineOutput`)

    /** One page of the landing log holding [printed] as one chunk. */
    private fun log(printed: String) =
        """{"jobId":"j-1","entries":[{"claim":1,"round":1,"seq":0,"text":${kotlinx.serialization.json.JsonPrimitive(printed)},"truncatedBytes":0}],"nextCursor":null}"""
    private val failedCheck get() = timeline("""{"kind":"CHECK_FINISHED","at":"${ago(600)}","claim":1,"round":1,
        "check":{"name":"TASK_ACCEPTANCE","index":1},"data":{"exitCode":1,"expectedExitCode":0,"timedOut":false},
        "text":"Task acceptance failed · exit 1"}""")
    private fun inlineText() = compose.onAllNodes(hasTestTag("landing:output") and hasAnyAncestor(hasTestTag("landing:inline-output")), true)
        .fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }

    /** 05 g: the tail a failed check died on is its last six lines that are not blank, in the dark block; `Log ›` opens the whole
     *  log in its place. */
    @Test fun aFailedChecksTailIsItsLastSixLinesAndLogOpensTheWhole() {
        val printed = (1..9).joinToString("\n") { "line $it" } + "\n\n   \n"
        ProjectShell.landing = view(state = "CHECK_FAILED", timeline = failedCheck); ProjectShell.landingLog = log(printed)
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:inline-output")) }
        assertEquals((4..9).joinToString("\n") { "line $it" }, inlineText())
        assertFalse(exists(hasTestTag("landing:log-block"), unmerged = true))
        compose.onNodeWithTag("landing:log:0").performClick()
        await { exists(hasTestTag("landing:log-block")) }
        assertEquals(printed, text("landing:log-text"))
        assertFalse("the opened log takes the tail's place", exists(hasTestTag("landing:inline-output"), unmerged = true))
    }

    /** A log that printed nothing but blank lines, or one this device could not read, draws nothing inline — no "printed nothing", no
     *  "couldn't read": the check's line says it failed, and `Log ›` still says what the read found. */
    @Test fun aFailedCheckWithNothingPrintedDrawsNoTail() {
        ProjectShell.landing = view(state = "CHECK_FAILED", timeline = failedCheck); ProjectShell.landingLog = log(" \n\t\n\n")
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:log:0")) && ProjectShell.calls.any { it.startsWith("GET sessions/$landing/landing/log?") } }
        settle()
        assertFalse(exists(hasTestTag("landing:inline-output"), unmerged = true))
        assertFalse(exists(hasText(io.orbitd.android.reader.LandingSessionCopy.LOG_EMPTY), unmerged = true))
        compose.onNodeWithTag("landing:log:0").performClick()
        await { exists(hasTestTag("landing:log-block")) }
        assertTrue(exists(hasText(" \n\t\n\n") and hasTestTag("landing:log-text"), unmerged = true))
    }

    @Test fun aFailedCheckWhoseLogCannotBeReadDrawsNoTail() {
        ProjectShell.landing = view(state = "CHECK_FAILED", timeline = failedCheck); ProjectShell.landingLogStatus = 503
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing:log:0")) && ProjectShell.calls.any { it.startsWith("GET sessions/$landing/landing/log?") } }
        settle()
        assertFalse(exists(hasTestTag("landing:inline-output"), unmerged = true))
        assertFalse(exists(hasText(io.orbitd.android.reader.LandingSessionCopy.LOG_UNAVAILABLE), unmerged = true))
        compose.onNodeWithTag("landing:log:0").performClick()
        await { exists(hasText(io.orbitd.android.reader.LandingSessionCopy.LOG_UNAVAILABLE), unmerged = true) }
    }

    // MARK: a server this device cannot read (A11-20 e; iOS `offlineCard`, `landingInFlightCache`)

    /** The job an integration read lists for this landing (`inFlightJobs`, with its `landingSessionId`), 200 s into its check. */
    private fun listedJob() = """[{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskId":"t-landing",
        "taskTitle":"Wire the page","generation":1,"startedAt":"${ago(200)}","queuedAt":"${ago(260)}","heartbeatAt":"${ago(5)}",
        "runnerName":"wikova","timedOut":false,"limitSeconds":600,"retryable":false,"progressProtocol":"v2","claim":1,"round":1,
        "check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(200)}"},
        "stepStartedAt":"${ago(200)}","outputMovedAt":"${ago(6)}","typicalMs":null,"liveness":"LIVE","landingSessionId":"$landing"}]"""

    /** The project sessions page's poll read the landing's job; then the server cannot be read. The link still opens the landing
     *  page — the read that would say its kind failed, and that job names this id — and the card is the job frozen. */
    @Test fun aLinkTheServerCannotAnswerOpensTheLandingFrozenFromTheSessionsPagesRead() {
        ProjectShell.landing = view(); ProjectShell.inFlightJobs = listedJob()
        signIn(); openSessionsPage()
        await { ProjectShell.calls.contains("GET projects/$launch/integration") }
        ProjectShell.landingStatus = 503
        open("orbit-session:$landing")
        assertFrozen()
    }

    /** Work overview's read keeps the job the same way. */
    @Test fun workOverviewsReadKeepsTheJobForItsLandingPage() {
        ProjectShell.landing = view(); ProjectShell.inFlightJobs = listedJob()
        signIn(); open("orbit-project:$launch")
        await { exists(hasTestTag("project-detail")) && ProjectShell.calls.contains("GET projects/$launch/integration") }
        ProjectShell.landingStatus = 503
        open("orbit-session:$landing")
        assertFrozen()
    }

    /** And so does the landing page's own read: opened again once the server cannot be read, it draws what it last read. */
    @Test fun theLandingPagesOwnReadKeepsTheJobForALaterVisit() {
        ProjectShell.landing = view(); ProjectShell.inFlightJobs = listedJob()
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("landing-more")) && ProjectShell.calls.contains("GET projects/$launch/integration") }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await { !exists(hasTestTag("landing-page")) }
        ProjectShell.landingStatus = 503
        open("orbit-session:$landing")
        assertFrozen()
    }

    /** No read named the id as a landing's: a kind that cannot be read still opens the reader, as it did. */
    @Test fun aLinkTheServerCannotAnswerAndNoReadNamedOpensTheReader() {
        ProjectShell.landing = view(); ProjectShell.landingStatus = 503
        signIn(); open("orbit-session:$landing")
        await { exists(hasTestTag("transcript-list")) }
        assertFalse(exists(hasTestTag("landing-page")))
    }

    /** The frozen page: the job's word and its clock where the read left it, `Update unavailable`, how long ago that read was, no
     *  door and no menu, and nothing of the conversation. */
    private fun assertFrozen() {
        await { exists(hasTestTag("landing-page")) && text("landing-head:detail") == "Update unavailable" }
        assertTrue(ProjectShell.calls.contains("GET sessions/$landing"))
        assertEquals("Landing", text("landing-head:title"))
        val clock = text("landing-head:right")!!
        assertTrue("$clock is the step's clock at the read, 200 s or more into it", clock.matches(Regex("[3-9]m \\d{1,2}s")))
        assertTrue(text("landing:live")!!.matches(Regex("Updated \\d+m ago")))
        assertFalse(exists(hasTestTag("landing:status-note"), unmerged = true))
        listOf("landing-more", "landing:retry", "landing:rerun", "landing:abandon", "landing:footer", "transcript-list").forEach {
            assertFalse(it, exists(hasTestTag(it), unmerged = true))
        }
        settle()
        assertEquals("the clock does not run on a read that failed", clock, text("landing-head:right"))
        assertTrue(ProjectShell.calls.none { it.startsWith("GET sessions/$landing/events") })
    }

    private fun openSessionsPage() {
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:$launch")) }
        compose.onNodeWithTag("project-row:$launch").performClick()
        await { exists(hasTestTag("project-sessions")) }
    }

    /** Lets what a read answered reach the screen, for an assertion that something is NOT drawn. */
    private fun settle() { repeat(3) { compose.waitForIdle(); Thread.sleep(400) }; compose.waitForIdle() }

    // MARK: the journey's hands and eyes

    private fun app() = compose.activity.application as OrbitApplication
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
    private fun menuOpen() = exists(hasTestTag("landing-menu"))
    private fun menu() {
        await { exists(hasTestTag("landing-more")) }
        compose.onNodeWithTag("landing-more").performClick()
        await { menuOpen() || items().isNotEmpty() }
        compose.waitForIdle()
    }
    private fun items() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun item(text: String) = compose.onNode(hasText(text) and hasAnyAncestor(isPopup()) and hasClickAction())
    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun enabled(tag: String) = exists(hasTestTag(tag) and isEnabled())
    private fun landingReads() = ProjectShell.calls.count { it == "GET sessions/$landing" }
    /** The presses of one door on the landing's job: `retry` or `abandon`. */
    private fun jobDoors(door: String) = ProjectShell.calls.count { it == "POST projects/$launch/integration/jobs/j-1/$door" }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
