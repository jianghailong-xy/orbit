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

/** A provider write's card as the conversation draws it (iOS `ToolApprovalCard`'s provider branch, web `ProviderWriteBody`): the real
 * card, its doors pressed. The pictures go to src/android/build/evidence/native-provider-write-card. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ProviderWriteCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val update = buildJsonObject {
        put("slug", "ollama-hpc-responses")
        putJsonArray("models") {
            addJsonObject { put("label", "Qwen3.8 27B (Ollama, 64K)"); put("value", "qwen3.8:27b"); put("contextWindow", 65536) }
            addJsonObject { put("label", "Qwen3 Coder 30B (Ollama, 64K)"); put("value", "qwen3-coder:30b"); put("contextWindow", 65536) }
        }
        put("defaultModel", "qwen3.8:27b")
    }
    private val create = buildJsonObject {
        put("label", "Local vLLM"); put("runtime", "codex"); put("baseUrl", "http://127.0.0.1:8000/v1"); put("apiKey", "(set — not shown)")
        putJsonArray("models") { addJsonObject { put("label", "Qwen3.8 27B"); put("value", "qwen3.8:27b"); put("contextWindow", 65536) } }
        put("defaultModel", "qwen3.8:27b")
    }
    private fun card(tool: String, input: JsonObject) = InteractionCard("approval:p1", approvalFamily(tool), ProviderWriteCards.title(tool),
        buildJsonObject { put("id", "p1"); put("toolName", tool); put("input", input); put("status", "PENDING") }, "s1", objectId = "p1",
        binding = input.toString(), actions = listOf(ProviderWriteCards.verb(tool), CardVerb.DENY), status = "PENDING")

    private fun show(card: InteractionCard, submit: (CardVerb, CardInput) -> Unit = { _, _ -> }) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme { Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) { BusinessCard(card, fresh = true, open = {}, submit = submit) }
        } } } }
        compose.waitForIdle()
    }
    private fun says(words: String) = compose.onNodeWithText(words, substring = true, useUnmergedTree = true).assertExists()
    private fun never(words: String) = compose.onNodeWithText(words, substring = true, useUnmergedTree = true).assertDoesNotExist()

    @Test fun aChangeReadsAsItsFieldsAndModelsNotAsJson() {
        val pressed = mutableListOf<CardVerb>()
        show(card(ProviderWriteCards.updateTool, update)) { verb, _ -> pressed += verb }
        says("Change this provider?")
        says("ollama-hpc-responses")
        says("Default model")
        says(ProviderWriteCards.modelsReplace)
        says("Qwen3 Coder 30B (Ollama, 64K) · 64K context")
        says(ProviderWriteCards.changeNote)
        never("Tool parameters")
        never("\"slug\"")
        never("Base URL")
        shot("change")
        compose.onNodeWithTag("approval:p1:SAVE_CHANGES").assertTextEquals("Save changes").performClick()
        compose.waitForIdle()
        assertEquals(listOf(CardVerb.SAVE_CHANGES), pressed)
    }

    @Test fun anAddNamesItsProtocolAndHidesTheKey() {
        show(card(ProviderWriteCards.createTool, create))
        says("Add this provider?")
        says("Local vLLM")
        says("OpenAI Responses (codex)")
        says(ProviderWriteCards.keySet)
        never("(set — not shown)")
        compose.onNodeWithTag("approval:p1:ADD_PROVIDER").assertTextEquals("Add it")
        shot("add")
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/native-provider-write-card").also { it.mkdirs() }
    }

    /** The screen as a PNG, never a blank one. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
