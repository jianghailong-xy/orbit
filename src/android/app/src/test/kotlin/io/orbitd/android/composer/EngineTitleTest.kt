package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/** A07-13 (iOS 0557592f8): the model menu opens on the engine the session runs on — the CLI's product name, `Claude Code` for a
 * DeepSeek key it writes through — where it used to say "Current: <provider slug> · <model>". */
class EngineTitleTest : ComposerShellTest() {
    @Test fun theMenuIsTitledByTheCliThatRunsTheSession() {
        ComposerShell.providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]"""
        ComposerShell.session = mapOf("provider" to JsonPrimitive("deepseek"), "model" to JsonPrimitive("deepseek-chat"))
        signIn(); openSession(); openModelMenu()
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("Claude Code")
        assertEquals("the engine leads what the menu offers", listOf("Model and account", "Claude Code"), dialogLines().take(2))
        assertTrue(dialogLines().none { it.startsWith("Current:") })
    }

    @Test fun aCodexSessionSaysCodex() {
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex"), "model" to JsonPrimitive("gpt-6"))
        signIn(); openSession(); openModelMenu()
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("Codex")
    }
}
