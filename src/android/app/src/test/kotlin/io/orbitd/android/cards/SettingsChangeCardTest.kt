package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.SettingsChangeCopy
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
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

/**
 * The SETTINGS_CHANGE card (docs/settings-from-conversation-design.md §8), its folded states on the real wire, the Open in Settings row
 * an `orbit-settings:` link becomes, and the grey line under a changed Settings row. iOS `SettingsChangeViews`, web `SettingsChangeCard`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class SettingsChangeCardTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: OwnerRequestStore
    private val id = OwnerRequestFixture.SETTINGS_ID
    private val tag = "owner-request:$id"

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.settingsChange())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 1 && store.state.value.open.size == 1 }
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private fun show() {
        compose.setContent { OrbitTheme(darkTheme = false) {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp)) { state.find(id)?.let { OwnerRequestInConversation(it, store, { "mac-mini" }, {}) } }
        } }
        compose.waitForIdle()
    }
    private fun node(part: String) = compose.onNodeWithTag("$tag:$part", useUnmergedTree = true)
    private fun posted(door: String) = compose.waitUntil(10_000) { fixture.posts().any { it.path == "/api/owner-requests/$id/$door" } }
    private fun marks() = buildJsonObject {
        put("id", "u"); put("email", "u@example.test"); put("name", "U")
        putJsonObject("changedBy") {
            listOf("translationEnabled" to JsonPrimitive(false), "translationLanguage" to JsonPrimitive("en"), "defaultPermissionMode" to JsonPrimitive("default"))
                .forEach { (key, from) -> putJsonObject(key) {
                    put("sessionId", OwnerRequestFixture.SESSION); put("requestId", id); put("at", Instant.now().minusSeconds(120).toString())
                    put("from", from); put("sessionTitle", "Translate the docs")
                } }
        }
    }

    @Test fun theCardNamesEachRowStruckFromToTheAgentsWordsAndTheFoot() {
        show()
        node("title").assertTextEquals("⚙️ Confirm: change 3 settings?")
        compose.onAllNodesWithTag("$tag:path", useUnmergedTree = true).assertCountEquals(2)
        compose.onNodeWithText("Settings › General › Translation", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Settings › General › New sessions", useUnmergedTree = true).assertExists()
        node("from:translationEnabled").assertTextEquals("Off")
        node("to:translationEnabled").assertTextEquals("On")
        node("from:translationLanguage").assertTextEquals("English")
        node("to:translationLanguage").assertTextEquals("Chinese (Simplified)")
        node("to:defaultPermissionMode").assertTextEquals("Plan")
        // Only the tier-2 key says it applies to new sessions.
        node("new-sessions:defaultPermissionMode").assertTextEquals("Applies to new sessions only.")
        compose.onAllNodesWithTag("$tag:new-sessions:translationEnabled", useUnmergedTree = true).assertCountEquals(0)
        node("why").assertTextEquals("The agent says: You asked for the agents to write Chinese and for the app to be dark.")
        node("foot").assertTextEquals("Only these change. You can change them back in Settings.")
        compose.onNodeWithText("Save changes", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("💬 Chat about this", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Always allow", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun saveChangesAppliesAndTheCardFoldsToOneLineWithUndo() {
        fixture.me = marks()
        show()
        node("primary").performClick()
        posted("apply-settings")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:undo", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        node("outcome").assertTextEquals("✓ Changed 3 settings")
        compose.onAllNodesWithTag("$tag:primary", useUnmergedTree = true).assertCountEquals(0)
        node("undo").performClick()
        compose.waitUntil(10_000) { fixture.calls.any { it.method == "PATCH" && it.path == "/api/users/me/preferences" } }
        val patch = Json.parseToJsonElement(fixture.calls.last { it.method == "PATCH" }.body).jsonObject
        assertEquals(setOf("translationEnabled", "translationLanguage", "defaultPermissionMode"), patch.keys)
        assertEquals(JsonPrimitive(false), patch["translationEnabled"])
        assertEquals(JsonPrimitive("en"), patch["translationLanguage"])
        assertEquals(JsonPrimitive("default"), patch["defaultPermissionMode"])
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:undone", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        node("undone").assertTextEquals("Undone")
    }

    @Test fun aSettingChangedSinceKeepsNoUndoForItsKey() {
        // Only the language is still marked by this request: the other two were changed by the owner since.
        fixture.me = JsonObject(marks() + ("changedBy" to buildJsonObject { marks().getValue("changedBy").jsonObject["translationLanguage"]?.let { put("translationLanguage", it) } }))
        show()
        node("primary").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:undo", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        node("undo").performClick()
        compose.waitUntil(10_000) { fixture.calls.any { it.method == "PATCH" } }
        assertEquals(setOf("translationLanguage"), Json.parseToJsonElement(fixture.calls.last { it.method == "PATCH" }.body).jsonObject.keys)
    }

    @Test fun aValueThatMovedFoldsTheCardToTheStaleLineAndDeclineSaysSo() {
        fixture.staleApply = true
        show()
        node("primary").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:stale", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("This setting changed since it was proposed.", useUnmergedTree = true).assertExists()
        // The request stays pending on the server: the owner can still decline it.
        compose.onNodeWithText("Decline", useUnmergedTree = true).performClick()
        posted("decline")
        assertEquals("This setting changed since it was proposed.",
            Json.parseToJsonElement(fixture.posts().last { it.path.endsWith("/decline") }.body).jsonObject["reason"]?.jsonPrimitive?.content)
    }

    @Test fun chatAboutThisAsksWhatTheAgentShouldKnowAndDeclinesWithIt() {
        show()
        node("chat").performClick()
        node("decline-send").assertIsNotEnabled()
        compose.onNodeWithText("What should the agent know? It reads this.", useUnmergedTree = true).assertExists()
        node("reason").performTextInput("Leave the theme alone")
        node("decline-send").performClick()
        posted("decline")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        node("outcome").assertTextEquals("Declined")
    }

    @Test fun keepItClosesTheDeclineForm() {
        show()
        node("chat").performClick()
        node("keep").performClick()
        node("primary").assertExists()
        compose.onAllNodesWithTag("$tag:reason", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun anOrbitSettingsLinkOnItsOwnLineIsTheOpenInSettingsRow() {
        val opened = mutableListOf<String>()
        compose.setContent { OrbitTheme(darkTheme = false) {
            MarkdownText("Turn it on here:\n\n[Translate conversations](orbit-settings:translationEnabled)", Modifier, { opened += it })
        } }
        compose.onNodeWithText("Translate conversations", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Settings › General › Translation", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(SettingsChangeCopy.openInSettings, useUnmergedTree = true).performClick()
        assertEquals(listOf("orbit-settings:translationEnabled"), opened)
        // The link opens Settings at that row: its page, the row named for the page to scroll to and flash.
        val route = OrbitLinks.parse(opened.single())!!
        assertEquals(Destination.SETTINGS, route.destination)
        assertEquals("sessions", route.id)
        assertEquals("translationEnabled", route.recordId)
        assertEquals(null, OrbitLinks.parse("orbit-settings:theme")!!.id)
        assertNull(OrbitLinks.parse("orbit-settings:nothing"))
    }

    @Test fun aLinkInsideAProseLineStaysALink() {
        compose.setContent { OrbitTheme(darkTheme = false) { MarkdownText("Open [it](orbit-settings:theme) later") } }
        compose.onAllNodesWithText(SettingsChangeCopy.openInSettings, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theSettingsRowLineNamesTheConversationAndUndoWritesTheOldValue() {
        val written = mutableListOf<Pair<String, JsonPrimitive>>()
        compose.setContent { OrbitTheme(darkTheme = false) { Column {
            SettingChangedLine("translationEnabled", marks()) { key, value -> written += key to value }
            SettingChangedLine("recaps", marks()) { key, value -> written += key to value }
        } } }
        compose.onNodeWithTag("setting-changed-translationEnabled", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Turned on from Translate the docs · 2m ago · ", useUnmergedTree = true).assertExists()
        // A setting with no mark draws nothing under its row.
        compose.onAllNodesWithTag("setting-changed-recaps", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithTag("setting-changed-undo-translationEnabled", useUnmergedTree = true).performClick()
        assertEquals(listOf("translationEnabled" to JsonPrimitive(false)), written)
    }

    @Test fun theWaitingKindsWordsForASettingsChange() {
        assertEquals("SETTINGS", OwnerRequests.kindTag("SETTINGS_CHANGE"))
        assertEquals("Save changes", OwnerRequests.primary("SETTINGS_CHANGE"))
        assertEquals("Review", OwnerRequests.pushAction("SETTINGS_CHANGE"))
    }
}
