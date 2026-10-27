package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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

/** Settings → Sessions, as iOS has it since docs/mocks/ios-settings-order (2A, scope 3A): Preferences' first row opens the page, the
 * list itself holds none of the account's five session settings, and the page draws them in iOS's order (SessionSettings), each
 * with the web's hint as its footer. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h4000dp")
class SessionSettingsPageTest {
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

    private fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y

    private val settings = listOf("Default permission", "Session orchestration", SMART_MODEL_SELECTION, SUGGESTED_REPLIES, SESSION_RECAPS)

    @Test fun preferencesFirstRowOpensTheSessionsPage() {
        val api = api()
        val opened = mutableListOf<OrbitRoute>()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, { opened += it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSIONS)
        assertTrue("Sessions is Preferences' first row", top("Preferences") < top(SESSIONS) && top(SESSIONS) < top("Notifications") &&
            top("Notifications") < top("Appearance"))
        settings.forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        compose.onNode(hasText(SESSIONS) and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "sessions")), opened) }
        assertEquals(SESSIONS, settingsTitle("sessions"))
    }

    @Test fun theSessionsPageDrawsTheFiveInIosOrderEachWithItsHintUnderIt() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        val hints = listOf(DEFAULT_PERMISSION_HINT, SESSION_ORCHESTRATION_HINT, SMART_MODEL_SELECTION_HINT, SUGGESTED_REPLIES_HINT,
            SESSION_RECAPS_HINT)
        val tops = settings.zip(hints).flatMap { (title, hint) -> listOf(top(title), top(hint)) }
        assertEquals("each setting, then its hint, in iOS's order", tops.sorted(), tops)
        // The fixture's account says auto and orchestration on, and names none of the other three: absent reads as on, but smart
        // model selection's, which is off unless turned on.
        compose.onNode(hasText("Default permission") and hasText("Auto") and hasClickAction()).assertExists()
        compose.onNode(hasText("Session orchestration") and isToggleable()).assertIsOn()
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).assertIsOff()
        compose.onNode(hasText(SUGGESTED_REPLIES) and isToggleable()).assertIsOn()
        compose.onNode(hasText(SESSION_RECAPS) and isToggleable()).assertIsOn()
    }
}
