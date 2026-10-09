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
        assertEquals(listOf("claude", "codex", "antigravity", "kimi", "team-pool", "deepseek", "moonshot", "opencode"), catalog.choices().map { it.id })
        assertEquals(listOf("Claude", "Codex", "Antigravity", "Kimi", "Team pool", "DeepSeek", "Moonshot", "OpenCode"), catalog.choices().map { it.label })
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
}
