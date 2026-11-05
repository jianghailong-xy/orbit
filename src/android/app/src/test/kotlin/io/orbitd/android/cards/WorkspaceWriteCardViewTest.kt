package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A workspace write's card as the conversation draws it (iOS `ToolApprovalCard`'s write branch, web `WorkspaceWriteBody`): the real
 * card, its doors pressed. The pictures of each card go to src/android/build/evidence/native-workspace-write-card. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WorkspaceWriteCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val longValue = "sk-demo-" + "4f8a1c2e9b7d4a6f".repeat(12)

    private val update = buildJsonObject {
        put("agentId", "w1"); put("name", "nightly-build"); put("workDir", "/srv/build")
        putJsonObject("runner") { put("id", "r1"); put("name", "instance-1"); put("displayName", "Build box") }
        putJsonArray("envRemoved") { add("OLD_TOKEN") }
        put("writeSalt", "salt"); put("writeDigest", "digest")
        putJsonObject("changes") {
            putJsonObject("env") { put("REGION", "eu-west-1"); put("API_KEY", longValue) }
            put("workDir", "/srv/other"); put("appendSystemPrompt", "Answer in French, and keep it brief.")
            putJsonObject("runner") { put("id", "r2"); put("name", "gpu-2"); put("displayName", JsonNull) }
            put("enableWorktree", true)
        }
    }
    private val create = buildJsonObject {
        put("agentId", JsonNull); put("name", "one-off-deploy"); put("workDir", JsonNull)
        putJsonObject("runner") { put("id", "r1"); put("name", "hpc"); put("displayName", JsonNull) }
        putJsonArray("envRemoved") { }
        putJsonObject("changes") {
            put("name", "one-off-deploy")
            putJsonObject("env") { put("FCM_KEY", "k-1"); }
            put("workDir", "/srv/one-off")
        }
    }
    private fun card(tool: String, input: JsonObject): InteractionCard {
        val yes = if (tool == WorkspaceWriteCards.createTool) CardVerb.CREATE_WORKSPACE else CardVerb.SAVE_CHANGES
        return InteractionCard("approval:d1", approvalFamily(tool), WorkspaceWriteCards.title(tool),
            buildJsonObject { put("id", "d1"); put("toolName", tool); put("input", input); put("status", "PENDING") }, "s1", objectId = "d1",
            binding = input.toString(), actions = listOf(yes, CardVerb.CHAT), status = "PENDING")
    }

    private fun show(card: InteractionCard, dark: Boolean = false, submit: (CardVerb, CardInput) -> Unit = { _, _ -> }) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) { BusinessCard(card, fresh = true, open = {}, submit = submit) }
        } } } }
        compose.waitForIdle()
    }
    private fun says(words: String) = compose.onNodeWithText(words, useUnmergedTree = true).assertExists()
    private fun never(words: String) = compose.onNodeWithText(words, useUnmergedTree = true).assertDoesNotExist()

    @Test fun aChangeNamesTheWorkspaceEachVariableWholeAndWhatElseChanges() {
        val pressed = mutableListOf<CardVerb>()
        show(card(WorkspaceWriteCards.updateTool, update)) { verb, _ -> pressed += verb }
        says("Change this workspace?")
        says("nightly-build")
        says("On Build box")
        says("/srv/build")
        says(WorkspaceWriteCards.variables)
        says("API_KEY=$longValue")
        says("REGION=eu-west-1")
        says(WorkspaceWriteCards.removed)
        says("OLD_TOKEN")
        says("Working directory"); says("/srv/other")
        says("Appended system prompt"); says("Answer in French, and keep it brief.")
        says("Runner"); says("gpu-2")
        says("Worktree"); says("Each session gets its own git worktree")
        says(WorkspaceWriteCards.note)
        never("orbit_agent_update")
        never("digest")
        compose.onNodeWithTag("approval:d1:REMEMBER").assertDoesNotExist()
        compose.onNodeWithTag("approval:d1:SAVE_CHANGES").assertTextEquals("Save changes").performClick()
        compose.waitForIdle()
        assertEquals("the card is the confirmation: no second dialog", listOf(CardVerb.SAVE_CHANGES), pressed)
    }

    @Test fun aCreateReadsAsACreate() {
        show(card(WorkspaceWriteCards.createTool, create))
        says("Create this workspace?")
        says("one-off-deploy")
        says("On hpc")
        says("FCM_KEY=k-1")
        says("/srv/one-off")
        compose.onNodeWithTag("approval:d1:CREATE_WORKSPACE").assertTextEquals("Create it")
    }

    @Test fun aWriteThatClearsSaysSo() {
        show(card(WorkspaceWriteCards.updateTool, buildJsonObject {
            put("name", "w")
            putJsonObject("changes") { putJsonObject("env") { }; put("systemPrompt", "") }
        }))
        says(WorkspaceWriteCards.noVariables)
        says("Cleared")
    }

    @Test fun aCardAServerThatPredatesItFiledShowsAllItHolds() {
        show(card(WorkspaceWriteCards.updateTool, buildJsonObject {
            put("agentId", "w1"); putJsonObject("env") { put("API_KEY", "sk-1") }; put("workDir", "/srv/other")
        }))
        says("Change this workspace?")
        compose.onNodeWithText("API_KEY", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("sk-1", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("/srv/other", substring = true, useUnmergedTree = true).assertExists()
    }

    @Test fun sayingNoAsksWhatToDoInsteadAndSendsTheReason() {
        val pressed = mutableListOf<Pair<CardVerb, String>>()
        show(card(WorkspaceWriteCards.updateTool, update)) { verb, input -> pressed += verb to input.text }
        compose.onNodeWithTag("approval:d1:CHAT").assertTextEquals("Chat about this").performClick()
        compose.waitForIdle()
        assertEquals("the first press only opens the reason", emptyList<Pair<CardVerb, String>>(), pressed)
        compose.onNode(hasSetTextAction()).performTextInput("Not that key")
        compose.onNodeWithTag("approval:d1:CHAT").performClick()
        compose.waitForIdle()
        assertEquals(listOf(CardVerb.CHAT to "Not that key"), pressed)
    }

    @Test fun theCardsAsTheyLook() {
        listOf(false, true).forEach { dark ->
            val theme = if (dark) "dark" else "light"
            show(card(WorkspaceWriteCards.updateTool, update), dark); shot("change-$theme")
            show(card(WorkspaceWriteCards.createTool, create), dark); shot("create-$theme")
        }
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/native-workspace-write-card").also { it.mkdirs() }
    }

    /** The screen as a PNG, never a blank one. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
