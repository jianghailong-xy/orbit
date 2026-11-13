package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The card, the bar and a result line as drawn: actions only with the runner's capability, the bar's one button, a line's link. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class MainCheckoutViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val fixture by lazy {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/main-checkout-git.fixture.json") }.first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }

    /** Answers the workspace read and records what the model sent. */
    private class Fake(val workspace: JsonObject) : MainCheckoutTransport {
        val sent = mutableListOf<Pair<List<String>, JsonObject?>>()
        override suspend fun get(path: List<String>, query: List<Pair<String, String>>): JsonElement = workspace
        override suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject?): JsonElement? { sent += path to body; return null }
    }

    private fun model(actions: Boolean, repoHealth: JsonObject = fixture["heartbeatRepo"]!!.jsonObject): Pair<MainCheckoutModel, Fake> {
        val workspace = buildJsonObject {
            put("id", "ws-1"); put("mainCheckoutActions", actions); put("repoHealth", repoHealth)
        }
        val fake = Fake(workspace)
        return MainCheckoutModel(fake, "sess-1", CoroutineScope(Dispatchers.Unconfined)).also { it.bind("ws-1"); it.adoptWorkspace(workspace) } to fake
    }

    private fun show(model: MainCheckoutModel, results: List<Pair<Long, MainCheckout.Result>> = emptyList(),
        content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread {
            compose.activity.setContent {
                MaterialTheme { CompositionLocalProvider(LocalMainCheckout provides model, LocalMainCheckoutResults provides results) { content() } }
            }
        }
        compose.waitForIdle()
    }

    private fun fixtureResult(name: String) =
        MainCheckout.result(fixture["results"]!!.jsonArray.map { it.jsonObject }.first { it["name"]!!.jsonPrimitive.content == name }["result"]!!.jsonObject)!!

    private fun assertCardActions(enabled: Boolean) {
        listOf(compose.onNodeWithText("Move to this worktree"), compose.onNodeWithText("Review and commit to main…"),
            compose.onNodeWithContentDescription("More actions")).forEach { if (enabled) it.assertIsEnabled() else it.assertIsNotEnabled() }
    }

    @Test fun aMoveAfterTheCardThatTookItsFilesHoldsItsActions() {
        val (model, fake) = model(actions = true)
        show(model, listOf(4L to fixtureResult("move done"))) { MainCheckoutCard(notice, "event:3", 3L) }
        assertCardActions(enabled = false)
        compose.onNodeWithTag("main-checkout-card-handled").assertTextEquals("Handled — see the result below")
        compose.onNodeWithText("Move to this worktree").performClick()
        compose.waitForIdle()
        assertTrue(fake.sent.isEmpty())
        // History: the title and files stay.
        compose.onNodeWithText("3 files changed in the main checkout during this turn").assertExists()
        compose.onNodeWithText("src/api/client.ts").assertExists()
    }

    @Test fun aCheckoutWithoutItsPathsSaysTheyAreGone() {
        val clean = buildJsonObject { put("root", "/root/orbit"); put("state", "clean"); put("branch", "main"); put("fileCount", 0) }
        val (model, _) = model(actions = true, repoHealth = clean)
        show(model) { MainCheckoutCard(notice, "event:3", 3L, writtenAt = java.time.Instant.now().minusSeconds(600).toString()) }
        assertCardActions(enabled = false)
        compose.onNodeWithTag("main-checkout-card-handled").assertTextEquals("These changes are no longer in the main checkout")
    }

    @Test fun aCleanHeartbeatRightAfterTheCardIsTheCheckoutFromBeforeTheTurn() {
        val clean = buildJsonObject { put("root", "/root/orbit"); put("state", "clean"); put("branch", "main"); put("fileCount", 0) }
        val (model, _) = model(actions = true, repoHealth = clean)
        show(model) { MainCheckoutCard(notice, "event:3", 3L, writtenAt = java.time.Instant.now().toString()) }
        assertCardActions(enabled = true)
        compose.onNodeWithTag("main-checkout-card-handled").assertDoesNotExist()
    }

    @Test fun aRefusalOrAResultBeforeTheCardLeavesItLive() {
        val (model, _) = model(actions = true)
        show(model, listOf(4L to fixtureResult("MOVE_CONFLICT"), 2L to fixtureResult("move done"))) { MainCheckoutCard(notice, "event:3", 3L) }
        assertCardActions(enabled = true)
        compose.onNodeWithTag("main-checkout-card-handled").assertDoesNotExist()
    }

    private val notice get() = MainCheckout.changedNotice(fixture["changedNotice"]!!.jsonObject)!!

    @Test fun theCardOffersMoveReviewAndMoreWithTheCapability() {
        val (model, fake) = model(actions = true)
        show(model) { MainCheckoutCard(notice, "event:3") }
        compose.onNodeWithText("3 files changed in the main checkout during this turn").assertExists()
        compose.onNodeWithText("src/api/client.ts").assertExists()
        compose.onNodeWithText("Review and commit to main…").assertExists()
        compose.onNodeWithText("Move to this worktree").performClick()
        compose.waitForIdle()
        val (path, body) = fake.sent.single()
        assertEquals(listOf("workspaces", "ws-1", "main-checkout", "actions"), path)
        assertEquals("move", body!!["kind"]!!.jsonPrimitive.content)
        assertEquals(notice.fingerprint, body["fingerprint"]!!.jsonPrimitive.content)
        assertEquals(listOf("src/api/client.ts", "src/api/retry.test.ts", "src/api/retry.ts"), body["files"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("sess-1", body["targetSessionId"]!!.jsonPrimitive.content)
        assertEquals("sess-1", body["initiatedFromSessionId"]!!.jsonPrimitive.content)
    }

    @Test fun withoutTheCapabilityTheCardIsItsTextAlone() {
        val (model, _) = model(actions = false)
        show(model) { MainCheckoutCard(notice, "event:3") }
        compose.onNodeWithText("3 files changed in the main checkout during this turn").assertExists()
        compose.onNodeWithText("Move to this worktree").assertDoesNotExist()
        compose.onNodeWithText("Review and commit to main…").assertDoesNotExist()
        compose.onNodeWithContentDescription("More actions").assertDoesNotExist()
    }

    @Test fun theBarSaysTheCountsAndOffersReviewOnlyWithTheCapability() {
        val (on, _) = model(actions = true)
        show(on) { MainCheckoutBar(on, "ws-1", isolated = true) }
        compose.onNodeWithTag("main-checkout-bar").assertExists()
        compose.onNodeWithText("7 uncommitted files · 1 commit not pushed").assertExists()
        compose.onNodeWithText("Review").assertExists()
        val (off, _) = model(actions = false)
        show(off) { MainCheckoutBar(off, "ws-1", isolated = true) }
        compose.onNodeWithText("7 uncommitted files · 1 commit not pushed").assertExists()
        compose.onNodeWithText("Review").assertDoesNotExist()
    }

    @Test fun aRefusalLineSaysItsSentenceWithItsLink() {
        val (model, _) = model(actions = true)
        val case = fixture["results"]!!.jsonArray.map { it.jsonObject }.first { it["name"]!!.jsonPrimitive.content == "PUSH_REJECTED" }
        show(model) { MainCheckoutResultRow(MainCheckout.result(case["result"]!!.jsonObject)!!) }
        compose.onNodeWithTag("main-checkout-result").assertExists()
        // The sentence, then its link, as one text.
        compose.onNodeWithText(case["text"]!!.jsonPrimitive.content + "  Ask the agent to rebase and push").assertExists()
    }
}
