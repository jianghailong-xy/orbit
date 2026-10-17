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
        await { has(hasText("DeepSeek Harness ⌄")) }
        engineList()
        assertTrue(has(hasTestTag("engine:dsh") and hasText("✓")))
        assertEquals(emptyList<String>(), names.mapNotNull { (engine, name) -> misfit(engine, name) })
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
