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
 * with the web's hint as its footer — with the account-wide Optimize For (docs/mocks/routing-mode-account/01-account-wide-optimize-for.png)
 * below Smart model selection. */
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
        val hints = listOf(DEFAULT_PERMISSION_HINT, SESSION_ORCHESTRATION_HINT, SMART_MODEL_SELECTION_HINT, SUGGESTED_REPLIES_HINT,
            SESSION_RECAPS_HINT)
        val tops = settings.zip(hints).flatMap { (title, hint) -> listOf(top(title), top(hint)) }
        assertEquals("each setting, then its hint, in iOS's order", tops.sorted(), tops)
        // The fixture's account says auto and orchestration on, and names none of the other three: absent reads as on, smart model
        // selection's included.
        compose.onNode(hasText("Default permission") and hasText("Auto") and hasClickAction()).assertExists()
        compose.onNode(hasText("Session orchestration") and isToggleable()).assertIsOn()
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).assertIsOn()
        compose.onNode(hasText(SUGGESTED_REPLIES) and isToggleable()).assertIsOn()
        compose.onNode(hasText(SESSION_RECAPS) and isToggleable()).assertIsOn()
    }

    /** The account-wide Optimize For (docs/mocks/routing-mode-account/01-account-wide-optimize-for.png): directly below Smart model
     * selection, absent reads as Balance, and a segment writes `{"optimizeFor":…}` alone the moment it moves. */
    @Test fun optimizeForSitsUnderSmartModelSelectionAndASegmentWritesThePreference() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        // The title and its words are one list item, merged into one node: read each text on its own.
        fun textTop(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y
        assertTrue("title, then its words, under Route by tier's hint and above Suggested replies",
            textTop(SMART_MODEL_SELECTION_HINT) < textTop(OPTIMIZE_FOR) && textTop(OPTIMIZE_FOR) < textTop(OPTIMIZE_FOR_DETAIL) &&
                textTop(OPTIMIZE_FOR_DETAIL) < textTop(SUGGESTED_REPLIES))
        // The fixture's account names no optimizeFor: Balance is selected.
        compose.onNode(hasText("Balance") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Intelligence") and isSelectable()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.optimizeFor == "intelligence" }
        val patch = fixture.bodies.filter { it.startsWith("PATCH users/me/preferences") }
            .map { Json.parseToJsonElement(it.removePrefix("PATCH users/me/preferences").trim()).jsonObject }.single()
        assertEquals(buildJsonObject { put("optimizeFor", "intelligence") }, patch)
        // The server's answer carries it, so the segment stays selected.
        compose.onNode(hasText("Intelligence") and isSelectable()).assertIsSelected()
    }

    /** An account that stored a mode opens on its own segment, and opening writes nothing. */
    @Test fun aStoredOptimizeForPrefillsItsSegment() {
        val api = api()
        fixture.optimizeFor = "cost"
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        compose.waitUntil(60_000) { runCatching { compose.onNode(hasText("Cost") and isSelectable()).assertIsSelected() }.isSuccess }
        compose.onNode(hasText("Balance") and isSelectable()).assertIsNotSelected()
        assertTrue(fixture.bodies.none { it.startsWith("PATCH users/me/preferences") })
    }

    /** Only smart model selection reads Optimize For, so it shows only while the switch is on (owner, 2026-11-20): off, it is
     * gone, and turning the switch on brings it back on the mode the account kept. */
    @Test fun optimizeForShowsOnlyWhileSmartModelSelectionIsOn() {
        val api = api()
        fixture.modelRouting = false
        fixture.optimizeFor = "intelligence"
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await(SESSION_RECAPS)
        assertEquals(0, compose.onAllNodesWithText(OPTIMIZE_FOR, useUnmergedTree = true).fetchSemanticsNodes().size)
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.modelRouting == true }
        compose.waitUntil(60_000) { runCatching { compose.onNode(hasText("Intelligence") and isSelectable()).assertIsSelected() }.isSuccess }
        assertTrue(fixture.bodies.none { it.startsWith("PATCH users/me/preferences") && it.contains("optimizeFor") })
    }
}
