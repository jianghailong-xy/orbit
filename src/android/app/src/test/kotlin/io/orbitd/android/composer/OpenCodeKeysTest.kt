package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-6 (iOS 09dc74803): an OpenCode session can run on a configured provider key — each key the server marks `runsOnOpenCode`
 * is listed again under OpenCode, its models as `orbit-<slug>/<model>`, and a new session on it starts on `opencode` with that
 * model. */
class OpenCodeKeysTest : ComposerShellTest() {
    private fun openCodeRunner() {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"},
              {"engine":"opencode","installed":true}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"opencode":[{"value":"opencode/big-pickle","label":"Big Pickle"}]}}""")
        ComposerShell.providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","runsOnOpenCode":true,
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]},
            {"slug":"moonshot","label":"Moonshot","runtime":"kimi","presetSlug":"moonshot","runsOnOpenCode":false,
            "models":[{"value":"kimi-k3","label":"Kimi K3"}]}]"""
    }

    /** The Provider rows, Antigravity's aside (its row depends on the runner's Gemini credential, not on these keys). */
    private fun providerRows() = section("Provider", until = setOf("Account", "Close")).filterNot { "Antigravity" in it }

    @Test fun aKeyIsListedUnderOpenCodeAndANewSessionStartsOnItsModel() {
        openCodeRunner()
        signIn(); openDraft(); openModelMenu()
        assertEquals("the key under its own engine, and again under OpenCode; a key OpenCode can't spend is not",
            listOf("✓ Claude", "Codex", "Kimi", "DeepSeek", "Moonshot", "OpenCode", "DeepSeek"), providerRows())
        compose.onAllNodes(hasText("DeepSeek") and hasClickAction() and hasAnyAncestor(isDialog()))[1].performScrollTo().performClick()
        await { providerRows().lastOrNull() == "✓ DeepSeek" }
        assertTrue("the menu lists the key's models, the new session on its first", shows("✓ DeepSeek Chat"))
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithTag("composer-input").performTextInput("Review the diff")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        val created = ComposerShell.body("POST sessions")!!
        assertEquals("opencode", created["provider"]?.jsonPrimitive?.content)
        assertEquals("orbit-deepseek/deepseek-chat", created["model"]?.jsonPrimitive?.content)
    }

    @Test fun anOpenCodeSessionOnAKeyMovesBetweenItsConfigAndItsKeysByModel() {
        openCodeRunner()
        ComposerShell.session = mapOf("provider" to JsonPrimitive("opencode"), "model" to JsonPrimitive("orbit-deepseek/deepseek-chat"))
        signIn(); openSession(); openModelMenu()
        assertEquals(listOf("OpenCode", "✓ DeepSeek"), providerRows())
        compose.onNode(hasText("OpenCode") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals("a model change, the provider untouched", buildJsonObject { put("model", "opencode/big-pickle") },
            ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config"))
    }
}
