package io.orbitd.android

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
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
 * docs/list-freshness-design.md §4 R5 for the open conversation, in the production shell: D1 left its snapshot (`sessions/<id>` and
 * the reads beside it) and the reader's cards (SessionCardsReads: created tasks, merges, watches) read again on every account event's
 * window. An event about another session reads neither; one about this conversation reads each exactly once.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ReaderCardReadsShellTest {
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

    private val coord = ProjectShell.COORD

    @Test fun anEventAboutAnotherSessionReadsNeitherTheSnapshotNorTheCardsAndItsOwnReadsEachOnce() {
        signIn(); open("orbit-session:$coord")
        await { exists(hasTestTag("transcript-list")) }
        await { cardReads(0) > 0 }
        advance(3_000)
        val before = ProjectShell.calls.size
        ProjectShell.event("session.updated", ProjectShell.WORKER)
        ProjectShell.event("approval.requested", ProjectShell.WAITING)
        ProjectShell.event("background.task", ProjectShell.PLAIN)
        advance(3_000)
        assertEquals("another session's events: ${ProjectShell.calls.drop(before)}", 0, snapshotReads(before))
        assertEquals("and no card read: ${ProjectShell.calls.drop(before)}", 0, cardReads(before))
        val own = ProjectShell.calls.size
        ProjectShell.event("session.updated", coord)
        advance(1_500)
        await { cardReads(own) > 0 }
        advance(3_000)
        assertEquals("its own event: ${ProjectShell.calls.drop(own)}", 1, snapshotReads(own))
        assertEquals("its own event: ${ProjectShell.calls.drop(own)}", 1, cardReads(own))
    }

    /** The store's snapshot (RealtimeRest.session), by the read only it makes: the detail alone is also the worktree bar's poll. */
    private fun snapshotReads(from: Int) = ProjectShell.calls.drop(from).count { it == "GET sessions/$coord/approvals?status=PENDING" }
    private fun cardReads(from: Int) = ProjectShell.calls.drop(from).count { it == "GET sessions/$coord/created-tasks" }

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
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
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
