package io.orbitd.android

import android.os.Looper
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import io.orbitd.android.core.auth.AuthState
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * docs/list-freshness-design.md §2.3 D2–D3 in the production shell: the project's sessions page reads as the account stream says
 * (R1, R6) — with the stream up and nothing happening, each of its reads at most once a minute; the landing and the merge, which no
 * event announces (§2.9 LS6), every 4 s while the line has a job in flight and not once it has none — and nothing at all while the
 * Activity is stopped (R3). An account event reads the Open list once, and neither the drawer's projects nor the account.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectPagePollShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 0)
    val midday = MiddayZone()
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    /** R3: a stopped Activity's page reads nothing, however long it stays stopped — not even the landing, in flight here — and reads again
     * as the Activity starts. */
    @Test fun aStoppedActivitysProjectPageReadsNothing() {
        signIn(); openPage()
        val polling = pageReads().size
        advance(8_500)
        assertTrue("the page polls while it shows: ${pageReads().drop(polling)}", pageReads().size > polling)
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        advance(1_000)
        val stopped = pageReads().size
        advance(5 * 60_000L, by = 5_000)
        assertEquals("a stopped Activity's page reads nothing", emptyList<String>(), pageReads().drop(stopped))
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        advance(500)
        await { pageReads().size > stopped }
    }

    /** R1: the stream up, no event and nothing on the line — each of the page's reads at most once a minute. */
    @Test fun withTheStreamUpAndNoEventsThePageReadsEachOfItsListsAtMostOnceAMinute() {
        ProjectShell.lineIdle = true
        signIn(); openPage()
        advance(1_000)
        val opened = pageReads(drawer = false).size
        advance(58_000, by = 2_000)
        assertEquals("nothing is read within the minute", emptyList<String>(), pageReads(drawer = false).drop(opened))
        advance(3 * 60_000L, by = 2_000)
        val minutes = pageReads(drawer = false).drop(opened).groupingBy { it }.eachCount()
        assertTrue("three minutes, a read of each at most three times: $minutes", minutes.values.all { it <= 3 })
        assertTrue("the safety read happens: $minutes", (minutes["GET projects/${ProjectShell.LAUNCH}/integration"] ?: 0) >= 2)
    }

    /** A landing publishes no event (LS6), so the page reads its line every 4 s while a job is in flight — and once the job has left it,
     * the 4 s reads stop and the page follows the stream again. */
    @Test fun theLineIsReadEvery4sWhileAJobIsInFlightAndNotOnceItLeaves() {
        signIn(); openPage()
        advance(1_000)
        val first = integrationReads()
        advance(8_000)
        assertEquals("every 4 s while a job is in flight", first + 2, integrationReads())
        ProjectShell.lineIdle = true
        advance(4_000)
        val left = integrationReads()
        assertEquals("the read that finds the line idle", first + 3, left)
        advance(50_000, by = 2_000)
        assertEquals("then no 4 s reads", left, integrationReads())
    }

    /** D2: an account event reads the Open list once its window closes — and not the drawer's projects, the account, or any other list
     * of the directory's. */
    @Test fun aSessionEventReadsTheOpenListOnceAndNotTheDrawersProjectsOrTheAccount() {
        ProjectShell.lineIdle = true
        signIn(); openPage()
        advance(2_000)
        val before = ProjectShell.calls.size
        ProjectShell.event("session.updated", ProjectShell.LAUNCH)
        // The store's window (half a second) and its read.
        advance(1_500)
        await { ProjectShell.calls.drop(before).any { it.substringBefore("&since=") == "GET sessions?view=open" } }
        advance(3_000)
        val after = ProjectShell.calls.drop(before)
        assertEquals(after.toString(), 1, after.count { it.substringBefore("&since=") == "GET sessions?view=open" })
        assertEquals(after.toString(), emptyList<String>(), after.filter {
            it == "GET projects?status=OPEN" || it == "GET users/me" || it == "GET projects/sidebar" ||
                it in setOf("GET workspaces", "GET session-folders", "GET session-tags", "GET runners")
        })
    }

    /** What the project's sessions page reads — the sidebar it shares with the list included — and the drawer's projects with it unless
     * [drawer] is false: the drawer's poll began before the page's, so its minute ends at another time. */
    private fun pageReads(drawer: Boolean = true) = ProjectShell.calls.filter { call ->
        call.startsWith("GET ") && (call.contains("projects/${ProjectShell.LAUNCH}") || call.contains("projectId=${ProjectShell.LAUNCH}") ||
            call == "GET projects/sidebar" || (drawer && call == "GET projects?status=OPEN"))
    }
    private fun integrationReads() = ProjectShell.calls.count { it == "GET projects/${ProjectShell.LAUNCH}/integration" }

    /** [ms] of both clocks the app's reads run on, [by] at a time: the composition's, which the pages' polls wait on, and the main
     * looper's, which the store's event window waits on. */
    private fun advance(ms: Long, by: Long = 500) {
        var left = ms
        while (left > 0) {
            val step = minOf(by, left)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(step))
            compose.mainClock.advanceTimeBy(step)
            compose.waitForIdle()
            left -= step
        }
    }
    private fun openPage() {
        await { exists(hasTestTag("project-row:${ProjectShell.LAUNCH}")) }
        compose.openProjectSessionsPage(ProjectShell.LAUNCH)
        await { exists(hasTestTag("project-sessions")) }
        await { integrationReads() > 0 && ProjectShell.calls.any { it.startsWith("GET sessions?view=completed&projectId=") } }
    }
    private fun exists(matcher: androidx.compose.ui.test.SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
