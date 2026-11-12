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

    private fun model(actions: Boolean): Pair<MainCheckoutModel, Fake> {
        val workspace = buildJsonObject {
            put("id", "ws-1"); put("mainCheckoutActions", actions); put("repoHealth", fixture["heartbeatRepo"]!!)
        }
        val fake = Fake(workspace)
        return MainCheckoutModel(fake, "sess-1", CoroutineScope(Dispatchers.Unconfined)).also { it.bind("ws-1"); it.adoptWorkspace(workspace) } to fake
    }

    private fun show(model: MainCheckoutModel, content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { CompositionLocalProvider(LocalMainCheckout provides model) { content() } } } }
        compose.waitForIdle()
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
        compose.onNodeWithTag("main-checkout-result").assertTextContains(case["text"]!!.jsonPrimitive.content, substring = true)
        compose.onNodeWithTag("main-checkout-result").assertTextContains("Ask the agent to rebase and push", substring = true)
    }
}
