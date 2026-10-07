package io.orbitd.android.watch

import android.os.Looper
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration
import java.time.Instant

/** The app whose one session is a journaled fake `/api`, so the destination's own reads can be counted. */
class WatchTestApplication : OrbitApplication() {
    internal val server = FakeWatchServer()
    override fun createSession(): AuthSession = server.auth
}

/** `WatchDestination` as MainActivity hands it a route and the account's revision. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = WatchTestApplication::class, qualifiers = "w411dp-h891dp")
class WatchDestinationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val opened = mutableListOf<OrbitRoute>()

    private fun iso(secondsFromNow: Long) = Instant.now().plusSeconds(secondsFromNow).toString()

    @Test fun openingFollowingReadsOnceAndAnAccountEventNudgesItShortlyAfter() {
        val app = compose.activity.application as WatchTestApplication
        compose.waitUntil(5_000) { app.session.state.value is AuthState.SignedOut }
        val rows = listOf(WatchFixture.json(id = "A1", lastEvaluatedAt = iso(-20), createdAt = iso(-600), expiresAt = iso(3_600)))
        app.server.serve({ rows })
        val handle = runBlocking { app.server.signIn() }
        fun listReads() = app.server.lines.count { it.startsWith("GET /api/watches") && !it.startsWith("GET /api/watches/") }
        var revision by mutableLongStateOf(1L)
        var route by mutableStateOf(OrbitRoute(Destination.WATCH))
        compose.activityRule.scenario.onActivity { activity ->
            activity.setContent { OrbitTheme { WatchDestination(app, handle, route, revision) { opened += it } } }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("following-row:A1").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        assertEquals("opening Following reads the list once, and the floor counts from that read", 4, listReads())
        assertEquals("Following", PageBar.title(route))

        // An account event: a target may have moved, so the list is read again — once, two seconds on.
        compose.runOnIdle { revision = 2L }
        compose.waitForIdle()
        compose.runOnIdle { revision = 3L }
        compose.waitForIdle()
        assertEquals(4, listReads())
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2_100))
        compose.waitUntil(5_000) { listReads() == 8 }
        compose.waitForIdle()
        assertEquals(8, listReads())

        compose.onNodeWithTag("following-row:A1").performClick()
        assertEquals(listOf(OrbitRoute(Destination.WATCH, "A1")), opened)
        // The page for that id, from the same store: no read of its own while the list holds it.
        compose.runOnIdle { route = OrbitRoute(Destination.WATCH, "A1") }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("watch-detail:A1").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(app.server.lines.none { it.startsWith("GET /api/watches/") })
        assertEquals("Watching 2 targets", PageBar.title(route))
    }
}
