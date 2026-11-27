package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.directory.QueuedCapacity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The runner page's `Extra sessions on demand` (docs/mocks/queued-run-now, decision C; web `MachineSettingsPage`): how far over
 *  Max Concurrent Run now may go, picked from a list and saved at once. Not drawn for a server that sends no `burstConcurrent`. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class ExtraSessionsOnDemandTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() = fixture.reset()

    private fun page() {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { RunnerScreen(api, fixture.RUNNER, null, 0, {}, {}, {}) }
        compose.waitUntil(60_000) { compose.onAllNodesWithText(RunnerCopy.MAX_CONCURRENT).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun theRunnersSettingIsShownAndSavedAsPicked() {
        fixture.runnerExtra = ""","burstConcurrent":2"""
        page()
        compose.onNodeWithTag("runner-extra-sessions").performScrollTo().assertTextContains(QueuedCapacity.EXTRA_SESSIONS_ON_DEMAND)
            .assertTextContains("2").performClick()
        compose.waitForIdle()
        compose.onNode(hasText("3") and hasClickAction()).performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it == "PATCH runners/${fixture.RUNNER} {\"burstConcurrent\":3}" } }
    }

    @Test fun aServerThatSendsNoneDrawsNoRow() {
        page()
        assertTrue(compose.onAllNodesWithTag("runner-extra-sessions").fetchSemanticsNodes().isEmpty())
    }
}
