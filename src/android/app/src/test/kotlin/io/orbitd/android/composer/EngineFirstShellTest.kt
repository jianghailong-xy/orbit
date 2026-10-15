package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-19 (a) and (e) over the controlled server (iOS e6295abe7, 6f3083272, f93f3fe5e; OrbitKit TaskRunHandoffTests
 * `providerSwitchNote`, AppModel `rememberDefaultModel`, ConsoleModel `draftModelSeed`): a provider picked for a session says under
 * the composer what it will do and when, until the next message goes; and a model picked is remembered for its engine and
 * credential, which a new session then starts on.
 */
class EngineFirstShellTest : ComposerShellTest() {
    private val deepseek = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
        "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]"""
    private val note = hasTestTag("composer-switch-note")

    @Test fun aProviderPickSaysUnderTheComposerWhatItWillDoUntilTheNextMessageGoes() {
        ComposerShell.providers = deepseek
        signIn(); openSession(); openModelMenu()
        assertFalse(has(note))
        compose.onNode(hasTestTag("composer-provider:deepseek") and hasClickAction()).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        await { has(note) }
        compose.onNode(note).assertTextEquals("The turn in flight finishes on Claude Code. Your next one uses DeepSeek.")
        assertFalse("the note says what the saved line did", shows("Selection saved."))
        compose.onNodeWithTag("composer-input").performTextInput("Carry on")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns") != null }
        await { !has(note) }
    }

    @Test fun aModelPickedIsRememberedForItsEngineAndCredential() {
        signIn(); openSession(); openModelMenu()
        compose.onNode(hasText("Opus 5.5", substring = true) and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { ComposerShell.body("PATCH users/me/preferences") != null }
        assertEquals(buildJsonObject { putJsonObject("defaultModels") { put("claude:claude", "claude-opus-5-5") } },
            ComposerShell.body("PATCH users/me/preferences"))
    }

    /** The account remembers Sonnet for Claude Code on its own sign-in: a new session on it starts there — the chip says so and the
     * session is made on it — while one the runtime no longer offers is not started on. */
    @Test fun aNewSessionStartsOnTheModelLastPickedForItsEngineAndCredential() {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"},{"value":"claude-sonnet-5-5","label":"Sonnet 5.5"}],
              "codex":[{"value":"gpt-6","label":"GPT-6"}]}}""")
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"defaultModels":{"claude:claude":"claude-sonnet-5-5","codex:codex":"gpt-4-retired"}}}""".encodeToByteArray()) }
        signIn(); openDraft()
        await { has(hasContentDescription("Model claude-sonnet-5-5, effort Default")) }
        compose.onNodeWithTag("composer-input").performTextInput("Start on Sonnet")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        assertEquals("claude-sonnet-5-5", ComposerShell.body("POST sessions")!!["model"]?.jsonPrimitive?.content)
    }

    @Test fun anEnginePickedLandsOnItsRememberedModelUnlessTheRuntimeRetiredIt() {
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"defaultModels":{"codex:codex":"gpt-4-retired"}}}""".encodeToByteArray()) }
        signIn(); openDraft()
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:codex") and hasClickAction()) }
        compose.onNodeWithTag("engine:codex").performClick()
        await { has(hasText("Codex ⌄")) }
        await { has(hasContentDescription("Model gpt-6, effort Default")) }
    }
}
