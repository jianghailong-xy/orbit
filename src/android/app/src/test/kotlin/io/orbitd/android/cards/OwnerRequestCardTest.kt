package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerRequestsApi
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
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
 * The owner request card as the conversation that asked draws it (web `OwnerRequestCard`): each kind's fields and buttons, its doors
 * on the real wire — the card turning into its one resolved line — the key's field, which is a password field whose value is never
 * saved and is gone once submitted, Remind me later folding the card, and a request's link (`orbit://owner-request/<id>`, its push's
 * action) opening that conversation on the card with its input focused.
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
    @Composable private fun Conversation(only: String? = null, session: String? = null) {
        val state by store.state.collectAsState()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            OwnerRequests.forSession(OwnerRequestFixture.SESSION, state.list(OwnerRequestStore.ALL), state.open)
                .filter { only == null || it.id == only }
                .forEach { OwnerRequestInConversation(it, store, { "mac-mini" }, {}, session) }
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

    @Test fun remindMeLaterFoldsTheCard() {
        val id = OwnerRequestFixture.CONFIRM_ID
        show(id)
        tag(id, "later").performClick()
        compose.onNodeWithTag("owner-request:$id:later:In 1 hour").performClick()
        compose.waitForIdle()
        tag(id, "snoozed").assertExists()
        compose.onAllNodesWithTag("owner-request:$id:primary", useUnmergedTree = true).assertCountEquals(0)
        tag(id, "show-now").performClick()
        compose.waitForIdle()
        tag(id, "primary").assertExists()
        assertTrue(fixture.posts().isEmpty())
    }

    /** A request's link reads the request, asks for its card in the conversation that asked, and opens that conversation: there the
     * card is drawn whole with its input focused, and the ask is spent. The other requests stay as they are. */
    @Test fun aRequestsLinkOpensTheConversationThatAskedOnItsCardWithItsInputFocused() {
        val api = OwnerRequestsApi(fixture.auth, store.handle)
        val link = "orbit://owner-request/${ObjectId.toPublic(OwnerRequestFixture.SECRET_ID)}"
        val id = OrbitLinks.ownerRequest(link)!!
        assertEquals(OwnerRequestFixture.SECRET_ID, id)
        val route = runBlocking { OwnerRequestLinks.open(id) { api.get(it) } }!!
        assertEquals(Destination.SESSION, route.destination)
        assertEquals(OwnerRequestFixture.SESSION, route.id)
        assertEquals(CardFocus.ownerRequest(OwnerRequestFixture.SECRET_ID), CardFocus.pending(OwnerRequestFixture.SESSION))
        assertTrue(fixture.calls.any { it.method == "GET" && it.path == "/api/owner-requests/$id" })
        compose.setContent { OrbitTheme(darkTheme = false) { Conversation(session = route.id) } }
        compose.waitUntil(5_000) { runCatching { tag(OwnerRequestFixture.SECRET_ID, "secret").assertIsFocused() }.isSuccess }
        assertNull("spent once the card is drawn", CardFocus.pending(OwnerRequestFixture.SESSION))
        tag(OwnerRequestFixture.STEPS_ID, "primary").assertExists()
        assertTrue(fixture.posts().isEmpty())
    }

    /** A request put off for later that a link names is shown whole: the owner asked for it. */
    @Test fun aLinkedRequestPutOffForLaterIsShownWhole() {
        val id = OwnerRequestFixture.CONFIRM_ID
        val snoozes = OwnerRequestSnoozes.of(RuntimeEnvironment.getApplication())
        snoozes.snooze(id, System.currentTimeMillis() + 3_600_000)
        val api = OwnerRequestsApi(fixture.auth, store.handle)
        val route = runBlocking { OwnerRequestLinks.open(id) { api.get(it) } }!!
        compose.setContent { OrbitTheme(darkTheme = false) { Conversation(id, session = route.id) } }
        compose.waitForIdle()
        tag(id, "primary").assertExists()
        assertEquals(0L, snoozes.until(id))
    }

    /** A request that cannot be read opens nothing and asks for no card. */
    @Test fun aRequestThatCannotBeReadOpensNothing() {
        val api = OwnerRequestsApi(fixture.auth, store.handle)
        CardFocus.spend(OwnerRequestFixture.SESSION)
        assertNull(runBlocking { OwnerRequestLinks.open("01a0d6a9-d763-70e1-b4cf-8793e971b5ff") { api.get(it) } })
        assertNull(CardFocus.pending(OwnerRequestFixture.SESSION))
    }
}
