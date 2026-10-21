package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
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
        // Only the check that did not pass reads its tail inline (05 g).
        await { exists(hasTestTag("landing:log-text")) }
        assertEquals(1, compose.onAllNodesWithTag("landing:log-block", useUnmergedTree = true).fetchSemanticsNodes().size)
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
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
