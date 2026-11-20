package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.text.TextLayoutResult
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A07-19 (a) and (e) over the controlled server (iOS e6295abe7, 6f3083272, f93f3fe5e; OrbitKit TaskRunHandoffTests
 * `providerSwitchNote`, ConsoleModel `draftModelSeed`): a provider picked for a session says under the composer what it will do and
 * when, until the next message goes; a model picked applies to its session only; and a new session starts on its workspace's
 * lastModel where it runs on that workspace's lastEngine and lastProvider (docs/workspace-default-model-design.md).
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

    /** A model picked applies to its session only: the account-wide model memory is retired, so nothing PATCHes the preferences. */
    @Test fun aModelPickedSendsNoPreferencesPatch() {
        signIn(); openSession(); openModelMenu()
        compose.onNode(hasText("Opus 5.5", substring = true) and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        compose.waitForIdle()
        assertEquals(emptyList<String>(), ComposerShell.calls.filter { it.startsWith("PATCH users/me") })
        assertTrue(ComposerShell.bodies.none { (_, body) -> "defaultModels" in body })
    }

    /** The workspace's person-opened session last ran Sonnet on Claude Code's own sign-in: a new session there starts on Sonnet — the
     * chip says so and the session is made on it — whatever an older client left in the account's preferences. */
    @Test fun aNewSessionStartsOnTheWorkspacesLastModel() {
        ComposerShell.runner = twoClaudeModels
        ComposerShell.workspace = ComposerShell.fields("""{"lastEngine":"claude","lastProvider":"claude","lastModel":"claude-sonnet-5-5"}""")
        oldClientPreferences()
        signIn(); openDraft()
        await { has(hasContentDescription("Model Sonnet 5.5, effort Default")) }
        compose.onNodeWithTag("composer-input").performTextInput("Start on Sonnet")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        assertEquals("claude-sonnet-5-5", ComposerShell.body("POST sessions")!!["model"]?.jsonPrimitive?.content)
    }

    /** A lastModel the runtime no longer offers, or none at all, leaves the draft on the runner's default. */
    @Test fun aNewSessionFallsBackToTheRunnerDefault() {
        ComposerShell.runner = twoClaudeModels
        ComposerShell.workspace = ComposerShell.fields("""{"lastEngine":"claude","lastProvider":"claude","lastModel":"claude-sonnet-4-retired"}""")
        oldClientPreferences()
        signIn(); openDraft()
        await { has(hasContentDescription("Model Opus 5.5, effort Default")) }
        compose.onNodeWithTag("composer-input").performTextInput("Start on the default")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        assertNotEquals("claude-sonnet-4-retired", ComposerShell.body("POST sessions")!!["model"]?.jsonPrimitive?.contentOrNull)
        assertFalse(has(hasContentDescription("Model Sonnet 5.5, effort Default")))
    }

    private val twoClaudeModels = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"}],
        "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"},{"value":"claude-sonnet-5-5","label":"Sonnet 5.5"}],
          "codex":[{"value":"gpt-6","label":"GPT-6"},{"value":"gpt-7","label":"GPT-7"}]}}""")

    /** What an older client still writes: the retired account-wide memory, naming models the runner offers. Nothing reads it. */
    private fun oldClientPreferences() {
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"defaultModels":{"claude:claude":"claude-sonnet-5-5","codex:codex":"gpt-7"}}}""".encodeToByteArray()) }
    }

    /** How [name] is laid out in its engine's row of the open Engine list: null where it is as wide as it is whole, else how wide it
     * is — squeezed into, or stretched over, a share of the row that is not its own width. */
    private fun misfit(engine: String, name: String): String? {
        val node = compose.onNode(hasText(name) and hasAnyAncestor(hasTestTag("engine:$engine")), useUnmergedTree = true).fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts)
        val whole = kotlin.math.ceil(layouts.single().multiParagraph.intrinsics.maxIntrinsicWidth)
        return if (kotlin.math.abs(node.size.width - whole) <= 1f) null else "$name: width=${node.size.width} whole=$whole"
    }

    /** A07-19's open question held in the gate (iOS 0ae7ec209 found "DeepSeek Harness" cut to "DeepSeek Har…" beside its model and
     * tick on a 402-point phone; a 360 dp emulator cut it beside its model and tick too): each engine's name keeps its own width
     * beside its model and its tick — DeepSeek Harness's ticked too — where half the row each gave every name half the row whatever
     * its width. Read by widths, as ComposerDeviceTest.a07eEngineListKeepsEveryEnginesNameWhole reads the device: the layout's
     * overflow flag also flags a line laid out at exactly its own width, which the device's captures show whole. */
    @Test @Config(qualifiers = "w360dp-h640dp") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theEngineListKeepsEveryEnginesNameWholeOnANarrowPhone() {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "capabilities":["provider:dsh"],"runtimeDefaultModels":{"dsh":"deepseek-v4-pro"},
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"},
              {"engine":"opencode","installed":true},{"engine":"dsh","installed":true,"dsh":{"versionCompatible":true}}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-6","label":"GPT-6"}],
              "dsh":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}]}}""")
        ComposerShell.providers = deepseek
        signIn(); openDraft()
        val names = listOf("claude" to "Claude Code", "codex" to "Codex", "opencode" to "OpenCode", "dsh" to "DeepSeek Harness")
        fun engineList() {
            compose.onNodeWithTag("new-session-engine").performClick()
            await { has(hasTestTag("engine:dsh")) }
        }
        engineList()
        assertEquals(emptyList<String>(), names.mapNotNull { (engine, name) -> misfit(engine, name) })
        compose.onNodeWithTag("engine:dsh").performClick()
        await { has((hasTestTag("new-session-engine") and hasText("DeepSeek Harness"))) }
        engineList()
        assertTrue(has(hasTestTag("engine:dsh") and hasText("✓")))
        assertEquals(emptyList<String>(), names.mapNotNull { (engine, name) -> misfit(engine, name) })
    }

    /** The new session page as iOS's draft opens: back alone in the bar (no drawer, no refresh) and the box focused for typing. */
    @Test fun theNewSessionPageOpensFocusedWithBackAloneInTheBar() {
        signIn(); openDraft()
        await { has(hasTestTag("new-session-engine") and isEnabled()) }
        await { has(hasTestTag("composer-input") and isFocused()) }
        compose.onNodeWithContentDescription("Back").assertExists()
        compose.onAllNodesWithContentDescription("Open navigation").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Refresh directory").assertCountEquals(0)
    }

    /** An engine picked lands on the workspace's lastModel only where it is the workspace's lastEngine and lastProvider: Codex on
     * its default, whatever the account's old memory says for it; Claude Code back on the lastModel. */
    @Test fun anEnginePickedLandsOnTheWorkspacesLastModelOnlyOnItsOwnEngine() {
        ComposerShell.runner = twoClaudeModels
        ComposerShell.workspace = ComposerShell.fields("""{"lastEngine":"claude","lastProvider":"claude","lastModel":"claude-sonnet-5-5"}""")
        oldClientPreferences()
        signIn(); openDraft()
        await { has(hasContentDescription("Model Sonnet 5.5, effort Default")) }
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:codex") and hasClickAction()) }
        compose.onNodeWithTag("engine:codex").performClick()
        await { has((hasTestTag("new-session-engine") and hasText("Codex"))) }
        await { has(hasContentDescription("Model GPT-6, effort Default")) }
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:claude") and hasClickAction()) }
        compose.onNodeWithTag("engine:claude").performClick()
        await { has((hasTestTag("new-session-engine") and hasText("Claude Code"))) }
        await { has(hasContentDescription("Model Sonnet 5.5, effort Default")) }
    }
}
