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
import kotlinx.serialization.json.*
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

/** Settings → General (once Sessions), as iOS has it since docs/mocks/ios-settings-order (2A, scope 3A) and ios-settings-web-groups:
 * Personal's first row opens the page, the
 * list itself holds none of the account's session settings, and the page draws them in iOS's order (SessionSettings), each
 * with the web's hint as its footer. Route by tier and Optimize For are on Providers › Model routing (ModelRoutingPageTest). */
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

    private val settings = listOf("Default permission", "Session orchestration", SUGGESTED_REPLIES, SESSION_RECAPS)

    @Test fun personalFirstRowOpensTheGeneralPage() {
        val api = api()
        val opened = mutableListOf<OrbitRoute>()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, { opened += it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(GENERAL)
        assertTrue("General is Personal's first row", top(SETTINGS_PERSONAL) < top(GENERAL) && top(GENERAL) < top("Notifications") &&
            top("Notifications") < top("Appearance"))
        settings.forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        compose.onNode(hasText(GENERAL) and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "sessions")), opened) }
        assertEquals(GENERAL, settingsTitle("sessions"))
    }

    @Test fun theSessionsPageDrawsThemInIosOrderEachWithItsHintUnderIt() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        val hints = listOf(DEFAULT_PERMISSION_HINT, SESSION_ORCHESTRATION_HINT, SUGGESTED_REPLIES_HINT, SESSION_RECAPS_HINT)
        val tops = settings.zip(hints).flatMap { (title, hint) -> listOf(top(title), top(hint)) }
        assertEquals("each setting, then its hint, in iOS's order", tops.sorted(), tops)
        // The fixture's account says auto and orchestration on, and names neither of the other two: absent reads as on.
        compose.onNode(hasText("Default permission") and hasText("Auto") and hasClickAction()).assertExists()
        compose.onNode(hasText("Session orchestration") and isToggleable()).assertIsOn()
        compose.onNode(hasText(SUGGESTED_REPLIES) and isToggleable()).assertIsOn()
        compose.onNode(hasText(SESSION_RECAPS) and isToggleable()).assertIsOn()
    }

    /** Route by tier and Optimize For moved to Providers › Model routing, as the web has them: General draws neither, nor their words. */
    @Test fun theGeneralPageNoLongerHasTheRoutingSwitches() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        listOf(SMART_MODEL_SELECTION, SMART_MODEL_SELECTION_HINT, OPTIMIZE_FOR, OPTIMIZE_FOR_DETAIL, "Balance").forEach {
            assertEquals(it, 0, compose.onAllNodesWithText(it, useUnmergedTree = true).fetchSemanticsNodes().size)
        }
    }
}
