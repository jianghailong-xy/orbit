package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The account's switch for session recaps (0418; iOS `UserPreferences.showRecaps`): Settings → Sessions has it, written alone as
 * preferences.recaps, and while it is off the session lists draw none of the server's recap — every row falls back to the raw last
 * reply, which is what `DirectoryReviewTest` holds at the row itself. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h4000dp")
class SessionRecapsGateTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }

    private fun await(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    /** Absent on the server means on — the switch reads on, and its hint is the shared sentence — and flipping it writes `recaps`
     * alone, `false` included. */
    @Test fun settingsHasTheSwitchWrittenAloneAsRecaps() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await("Session recaps")
        compose.onNodeWithText(SESSION_RECAPS_HINT, useUnmergedTree = true).assertExists()
        val row = hasText("Session recaps") and isToggleable()
        compose.onNode(row).assertIsOn()
        compose.onNode(row).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.recaps == false }
        compose.waitUntil(60_000) { runCatching { compose.onNode(row).assertIsOff() }.isSuccess }
        assertEquals("written alone", 1, fixture.writes("users/me/preferences").size)
    }

    /** The switch is the whole app's at once: what `AccountAppearance` hands every session list — the directory's rows and a
     * project's — follows Settings the moment the server took the change. */
    @Test fun settingsSwitchIsTheWholeAppsAtOnce() {
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        runBlocking { fixture.signIn(app.session) }
        val api = ManagementApi(app.session, (app.session.state.value as AuthState.SignedIn).handle)
        compose.setContent {
            AccountAppearance(app) {
                Column {
                    Text("session recaps: " + if (LocalSessionRecaps.current) "on" else "off")
                    SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                        deviceAlerts = { true }, notifications = {}, about = {})
                }
            }
        }
        await("session recaps: on"); await("Session recaps")
        compose.onNode(hasText("Session recaps") and isToggleable()).performScrollTo().performClick()
        await("session recaps: off")
        assertEquals(false, fixture.recaps)
    }
}
