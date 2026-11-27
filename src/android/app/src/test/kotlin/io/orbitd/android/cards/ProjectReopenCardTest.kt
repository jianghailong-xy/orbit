package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
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

/** The PROJECT_REOPEN card on the real wire: its words, Reopen calling `reopen-project`, and Chat about this (docs/project-reopen-request-design.md §6). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ProjectReopenCardTest {
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
    private val id = OwnerRequestFixture.REOPEN_ID
    private val tag = "owner-request:$id"

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.projectReopen())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 1 && store.state.value.open.size == 1 }
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private var discussed: String? = null
    private fun show(onProjectPage: Boolean = false, discuss: ((String) -> Unit)? = { discussed = it }) {
        compose.setContent { OrbitTheme(darkTheme = false) {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp)) {
                state.find(id)?.let {
                    if (onProjectPage) ProjectReopenCard(it, store, onProjectPage = true)
                    else OwnerRequestInConversation(it, store, { "mac-mini" }, {}, discuss = discuss)
                }
            }
        } }
        compose.waitForIdle()
    }
    private fun node(part: String) = compose.onNodeWithTag("$tag:$part", useUnmergedTree = true)

    @Test fun theCardInTheTranscriptNamesTheProjectTheReasonAndThePlannedWork() {
        show()
        node("title").assertTextEquals("↺ Reopen project “Share to Orbit”?")
        node("settled").assertTextEquals("DONE since Nov 18")
        node("why").assertTextEquals("The agent says: The share sheet needs a dark-mode fix that changes its acceptance criteria.")
        node("planned").assertTextEquals("Restyle the share sheet for dark mode and add a screenshot check.")
        node("askers").assertTextEquals("Also asked by Audit dark mode")
        compose.onNodeWithText("Reopen", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("💬 Chat about this", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Always allow", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun reopenCallsTheReopenProjectDoorAndTheCardFoldsToOneLine() {
        show()
        node("primary").performClick()
        compose.waitUntil(10_000) { fixture.posts().any { it.path == "/api/owner-requests/$id/reopen-project" } }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("$tag:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(node("outcome").fetchSemanticsNode().config.toString().contains("Reopened"))
        compose.onAllNodesWithTag("$tag:primary", useUnmergedTree = true).assertCountEquals(0)
        assertEquals(1, fixture.posts().size)
    }

    @Test fun chatAboutThisInAConversationHandsTheTalkToTheComposerAndAnswersNothing() {
        show()
        node("chat").performClick()
        assertTrue(discussed!!.contains(id))
        assertTrue(fixture.posts().isEmpty())
    }

    @Test fun onTheProjectPageChatOpensTheDeclineFormAndDeclineSendsTheReason() {
        show(onProjectPage = true)
        node("row-label").assertTextEquals("An agent asked to reopen this project")
        node("askers").assertTextEquals("Asked by Fix share sheet colours · Also asked by Audit dark mode")
        node("chat").performClick()
        node("decline-send").assertIsNotEnabled()
        node("reason").performTextInput("Not this quarter")
        node("decline-send").performClick()
        compose.waitUntil(10_000) { fixture.posts().any { it.path == "/api/owner-requests/$id/decline" } }
        assertTrue(fixture.posts().last().body.contains("Not this quarter"))
    }
}
