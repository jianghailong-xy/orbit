package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The composer's engines and each one's Provider list (OrbitKit SessionProviderChoicesTests, on the provider/engine split): the
 * boards' engine order, why a row can't run here, and what an existing session may move to — only what its own engine runs. */
class ProviderChoicesTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private fun list(s: String) = Wire.json.parseToJsonElement(s).jsonArray.map { it.jsonObject }
    private val keys = list("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek"},
        {"slug":"moonshot","label":"Moonshot","runtime":"kimi","presetSlug":"moonshot"}]""")
    private val pool = obj("""{"slug":"team-pool","label":"Team pool","runtime":"claude","modelsFromRuntime":true,"pool":true,"members":[]}""")
    private fun catalog(engines: String, providers: List<JsonObject> = keys + pool) =
        ComposerCatalog(obj("""{"id":"r","engines":$engines}"""), providers)

    /** The engines in the boards' order (ALL_ENGINES) whatever the runner's; under each, its own sign-in, then the pools, then the
     * keys it runs — a key under the engine that runs it, not in one list of everything. */
    @Test fun theEnginesComeInTheBoardsOrderAndEachListsItsSignInThenPoolsThenKeys() {
        val catalog = catalog("""[{"engine":"opencode","installed":true},{"engine":"kimi","installed":true,"auth":"yes"},
            {"engine":"codex","installed":true,"auth":"yes"},{"engine":"claude","installed":true,"auth":"yes"}]""")
        assertEquals(listOf("claude", "codex", "kimi", "opencode"), catalog.engines().map { it.engine })
        assertEquals(listOf("Claude Code", "Codex", "Kimi Code", "OpenCode"), catalog.engines().map { it.label })
        assertEquals(listOf("claude" to CredentialKind.LOGIN, "team-pool" to CredentialKind.POOL, "deepseek" to CredentialKind.KEY),
            catalog.credentials("claude").map { it.id to it.kind })
        assertEquals(listOf("kimi", "moonshot"), catalog.credentials("kimi").map { it.id })
        assertEquals(listOf("opencode"), catalog.credentials("opencode").map { it.id })
    }

    /** Missing outranks signed out, and the engine's page fixes either; a key or a pool needs only the CLI it runs on; an engine the
     * runner reports as missing stays listed with why. */
    @Test fun aRowSaysWhyItCannotRunHere() {
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"no"},{"engine":"codex","installed":false,"auth":"no"},
            {"engine":"kimi","installed":false},{"engine":"opencode","installed":false}]""")
        val claude = catalog.credentials("claude").associate { it.id to it.unavailable }
        assertEquals("Not signed in", claude["claude"])
        assertEquals("claude", catalog.credentials("claude").first().fixEngine)
        assertNull("a key runs on its own credential: a signed-out Claude Code runs it", claude["deepseek"])
        assertNull(claude["team-pool"])
        assertEquals("Not installed", catalog.credentials("codex").single().unavailable)
        assertEquals("the Kimi CLI it runs on is missing", "Not installed", catalog.credentials("kimi").single { it.id == "moonshot" }.unavailable)
        assertEquals("Not installed", catalog.credentials("opencode").single().unavailable)
        assertEquals("a signed-out sign-in leaves the engine on what still runs", "team-pool", catalog.engines().first().landing?.id)
        assertEquals("Not installed", catalog.engines().single { it.engine == "codex" }.unavailable)
        assertEquals("codex", catalog.engines().single { it.engine == "codex" }.fixEngine)
    }

    /** An existing session moves only between the credentials of the engine it runs on, in the list's own order; one the list no
     * longer has still renders as the session's own. */
    @Test fun aSessionMovesOnlyWithinItsOwnEngine() {
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]""")
        assertEquals(listOf("claude", "team-pool", "deepseek"), catalog.credentials(catalog.engineOf(obj("""{"provider":"deepseek"}"""))).map { it.id })
        assertEquals(listOf("kimi", "moonshot"), catalog.credentials(catalog.engineOf(obj("""{"provider":"kimi"}"""))).map { it.id })
        assertTrue("a removed key still renders as the session's own", catalog.credentials("claude").none { it.id == "gone" })
        assertEquals("gone" to CredentialKind.KEY, catalog.current("claude", "gone").let { it.id to it.kind })
        assertTrue("an OpenCode this runner doesn't report runs nothing here", catalog.credentials("opencode").isEmpty())
        assertEquals(EngineCopy.OPENCODE_OWN, catalog.current("opencode", "opencode").label)
    }

    private val deepseek = obj("""{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek"}""")
    private val custom = obj("""{"slug":"my-endpoint","label":"My endpoint","runtime":"anthropic-compatible"}""")
    private val harness = obj("""{"slug":"deepseek-harness","label":"DeepSeek Harness","runtime":"dsh"}""")

    /** A07-13 (iOS 0557592f8) on the split: the menu is titled by the session's engine — the one it records, whatever key it
     * spends — and a read without one (from before engines were recorded) by the engine its provider ran on, Claude Code for a
     * provider nothing can place. */
    @Test fun theEngineTitleNamesTheSessionsEngine() {
        val catalog = ComposerCatalog(obj("""{"id":"r"}"""), listOf(deepseek, custom, harness))
        fun title(detail: String) = ProviderEngines.cliName(catalog.engineOf(obj(detail)))
        assertEquals("OpenCode", title("""{"engine":"opencode","provider":"deepseek"}"""))
        assertEquals("DeepSeek Harness", title("""{"engine":"dsh","provider":"deepseek"}"""))
        assertEquals("Claude Code", title("""{"engine":"claude","provider":"deepseek"}"""))
        fun legacy(provider: String) = title("""{"provider":"$provider"}""")
        assertEquals("Claude Code", legacy("claude"))
        assertEquals("Claude Code", legacy("deepseek"))
        assertEquals("Claude Code", legacy("my-endpoint"))
        assertEquals("Codex", legacy("codex"))
        assertEquals("Kimi Code", legacy("kimi"))
        assertEquals("OpenCode", legacy("opencode"))
        assertEquals("Antigravity CLI", legacy("antigravity"))
        assertEquals("DeepSeek Harness", legacy("dsh"))
        assertEquals("DeepSeek Harness", legacy("deepseek-harness"))
        assertEquals("Claude Code", legacy("nonsense"))
    }

    /** A pick held for the resume is a credential of the session's own engine, sent with that engine: the title never moves to
     * another (it said "OpenCode → Claude Code" when a held key could take the next turn to another CLI). */
    @Test fun aHeldPickNeverChangesTheEngineTitle() {
        val catalog = ComposerCatalog(obj("""{"id":"r"}"""), listOf(deepseek))
        fun title(detail: String, held: String) = ProviderEngines.cliName(catalog.engineOf(JsonObject(obj(detail) + obj(held))))
        assertEquals("OpenCode", title("""{"engine":"opencode","provider":"opencode"}""", """{"provider":"deepseek","engine":"opencode"}"""))
        assertEquals("Claude Code", title("""{"engine":"claude","provider":"claude"}""", """{"provider":"deepseek","engine":"claude"}"""))
        assertEquals("Claude Code", title("""{"engine":"claude","provider":"claude"}""", """{}"""))
    }

    /** A07-6 on the split (contract §1.3, §3.3): an OpenCode session on a key names the key as its provider and the model bare — no
     * `opencode/<slug>` choice and no `orbit-<slug>/<model>` id. */
    @Test fun anOpenCodeSessionOnAKeyNamesTheKeyAndABareModel() {
        val providers = list("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","engines":["claude","opencode","dsh"],
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]""")
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"opencode","installed":true}]""", providers)
        assertEquals(listOf("opencode", "deepseek"), catalog.credentials("opencode").map { it.id })
        assertTrue(catalog.credentials("opencode").none { "/" in it.id })
        assertEquals(listOf("deepseek-chat"), catalog.models("opencode", "deepseek").map { it.text("value") })
        assertEquals(CredentialKind.KEY, catalog.current("opencode", "deepseek").kind)
        assertEquals("DeepSeek", catalog.current("opencode", "deepseek").label)
        assertEquals("opencode", catalog.engineOf(obj("""{"engine":"opencode","provider":"deepseek","model":"deepseek-chat"}""")))
    }

    /** Every key the server says OpenCode runs (`engines`, or `runsOnOpenCode` on an older payload) is listed under OpenCode after
     * its own config, with the key's models; an OpenCode session moves between them, and no key is listed under an OpenCode the
     * runner doesn't have. */
    @Test fun theKeysOpenCodeMaySpendFollowItsOwnConfigWithTheirModels() {
        val providers = list("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","runsOnOpenCode":true,
            "models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]},
            {"slug":"moonshot","label":"Moonshot","runtime":"kimi","runsOnOpenCode":false}]""") + pool
        val catalog = catalog("""[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"opencode","installed":true}]""", providers)
        assertEquals(listOf("opencode", "deepseek"), catalog.credentials("opencode").map { it.id })
        assertEquals(listOf(EngineCopy.OPENCODE_OWN, "DeepSeek"), catalog.credentials("opencode").map { it.label })
        assertEquals(listOf("deepseek-chat" to "DeepSeek Chat"),
            catalog.models("opencode", "deepseek").map { it.text("value") to it.text("label") })
        assertFalse("no key is listed under an OpenCode the runner doesn't have",
            catalog("""[{"engine":"claude","installed":true,"auth":"yes"}]""", providers).engines().any { it.engine == "opencode" })
    }

    /** A07-4 with A13-3's composer part (iOS d2737d665, cd8e8a41a; GeminiEntryParityTests) under Antigravity CLI: its sign-in is
     * offered for a Google account or a key the server confirms, saying which; a runner too old says "Update runner", a missing
     * CLI "Not installed", a lapsed Google sign-in "Not signed in" — each fixed on Antigravity's own engine page. */
    @Test fun antigravityIsOfferedForAGoogleAccountOrAKeyAndSaysWhatItRunsOn() {
        fun runner(state: String, health: String = """{"engine":"antigravity","installed":true,"auth":"yes"}""") =
            ComposerCatalog(obj("""{"id":"r","engines":[$health],"antigravity":$state}"""),
                list("""[{"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini"}]"""))
        fun agy(catalog: ComposerCatalog, key: Boolean) = catalog.credentials("antigravity", key).firstOrNull { it.id == "antigravity" }
        val google = runner("""{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"google","googleLogin":"available"}""")
        assertEquals("Google account", agy(google, key = true)?.detail)
        assertNull(agy(google, key = true)?.unavailable)
        val envKey = runner("""{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"available"}""")
        assertEquals("env key", agy(envKey, key = true)?.detail)
        assertNull("no Google account and no key: not offered", agy(envKey, key = false))
        val lapsed = runner("""{"supported":true,"installed":true,"envKeyAvailable":false,"authSource":"google","googleLogin":"available"}""")
        assertEquals("Not signed in", agy(lapsed, key = false)?.unavailable)
        assertEquals("antigravity", agy(lapsed, key = false)?.fixEngine)
        assertEquals("a lapsed sign-in where a key still runs it is the key's", "env key", agy(lapsed, key = true)?.detail)
        assertNull(agy(lapsed, key = true)?.unavailable)
        val old = runner("""{"supported":false,"installed":null,"envKeyAvailable":false,"authSource":"google","googleLogin":"needs_update"}""")
        assertEquals("Update runner", agy(old, key = false)?.unavailable)
        assertEquals("Update runner", old.engines().single { it.engine == "antigravity" }.unavailable)
        val missing = runner("""{"supported":true,"installed":false,"envKeyAvailable":true,"authSource":"google","googleLogin":"available"}""",
            """{"engine":"antigravity","installed":false}""")
        assertEquals("Not installed", agy(missing, key = true)?.unavailable)
        // A Gemini key is one of Antigravity CLI's credentials, blocked only by what blocks that CLI.
        val gemini = google.credentials("antigravity", true).single { it.id == "gemini" }
        assertEquals(CredentialKind.KEY, gemini.kind)
        assertNull(gemini.unavailable)
        assertEquals("Not installed", missing.credentials("antigravity", true).single { it.id == "gemini" }.unavailable)
        assertEquals(" →", ProviderChoices.fixSuffix("antigravity", "Not signed in"))
        assertEquals(", sign in →", ProviderChoices.fixSuffix("codex", "Not signed in"))
        assertEquals("a missing CLI is installed on the engine page, not signed in", " →", ProviderChoices.fixSuffix("codex", "Not installed"))
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
