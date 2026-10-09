package io.orbitd.android.composer

import org.junit.Assert.*
import org.junit.Test

/** A07-3 (iOS 25697e200, `SessionProviderChoices.engineSlugs`): a new session's Provider rows list the engines as claude, codex,
 * antigravity, kimi — whatever order the runner reports them in — and every other provider after them. */
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

    /** A Provider row's name, without what follows it (" · Google account", " — Not installed →"). */
    private fun names() = section("Provider", until = setOf("Account", "Close")).map { it.removePrefix("✓ ").substringBefore(" · ").substringBefore(" — ") }

    @Test fun aNewSessionListsTheEnginesInIosOrderThenKeysThenOpenCode() {
        scrambledRunner()
        signIn(); openDraft(); openModelMenu()
        assertEquals(listOf("Claude", "Codex", "Antigravity", "Kimi", "DeepSeek", "OpenCode"), names())
    }

    @Test fun anEngineTheRunnerHasNotReportedIsStillListedInItsPlace() {
        signIn(); openDraft(); openModelMenu()
        // The fixture's runner reports Claude Code and Codex only: Kimi's row claims nothing either way, as on iOS, and Antigravity —
        // with no Google account and no key on this runner — is not offered at all (A07-4).
        assertEquals(listOf("Claude", "Codex", "Kimi"), names())
    }
}
