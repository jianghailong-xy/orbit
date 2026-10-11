package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import org.junit.Assert.*
import org.junit.Test

/** A07-3 on the provider/engine split: a new session's Engine list names the engines in the boards' order — Claude Code, Codex,
 * Kimi Code, Antigravity CLI, OpenCode, DeepSeek Harness — whatever order the runner reports them in, and the model menu's Provider
 * list holds only the picked engine's credentials, its own sign-in first. */
class EngineOrderTest : ComposerShellTest() {
    /** A runner reporting its engines out of order, every one installed and signed in, Antigravity on a Google account. */
    private fun scrambledRunner() {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "engines":[{"engine":"kimi","installed":true,"auth":"yes"},{"engine":"opencode","installed":true},
              {"engine":"codex","installed":true,"auth":"yes"},{"engine":"antigravity","installed":true,"auth":"yes","authSource":"google"},
              {"engine":"claude","installed":true,"auth":"yes"}],
            "antigravity":{"supported":true,"installed":true,"version":"1.2.16","envKeyAvailable":true,"authSource":"google","googleLogin":"available"},
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-6","label":"GPT-6"}]}}""")
        ComposerShell.providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]"""
    }

    /** The new session's Engine list, each row by its engine's name. */
    private fun engineRows(): List<String> {
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine-choices")) }
        val row = SemanticsMatcher("an engine's row") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("engine:") == true }
        return compose.onAllNodes(row).fetchSemanticsNodes().map { it.config[SemanticsProperties.Text].first().text }
    }

    @Test fun aNewSessionListsTheEnginesInTheBoardsOrderThenItsEnginesCredentials() {
        scrambledRunner()
        signIn(); openDraft()
        assertEquals(listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode"), engineRows())
        compose.onNode(hasText("Done") and hasAnyAncestor(isDialog())).performClick()
        openModelMenu()
        assertEquals("the draft's engine, its sign-in then the keys it runs", listOf("Default", "Signed in on Fixture runner", "✓ Default", "API keys", "DeepSeek"),
            section("Provider", until = setOf("Close")))
    }

    @Test fun anEngineTheRunnerHasNotReportedIsNotOffered() {
        signIn(); openDraft()
        // The fixture's runner reports Claude Code and Codex only: one older than the rest runs nothing on them, and Antigravity —
        // with no Google account and no key on this runner — would not be offered either (A07-4).
        assertEquals(listOf("Claude Code", "Codex"), engineRows())
    }
}
