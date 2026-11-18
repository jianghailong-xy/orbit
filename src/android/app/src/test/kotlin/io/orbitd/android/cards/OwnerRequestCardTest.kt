package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.ui.OrbitTheme
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
 * The owner request card as a conversation and the inbox draw it (web `OwnerRequestCard`): each kind's fields and buttons, its doors
 * on the real wire — the card turning into its one resolved line — the key's field, which is a password field whose value is never
 * saved and is gone once submitted, Remind me later folding the card, and the inbox opening a push's request with its input focused.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class OwnerRequestCardTest {
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

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.secret(), OwnerRequestFixture.steps(), OwnerRequestFixture.decision(), OwnerRequestFixture.confirm())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 4 && store.state.value.open.size == 4 }
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    /** The conversation that asked: its requests in the order they were filed, each whole, folded or as its line. */
    @Composable private fun Conversation(only: String? = null) {
        val state by store.state.collectAsState()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            OwnerRequests.forSession(OwnerRequestFixture.SESSION, state.list(OwnerRequestStore.ALL), state.open)
                .filter { only == null || it.id == only }
                .forEach { OwnerRequestInConversation(it, store, { "mac-mini" }, {}) }
        }
    }
    private var only by mutableStateOf<String?>(null)
    private var drawn = false
    private fun show(id: String) {
        only = id
        if (!drawn) { drawn = true; compose.setContent { OrbitTheme(darkTheme = false) { Conversation(only) } } }
        compose.waitForIdle()
    }
    private fun tag(id: String, part: String) = compose.onNodeWithTag("owner-request:$id:$part", useUnmergedTree = true)
    private fun text(value: String) = compose.onNodeWithText(value, useUnmergedTree = true)
    private fun posted(path: String) = compose.waitUntil(10_000) { fixture.posts().any { it.path == path } }

    @Test fun theSecretCardSaysWhereTheKeyGoesAndOffersItsDoors() {
        val id = OwnerRequestFixture.SECRET_ID
        show(id)
        text(OwnerRequests.waitingOnYou).assertExists()
        assertTrue(tag(id, "asked").fetchSemanticsNode().config[SemanticsProperties.Text].first().text.startsWith("Asked 2m ago · expires in 3d"))
        tag(id, "title").assertTextEquals("Staging Stripe key")
        tag(id, "kind").assertTextEquals("SECRET")
        text("The payment tests call Stripe's test API and need a restricted key.", ).assertExists()
        text("Runner mac-mini as STRIPE_API_KEY").assertExists()
        text("When the task ends, or after 7 days").assertExists()
        tag(id, "notice").assertTextEquals("Goes straight to mac-mini. Orbit keeps it out of this conversation and away from the agent; only commands " +
            "the agent runs with it can use it. Use a key you can revoke.")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Ship the login page", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        text("Provide key").assertExists()
        tag(id, "primary").assertIsNotEnabled()
        text("Decline…").assertExists()
        text("Remind me later").assertExists()
        tag(id, "if-unanswered").assertTextEquals("If nobody answers: The session keeps the task blocked and asks again tomorrow.")
        // Saving the key to the account is the owner's choice, never the default.
        tag(id, "save").assertIsOff()
        compose.onAllNodesWithTag("owner-request:$id:save-as", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theStepsAndDecisionAndConfirmCardsDrawTheirKinds() {
        show(OwnerRequestFixture.STEPS_ID)
        tag(OwnerRequestFixture.STEPS_ID, "kind").assertTextEquals("STEPS")
        tag(OwnerRequestFixture.STEPS_ID, "step:0").assertTextEquals("Open the Cloud console's API library")
        tag(OwnerRequestFixture.STEPS_ID, "step:2").assertTextEquals("Check it from a terminal")
        text("gcloud services list --enabled | grep billing").assertExists()
        text("Copy").assertExists()
        text("Mark done").assertExists(); tag(OwnerRequestFixture.STEPS_ID, "primary").assertIsEnabled()
        text("Can’t do this…").assertExists()

        show(OwnerRequestFixture.DECISION_ID)
        tag(OwnerRequestFixture.DECISION_ID, "kind").assertTextEquals("DECISION")
        text("Singapore").assertExists(); text("Hong Kong").assertExists(); text("Recommended").assertExists()
        tag(OwnerRequestFixture.DECISION_ID, "option:0").assertIsSelected()
        text("Send answer").assertExists(); tag(OwnerRequestFixture.DECISION_ID, "primary").assertIsEnabled()
        text("Decline…").assertExists()

        show(OwnerRequestFixture.CONFIRM_ID)
        tag(OwnerRequestFixture.CONFIRM_ID, "kind").assertTextEquals("CONFIRM")
        text("Confirm").assertExists(); tag(OwnerRequestFixture.CONFIRM_ID, "primary").assertIsEnabled()
    }

    @Test fun markDonePostsItsDoorAndTheCardBecomesItsResolvedLine() {
        val id = OwnerRequestFixture.STEPS_ID
        show(id)
        tag(id, "primary").performClick()
        posted("/api/owner-requests/$id/done")
        assertEquals("{}", fixture.posts().single().body)
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:resolved", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag(id, "resolved-title").assertTextEquals("Enable the billing API")
        tag(id, "outcome").assertTextEquals("Marked done")
        assertTrue(tag(id, "by").fetchSemanticsNode().config[SemanticsProperties.Text].first().text.startsWith("by you · "))
        compose.onAllNodesWithTag("owner-request:$id:primary", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun anAnswerSendsTheOptionAndTheWords() {
        val id = OwnerRequestFixture.DECISION_ID
        show(id)
        tag(id, "option:1").performClick()
        tag(id, "answer").performTextInput("Hong Kong has the lower latency.")
        tag(id, "primary").performClick()
        posted("/api/owner-requests/$id/done")
        assertEquals(buildJsonObject { put("option", 1); put("text", "Hong Kong has the lower latency.") },
            Json.parseToJsonElement(fixture.posts().single().body))
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag(id, "outcome").assertTextEquals("Hong Kong: “Hong Kong has the lower latency.”")
    }

    @Test fun declineAsksWhyAndPostsTheReason() {
        val id = OwnerRequestFixture.CONFIRM_ID
        show(id)
        tag(id, "decline").performClick()
        tag(id, "decline-send").assertIsNotEnabled()
        tag(id, "reason").performTextInput("The records are not ready yet")
        tag(id, "decline-send").performClick()
        posted("/api/owner-requests/$id/decline")
        assertEquals(buildJsonObject { put("reason", "The records are not ready yet") }, Json.parseToJsonElement(fixture.posts().single().body))
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag(id, "outcome").assertTextEquals("Declined: “The records are not ready yet”")
    }

    @Test fun theKeyIsAPasswordFieldClearedOnSubmitAndSentOnce() {
        val id = OwnerRequestFixture.SECRET_ID
        show(id)
        val field = tag(id, "secret")
        field.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
        field.performTextInput("sk_test_51Hb")
        // Masked on screen: the value is never drawn as itself.
        assertEquals("•".repeat(12), field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        // A refused key: the field is empty again, and what the server said is shown — without the key.
        fixture.refuseSecret = "the key may be at most 16384 characters"
        tag(id, "primary").performClick()
        posted("/api/owner-requests/$id/secret")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:error", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(buildJsonObject { put("value", "sk_test_51Hb") }, Json.parseToJsonElement(fixture.posts().single().body))
        assertEquals("", tag(id, "secret").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        tag(id, "primary").assertIsNotEnabled()
        tag(id, "error").assertTextEquals("That was not recorded: the key may be at most 16384 characters")
        // Taken: the key is on its way, and the field is gone with it.
        fixture.refuseSecret = null
        tag(id, "secret").performTextInput("sk_test_51Hc")
        tag(id, "primary").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:on-its-way", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag(id, "on-its-way").assertTextEquals("Key is on its way to mac-mini.")
        compose.onAllNodesWithTag("owner-request:$id:secret", useUnmergedTree = true).assertCountEquals(0)
        text("Cancel").assertExists()
        // No other read or write carried it.
        assertEquals(2, fixture.calls.count { it.body.contains("sk_test_51H") })
    }

    @Test fun theKeyIsNeverInSavedState() {
        val id = OwnerRequestFixture.SECRET_ID
        val restoration = StateRestorationTester(compose)
        restoration.setContent { OrbitTheme(darkTheme = false) { Conversation(id) } }
        tag(id, "secret").performTextInput("sk_live_never_saved")
        restoration.emulateSavedInstanceStateRestore()
        compose.waitForIdle()
        assertEquals("", tag(id, "secret").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
    }

    @Test fun remindMeLaterFoldsTheCardAndTakesItOutOfTheCount() {
        val id = OwnerRequestFixture.CONFIRM_ID
        show(id)
        assertEquals(4, OwnerRequests.waitingCount(store.state.value.open, OwnerRequestSnoozes.of(RuntimeEnvironment.getApplication()).state.value,
            java.time.Instant.now()))
        tag(id, "later").performClick()
        compose.onNodeWithTag("owner-request:$id:later:In 1 hour").performClick()
        compose.waitForIdle()
        tag(id, "snoozed").assertExists()
        compose.onAllNodesWithTag("owner-request:$id:primary", useUnmergedTree = true).assertCountEquals(0)
        val snoozes = OwnerRequestSnoozes.of(RuntimeEnvironment.getApplication())
        assertEquals(3, OwnerRequests.waitingCount(store.state.value.open, snoozes.state.value, java.time.Instant.now()))
        tag(id, "show-now").performClick()
        compose.waitForIdle()
        tag(id, "primary").assertExists()
        assertEquals(4, OwnerRequests.waitingCount(store.state.value.open, snoozes.state.value, java.time.Instant.now()))
        assertTrue(fixture.posts().isEmpty())
    }

    /** A push's action (`orbit://owner-request/<id>`) opens the inbox with that request's card open and its input focused. */
    @Test fun theInboxOpensThePushedRequestOnItsInput() {
        compose.setContent { OrbitTheme(darkTheme = false) { WaitingOnYouScreen(store, emptyList(), OwnerRequestFixture.SECRET_ID, 0, {}) } }
        compose.waitForIdle()
        compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("4")
        compose.onNodeWithTag("waiting-on-you:row:${OwnerRequestFixture.SECRET_ID}:action").assertTextContains("Close")
        compose.onNodeWithTag("waiting-on-you:row:${OwnerRequestFixture.STEPS_ID}:action").assertTextContains("Open steps")
        compose.onNodeWithTag("waiting-on-you:row:${OwnerRequestFixture.STEPS_ID}:detail", useUnmergedTree = true).assertTextEquals("3 steps · holds 1 task")
        compose.onAllNodesWithTag("owner-request:${OwnerRequestFixture.STEPS_ID}", useUnmergedTree = true).assertCountEquals(0)
        compose.waitUntil(5_000) { runCatching { tag(OwnerRequestFixture.SECRET_ID, "secret").assertIsFocused() }.isSuccess }
    }

    /** The Open tab holds the coordinators' questions beside the requests, newest first, and the header counts both as one. */
    @Test fun theInboxListsCoordinatorQuestionsBesideTheRequestsAndCountsThemAsOne() {
        fixture.projects = buildJsonArray { add(OwnerRequestFixture.questionProject(20)) }
        fixture.openItems[OwnerRequestFixture.PROJECT] = OwnerRequestFixture.questionItems(20)
        OwnerRequestSnoozes.of(RuntimeEnvironment.getApplication()).snooze(OwnerRequestFixture.SECRET_ID, System.currentTimeMillis() + 3_600_000)
        val answered = mutableListOf<OwnerRequests.CoordinatorQuestionRow>()
        compose.setContent { OrbitTheme(darkTheme = false) { WaitingOnYouScreen(store, emptyList(), null, 0, {}) { answered += it } } }
        val question = "waiting-on-you:row:question:${OwnerRequestFixture.QUESTION_ITEM}"
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(question, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        // Four requests, one put off for later, and one question.
        compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("4")
        compose.onNodeWithTag("$question:title", useUnmergedTree = true).assertTextEquals("Should the canary go to 5% or 20% of traffic?")
        compose.onNodeWithTag("$question:detail", useUnmergedTree = true).assertTextEquals("Payments rollout · decision · recommended: 5%")
        compose.onNodeWithTag("$question:age", useUnmergedTree = true).assertTextEquals("20m ago")
        // Newest first: the secret (2m), the steps (14m), the question (20m), the decision (30m), the confirmation (45m).
        val order = listOf("waiting-on-you:row:${OwnerRequestFixture.SECRET_ID}", "waiting-on-you:row:${OwnerRequestFixture.STEPS_ID}", question,
            "waiting-on-you:row:${OwnerRequestFixture.DECISION_ID}", "waiting-on-you:row:${OwnerRequestFixture.CONFIRM_ID}")
        val tops = order.map { compose.onNodeWithTag(it).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(tops.sorted(), tops)
        compose.onNodeWithTag("$question:action").assertTextContains("Answer").performClick()
        assertEquals(OwnerRequestFixture.QUESTION_ITEM, answered.single().itemId)
        assertEquals(OwnerRequestFixture.PROJECT, answered.single().projectId)
    }

    /** The task a card holds up opens over the inbox, each page keeping its state by its route as the shell's holder does; Back returns
     * to the inbox with that card still open, the task's chip where it was pressed (owner, 2026-11-12). */
    @Test fun aTaskOpenedFromAnInboxCardComesBackToThatCardOpen() {
        val id = OwnerRequestFixture.STEPS_ID
        var page by mutableStateOf("inbox")
        val opened = mutableListOf<String>()
        compose.setContent {
            OrbitTheme(darkTheme = false) {
                val holder = rememberSaveableStateHolder()
                holder.SaveableStateProvider(page) {
                    if (page == "inbox") WaitingOnYouScreen(store, emptyList(), null, 0, { link -> opened += link; page = "task" })
                    else Text("The task's page")
                }
            }
        }
        compose.onNodeWithTag("waiting-on-you:row:$id:action").assertTextContains("Open steps").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Ship the login page", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Ship the login page") and hasAnyAncestor(hasTestTag("owner-request:$id:holding")), useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals(listOf("orbit-task:${OwnerRequestFixture.TASK}"), opened)
        text("The task's page").assertExists()
        compose.runOnIdle { page = "inbox" }  // Back
        compose.waitForIdle()
        compose.onNodeWithTag("waiting-on-you:row:$id:action").assertTextContains("Close")
        compose.onNode(hasText("Ship the login page") and hasAnyAncestor(hasTestTag("owner-request:$id:holding")), useUnmergedTree = true).assertExists()
    }

    @Test fun theInboxEndedTabsListResolvedLines() {
        val id = OwnerRequestFixture.STEPS_ID
        compose.setContent { OrbitTheme(darkTheme = false) { WaitingOnYouScreen(store, emptyList(), null, 0, {}) } }
        compose.onNodeWithTag("waiting-on-you:row:$id:action").performClick()
        tag(id, "primary").performClick()
        posted("/api/owner-requests/$id/done")
        compose.onNodeWithTag("waiting-on-you:tab:DONE").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:resolved", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag(id, "outcome").assertTextEquals("Marked done")
        compose.onNodeWithTag("waiting-on-you:tab:DECLINED").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("waiting-on-you:empty", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        text("Nothing has been declined.").assertExists()
    }
}
