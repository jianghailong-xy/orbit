package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-6 on the provider/engine split (contract §1.3, §3.3): an OpenCode session can run on a key OpenCode runs — listed under
 * OpenCode after its own sign-in, by the key's own slug and with the key's own models — and a session on it is (opencode, the key,
 * a bare model): no `opencode/<slug>` choice, no `orbit-<slug>/<model>` id. Moving between the key and OpenCode's own config is a
 * provider change on the same engine. */
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

    /** The Provider list's rows after its heading's current credential. */
    private fun providerRows() = section("Provider", until = setOf("Close")).drop(1)

    @Test fun aKeyIsListedUnderOpenCodeAndANewSessionStartsOnItsModel() {
        openCodeRunner()
        signIn(); openDraft()
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:opencode") and hasClickAction()) }
        compose.onNodeWithTag("engine:opencode").performClick()
        await { ComposerShell.calls.none { it.startsWith("PATCH") } && has(hasText("OpenCode ⌄")) }
        openModelMenu()
        assertEquals("OpenCode's own sign-in, then the keys it runs; a key OpenCode can't spend is not there",
            listOf("On Fixture runner", "✓ OpenCode's own sign-in\nopencode auth", "API keys", "DeepSeek"), providerRows())
        compose.onNode(hasText("DeepSeek") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { providerRows().lastOrNull() == "✓ DeepSeek" }
        assertTrue("the menu lists the key's models, the new session on its first", shows("✓ DeepSeek Chat"))
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("OpenCode")
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithTag("composer-input").performTextInput("Review the diff")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        val created = ComposerShell.body("POST sessions")!!
        assertEquals("opencode", created["engine"]?.jsonPrimitive?.content)
        assertEquals("deepseek", created["provider"]?.jsonPrimitive?.content)
        assertEquals("deepseek-chat", created["model"]?.jsonPrimitive?.content)
    }

    @Test fun anOpenCodeSessionOnAKeyMovesToItsOwnConfigOnTheSameEngine() {
        openCodeRunner()
        ComposerShell.session = mapOf("engine" to JsonPrimitive("opencode"), "provider" to JsonPrimitive("deepseek"), "model" to JsonPrimitive("deepseek-chat"))
        signIn(); openSession(); openModelMenu()
        assertEquals(listOf("On Fixture runner", "OpenCode's own sign-in\nopencode auth", "API keys", "✓ DeepSeek"), providerRows())
        compose.onNode(hasText("OpenCode's own sign-in", substring = true) and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals("a provider change on the session's own engine", buildJsonObject {
            put("provider", "opencode"); put("engine", "opencode"); put("model", ""); put("effort", "")
        }, ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config"))
    }
}
