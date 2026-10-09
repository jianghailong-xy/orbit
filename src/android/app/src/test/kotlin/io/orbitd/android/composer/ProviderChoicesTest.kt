package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The composer's Provider list (OrbitKit SessionProviderChoicesTests): iOS's order, why a row can't run here, and what an
 * existing session may move to. */
class ProviderChoicesTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private fun list(s: String) = Wire.json.parseToJsonElement(s).jsonArray.map { it.jsonObject }
    private val keys = list("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek"},
        {"slug":"moonshot","label":"Moonshot","runtime":"kimi","presetSlug":"moonshot"}]""")
    private val pool = obj("""{"slug":"team-pool","label":"Team pool","runtime":"claude","modelsFromRuntime":true,"pool":true,"members":[]}""")
    private fun catalog(engines: String, providers: List<JsonObject> = keys + pool) =
        ComposerCatalog(obj("""{"id":"r","engines":$engines}"""), providers)

    /** A07-3: claude, codex, antigravity, kimi whatever the runner's order; then pools, configured keys and OpenCode. */
    @Test fun theEnginesComeInIosOrderThenPoolsThenKeysThenOpenCode() {
        val catalog = catalog("""[{"engine":"opencode","installed":true},{"engine":"kimi","installed":true,"auth":"yes"},
            {"engine":"codex","installed":true,"auth":"yes"},{"engine":"claude","installed":true,"auth":"yes"}]""")
        assertEquals(listOf("claude", "codex", "antigravity", "kimi", "team-pool", "deepseek", "moonshot", "opencode"),
            catalog.choices(keyAvailable = true).map { it.id })
        assertEquals(listOf("Claude", "Codex", "Antigravity", "Kimi", "Team pool", "DeepSeek", "Moonshot", "OpenCode"),
            catalog.choices(keyAvailable = true).map { it.label })
    }

    /** Missing outranks signed out; a key or a pool needs only the CLI it borrows; OpenCode only once the runner has it. */
    @Test fun aRowSaysWhyItCannotRunHere() {
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"no"},{"engine":"codex","installed":false,"auth":"no"},
            {"engine":"kimi","installed":false},{"engine":"opencode","installed":false}]""")
        val reasons = catalog.choices().associate { it.id to it.unavailable }
        assertEquals("Not signed in", reasons["claude"])
        assertEquals("Not installed", reasons["codex"])
        assertNull("a key runs on its own credential: a signed-out Claude Code runs it", reasons["deepseek"])
        assertNull(reasons["team-pool"])
        assertEquals("the Kimi CLI it borrows is missing", "Not installed", reasons["moonshot"])
        assertFalse("OpenCode is offered once the runner has it", "opencode" in reasons)
    }

    /** An existing session moves only between the providers of the CLI it started on, in the list's order; one absent from the
     * list leads. */
    @Test fun aSessionMovesOnlyWithinItsOwnCli() {
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]""")
        assertEquals(listOf("claude", "team-pool", "deepseek"), catalog.sameRuntime("deepseek").map { it.id })
        assertEquals(listOf("kimi", "moonshot"), catalog.sameRuntime("kimi").map { it.id })
        assertEquals("a removed key still renders as the session's own", listOf("gone", "claude", "team-pool", "deepseek"),
            catalog.sameRuntime("gone").map { it.id })
        assertEquals(listOf("opencode"), catalog.sameRuntime("opencode").map { it.id })
    }

    private val deepseek = obj("""{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek"}""")
    private val custom = obj("""{"slug":"my-endpoint","label":"My endpoint","runtime":"anthropic-compatible"}""")
    private val harness = obj("""{"slug":"deepseek-harness","label":"DeepSeek Harness","runtime":"dsh"}""")

    /** A07-13 (iOS 0557592f8, testEngineTitleNamesTheCLIThatExecutes): the CLI that executes, not the vendor whose models it
     * writes; a provider nothing can place takes the server's own Claude fallback. */
    @Test fun theEngineTitleNamesTheCliThatExecutes() {
        val configured = listOf(deepseek, custom, harness)
        fun title(provider: String) = ProviderChoices.engineTitle(provider, configured)
        assertEquals("Claude Code", title("claude"))
        assertEquals("Claude Code", title("deepseek"))
        assertEquals("Claude Code", title("my-endpoint"))
        assertEquals("Codex", title("codex"))
        assertEquals("Kimi Code", title("kimi"))
        assertEquals("OpenCode", title("opencode"))
        assertEquals("Antigravity", title("antigravity"))
        assertEquals("DeepSeek Harness", title("dsh"))
        assertEquals("DeepSeek Harness", title("deepseek-harness"))
        assertEquals("Claude Code", title("nonsense"))
    }

    /** A held pick adds "→ next" only when it changes the engine (testEngineTitleSaysWhereAHeldPickGoesOnlyWhenTheEngineChanges). */
    @Test fun theEngineTitleSaysWhereAHeldPickGoesOnlyWhenTheEngineChanges() {
        assertEquals("Claude Code → Codex", ProviderChoices.engineTitle("claude", emptyList(), next = "codex"))
        assertEquals("OpenCode → Claude Code", ProviderChoices.engineTitle("opencode", emptyList(), next = "claude"))
        assertEquals("Claude Code", ProviderChoices.engineTitle("deepseek", listOf(deepseek), next = "claude"))
        assertEquals("Claude Code", ProviderChoices.engineTitle("claude", emptyList(), next = null))
    }

    /** A07-6 (iOS 09dc74803, shared openCodeKeys.spec): how an OpenCode session names the key it spends. */
    @Test fun openCodeKeysNameTheKeyInTheModelAndThePickerChoice() {
        assertEquals("orbit-glm/glm-5", OpenCodeKeys.model("glm", "glm-5"))
        assertEquals("glm" to "glm-5", OpenCodeKeys.key("orbit-glm/glm-5"))
        assertEquals("deepseek" to "deepseek/chat", OpenCodeKeys.key("orbit-deepseek/deepseek/chat"))
        assertNull(OpenCodeKeys.key("opencode/big-pickle"))
        assertNull(OpenCodeKeys.key("orbit-/x"))
        assertNull(OpenCodeKeys.key("orbit-glm/"))
        assertEquals("glm", OpenCodeKeys.choiceKey("opencode/glm"))
        assertNull(OpenCodeKeys.choiceKey("opencode"))
        assertEquals("opencode/glm", OpenCodeKeys.choice("opencode", "orbit-glm/glm-5"))
        assertEquals("opencode", OpenCodeKeys.choice("opencode", "opencode/big-pickle"))
        assertEquals("a key's model on another engine names nothing", "claude", OpenCodeKeys.choice("claude", "orbit-glm/glm-5"))
        assertEquals("opencode", ProviderChoices.executingRuntime("opencode/glm", emptyList()))
    }

    /** Every key the server marks runsOnOpenCode is listed again after OpenCode, its models under the ids that name the key; an
     * OpenCode session moves between OpenCode's own config and those keys. */
    @Test fun theKeysOpenCodeMaySpendFollowItWithTheirModels() {
        val providers = list("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","runsOnOpenCode":true,
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]},
            {"slug":"moonshot","label":"Moonshot","runtime":"kimi","runsOnOpenCode":false}]""") + pool
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"opencode","installed":true}]""", providers)
        assertEquals(listOf("opencode", "opencode/deepseek"), catalog.choices().map { it.id }.takeLast(2))
        assertEquals("DeepSeek", catalog.choices().last().label)
        assertEquals(listOf("orbit-deepseek/deepseek-chat" to "DeepSeek Chat"),
            catalog.models("opencode/deepseek").map { it.text("value") to it.text("label") })
        assertEquals(listOf("opencode", "opencode/deepseek"), catalog.sameRuntime("opencode/deepseek").map { it.id })
        assertFalse("no key is listed under an OpenCode the runner doesn't have",
            catalog("""[{"engine":"claude","installed":true,"auth":"yes"}]""", providers).choices().any { it.id.startsWith("opencode") })
    }

    /** A07-4 with A13-3's composer part (iOS d2737d665, cd8e8a41a; GeminiEntryParityTests): Antigravity is offered for a Google
     * account or a key the server confirms, named by which; a runner too old says "Update runner", a missing CLI "Not installed",
     * a lapsed Google sign-in "Not signed in" — each fixed on Antigravity's own engine page. */
    @Test fun antigravityIsOfferedForAGoogleAccountOrAKeyAndSaysWhatItRunsOn() {
        fun runner(state: String, health: String = """{"engine":"antigravity","installed":true,"auth":"yes"}""") =
            ComposerCatalog(obj("""{"id":"r","engines":[$health],"antigravity":$state}"""),
                list("""[{"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini"}]"""))
        fun agy(catalog: ComposerCatalog, key: Boolean) = catalog.choices(key).firstOrNull { it.id == "antigravity" }
        val google = runner("""{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"google","googleLogin":"available"}""")
        assertEquals("Google account", agy(google, key = true)?.labelDetail)
        assertNull(agy(google, key = true)?.unavailable)
        val envKey = runner("""{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"available"}""")
        assertEquals("env key", agy(envKey, key = true)?.labelDetail)
        assertNull("no Google account and no key: not offered", agy(envKey, key = false))
        val lapsed = runner("""{"supported":true,"installed":true,"envKeyAvailable":false,"authSource":"google","googleLogin":"available"}""")
        assertEquals("Not signed in", agy(lapsed, key = false)?.unavailable)
        assertEquals("antigravity", agy(lapsed, key = false)?.fixEngine)
        assertEquals("a lapsed sign-in where a key still runs it is the key's", "env key", agy(lapsed, key = true)?.labelDetail)
        assertNull(agy(lapsed, key = true)?.unavailable)
        val old = runner("""{"supported":false,"installed":null,"envKeyAvailable":false,"authSource":"google","googleLogin":"needs_update"}""")
        assertEquals("Update runner", agy(old, key = false)?.unavailable)
        val missing = runner("""{"supported":true,"installed":false,"envKeyAvailable":true,"authSource":"google","googleLogin":"available"}""",
            """{"engine":"antigravity","installed":false}""")
        assertEquals("Not installed", agy(missing, key = true)?.unavailable)
        // A Gemini key runs on the Antigravity CLI: named for it, and blocked only by what blocks that CLI.
        val gemini = google.choices(true).single { it.id == "gemini" }
        assertEquals("Antigravity CLI", gemini.labelDetail)
        assertNull(gemini.unavailable)
        assertEquals("Not installed", missing.choices(true).single { it.id == "gemini" }.unavailable)
        assertEquals(" →", ProviderChoices.fixSuffix("antigravity"))
        assertEquals(", sign in →", ProviderChoices.fixSuffix("codex"))
    }

    /** Which machine's answer the picker reads: the workspace's for the session's runner (a draft's detail is its workspace), else
     * the runner's own credential. */
    @Test fun theKeyAnswerIsTheWorkspacesForThisRunner() {
        val catalog = ComposerCatalog(obj("""{"id":"34A07cComposerRunner01","antigravity":{"envKeyAvailable":false}}"""), emptyList())
        assertTrue(catalog.antigravityKeyAvailable(obj("""{"workspace":{"antigravityKeyAvailableByRunner":{"34A07cComposerRunner01":true}}}""")))
        assertFalse(catalog.antigravityKeyAvailable(obj("""{"workspace":{"antigravityKeyAvailableByRunner":{"other":true}}}""")))
        assertTrue("a draft's detail is its workspace",
            catalog.antigravityKeyAvailable(obj("""{"id":"w","antigravityKeyAvailableByRunner":{"34A07cComposerRunner01":true}}""")))
        assertFalse(catalog.antigravityKeyAvailable(obj("""{"id":"s"}""")))
        assertTrue(ComposerCatalog(obj("""{"id":"r","antigravity":{"envKeyAvailable":true}}"""), emptyList()).antigravityKeyAvailable(obj("""{"id":"s"}""")))
    }
}
