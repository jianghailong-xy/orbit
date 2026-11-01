package io.orbitd.android

import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.composer.CredentialKind
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.regionHeld
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.reader.body
import io.orbitd.android.reader.transcriptRows
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * The Claude region check on Android's surfaces (docs/claude-region-check-contract.md, board 03), case for case with OrbitKit's
 * ClaudeRegionTests — themselves the web's `sessionProviderChoices.test.ts` (a runner blocked for the Claude region),
 * `RunnerEngines.claudeRegion.test.tsx` and `Transcript.claudeRegion.test.tsx`: Region not supported on the Anthropic credentials of the
 * Provider menu and the engine list, the machine page's Claude Code row and note, the transcript's lines, and a held session's words in
 * the list. A runner that reads no region — or an allowed one — draws what it draws today. The rules and the card are core's
 * ClaudeRegionTest; the words ClaudeRegionCopyParityTest's.
 */
class ClaudeRegionSurfacesTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private fun list(s: String) = Wire.json.parseToJsonElement(s).jsonArray.map { it.jsonObject }

    private val blocked = """{"verdict":"blocked","country":"CN","regionCode":null,"name":"mainland China","viaProxy":false,"checkedAt":"2026-10-31T03:58:00Z"}"""
    private val allowed = """{"verdict":"allowed","country":"SG","regionCode":null,"name":"Singapore","viaProxy":false,"checkedAt":"2026-10-31T03:58:00Z"}"""
    /** 2026-10-31 12:00 in Shanghai: HPC's check two minutes before. */
    private val now = Instant.parse("2026-10-31T04:00:00Z").toEpochMilli()

    // the pickers (sessionProviderChoices.test.ts, "a runner blocked for the Claude region")

    /** Board 02 C's keys: DeepSeek, Personal Max and Work (Anthropic), Local vLLM — and a Claude pool. */
    private val deepseek = """{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
        "models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}],"defaultModel":"deepseek-v4-pro"}"""
    private val personalMax = """{"slug":"anthropic","label":"Personal Max","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true}"""
    private val work = """{"slug":"anthropic-2","label":"Work","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true}"""
    private val vllm = """{"slug":"local-vllm","label":"Local vLLM","runtime":"claude","presetSlug":null,"engines":["claude","opencode"],
        "models":[{"value":"x-1","label":"X 1"}],"defaultModel":"x-1"}"""
    private val claudePool = """{"slug":"claude-pool","label":"Claude Pool","runtime":"claude","engines":["claude"],"pool":true,"members":[],"modelsFromRuntime":true}"""
    private val codexPool = """{"slug":"codex-pool","label":"Codex Pool","runtime":"codex","engines":["codex"],"pool":true,"members":[],"modelsFromRuntime":true}"""

    private val threeAccounts = """[{"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","name":"Personal","auth":"yes"},
        {"id":"slot-2","name":"Work","auth":"yes"},{"id":"slot-3","name":"Team","auth":"yes"}]},{"engine":"codex","installed":true,"auth":"yes"},
        {"engine":"opencode","installed":true,"auth":"unknown"}]"""

    private fun catalog(providers: List<String>, region: String?, engines: String = threeAccounts) = ComposerCatalog(
        obj("""{"id":"r","engines":$engines,"capabilities":["claude-account-move/v1"]${region?.let { ""","region":$it""" } ?: ""}}"""),
        providers.map(::obj))

    private data class Reason(val unavailable: String?, val fixEngine: String?, val regionBlocked: Boolean)
    private val region = Reason("Region not supported", "claude", true)
    private val none = Reason(null, null, false)
    private fun reasons(catalog: ComposerCatalog, engine: String) = catalog.credentials(engine).map { Reason(it.unavailable, it.fixEngine, it.regionBlocked) }

    @Test fun anthropicCredentialsUnderClaudeCodeReadRegionNotSupportedAndOtherKeysNothing() {
        val catalog = catalog(listOf(deepseek, personalMax, work, vllm, claudePool), blocked)
        assertEquals(listOf("claude", "claude-pool", "deepseek", "anthropic", "anthropic-2", "local-vllm"), catalog.credentials("claude").map { it.id })
        assertEquals(listOf(region, region, none, region, region, none), reasons(catalog, "claude"))
        // None of the sign-in's accounts can take a session there: the Provider row says the sign-in by its own name, not an account.
        val signIn = catalog.credentials("claude").first()
        assertEquals("Default", signIn.label)
        assertEquals("Default", catalog.providerValue(signIn, "claude", obj("""{"provider":"claude"}"""), JsonObject(emptyMap()), draft = false))
    }

    @Test fun theRegionOutranksAnyOtherReasonAnAnthropicCredentialHas() {
        val missing = """[{"engine":"claude","installed":false,"auth":"unknown"}]"""
        assertEquals(listOf(region, region,
            // A DeepSeek key keeps its own reason: Claude Code's CLI is what it lacks.
            Reason("Not installed", "claude", false)), reasons(catalog(listOf(personalMax, deepseek), blocked, missing), "claude"))
        val signedOut = """[{"engine":"claude","installed":true,"auth":"no"}]"""
        assertEquals(region, reasons(catalog(listOf(deepseek), blocked, signedOut), "claude").first())
    }

    @Test fun onlyClaudeCodeIsGated() {
        val catalog = catalog(listOf(deepseek, personalMax, codexPool), blocked)
        assertTrue(catalog.credentials("codex").all { !it.regionBlocked && it.unavailable == null })
        assertTrue(catalog.credentials("opencode").none { it.regionBlocked })
    }

    @Test fun aRunnerThatReadsNoRegionOrAnAllowedOneListsWhatItListsToday() {
        val providers = listOf(deepseek, personalMax, vllm, claudePool)
        val today = catalog(providers, null)
        assertEquals(today.credentials("claude"), catalog(providers, allowed).credentials("claude"))
        assertTrue(today.credentials("claude").none { it.regionBlocked || it.unavailable != null })
        assertEquals(today.engines(), catalog(providers, allowed).engines())
        // Its sign-in is on its accounts, as ever: Automatic on a runner that moves a session between them.
        val signIn = today.credentials("claude").first()
        assertEquals("Automatic", today.providerValue(signIn, "claude", obj("""{"provider":"claude"}"""), JsonObject(emptyMap()), draft = false))
    }

    @Test fun theClaudeCodeEngineRowStaysPickableWhileAnotherCredentialCanRunIt() {
        val claude = catalog(listOf(deepseek, personalMax, vllm), blocked).engines(listOf("claude" to "claude")).first { it.engine == "claude" }
        assertNull(claude.unavailable)
        assertFalse(claude.regionBlocked)
        assertEquals("deepseek", claude.landing?.id)
    }

    @Test fun theClaudeCodeEngineRowGreysOnlyWhenNoOtherCredentialCanRunIt() {
        val engines = catalog(listOf(personalMax, claudePool), blocked).engines()
        val claude = engines.first { it.engine == "claude" }
        assertEquals("Region not supported", claude.unavailable)
        assertEquals("claude", claude.fixEngine)
        assertTrue(claude.regionBlocked)
        assertEquals("claude", claude.landing?.id)
        assertNull(engines.first { it.engine == "codex" }.unavailable)
    }

    @Test fun theProviderAPressMovesToIsNamedAsTheMenuNamesIt() {
        val catalog = catalog(listOf(deepseek, personalMax), blocked)
        assertEquals(CredentialKind.KEY, catalog.current("claude", "deepseek").kind)
        assertEquals("DeepSeek", catalog.providerName("claude", "deepseek"))
        assertEquals(ProviderEngines.cliName("claude"), catalog.providerName("claude", "claude"))
    }

    // the machine page (RunnerEngines.claudeRegion.test.tsx, board 03)

    /** HPC as board 03 draws it: Claude Code with three accounts (one signed out) and a usage reading, Codex beside it. */
    private fun hpc(region: String?, online: Boolean = true) = obj("""{"id":"r","name":"workstation-gpu","displayName":"HPC",
        "status":"${if (online) "ONLINE" else "OFFLINE"}","online":$online,"lastHeartbeatAt":"2026-10-31T03:59:50Z",
        "capabilities":["claude-region/v1"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.302 (Claude Code)","auth":"yes",
          "accounts":[{"id":"default","name":"Personal","home":"/root/.claude","auth":"yes"},
                      {"id":"slot-2","name":"Work","home":"/root/.orbit/claude-accounts/1","auth":"yes"},
                      {"id":"slot-3","name":"Team","home":"/root/.orbit/claude-accounts/2","auth":"no"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.164.0","auth":"yes"}],
        "planUsage":{"provider":"claude","fiveHour":{"utilization":66,"resetsAt":"2026-10-31T06:00:00Z"},
          "sevenDay":{"utilization":12,"resetsAt":"2026-11-04T06:00:00Z"}}${region?.let { ""","region":$it""" } ?: ""}}""")
    private fun health(runner: JsonObject, engine: String) = runner["engines"]!!.jsonArray.map { it.jsonObject }.first { it["engine"]!!.jsonPrimitive.content == engine }

    @Test fun theClaudeCodeRowSaysRegionNotSupportedAndReadsNoUsage() {
        val runner = hpc(blocked)
        assertTrue(RunnerPage.claudeRegionBlocked(runner, "claude"))
        assertEquals("Region not supported" to "warn", RunnerPage.engineStatus(health(runner, "claude"), runner))
        assertEquals(emptyList<Any>(), RunnerPage.engineWindows(runner, "claude", now))
        assertNull(RunnerPage.engineNextAccount(runner, "claude", now))
        assertFalse(RunnerPage.marksNext(runner, "claude", "default", now))
        assertEquals(emptyList<Any>(), RunnerPage.accountWindows(runner, "claude", "default"))
        // No Claude sign-in starts there, so no account is added or signed in again.
        assertFalse(RunnerPage.canSignIn(runner, "claude"))
        assertFalse(RunnerPage.canAddAccount(runner, "claude"))
        // Codex on the same machine is untouched.
        assertFalse(RunnerPage.claudeRegionBlocked(runner, "codex"))
        assertEquals("Signed in", RunnerPage.engineStatus(health(runner, "codex"), runner)?.first)
        assertTrue(RunnerPage.canAddAccount(runner, "codex"))
        assertTrue(RunnerPage.canSignIn(runner, "codex"))
    }

    @Test fun theNoteSaysWhyAndWhereClaudesConnectionCameOut() {
        val note = RunnerPage.claudeRegionNote(hpc(blocked), now)!!
        assertEquals("Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use " +
            "Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys.", note.note)
        assertEquals("Checked 2m ago · Claude’s connection: mainland China (no proxy)", note.checked)
        assertEquals("Checked 2m ago · Claude’s connection: mainland China (through a proxy)",
            RunnerPage.claudeRegionNote(hpc(blocked.replace("\"viaProxy\":false", "\"viaProxy\":true")), now)?.checked)
    }

    @Test fun aMachineThatReadsNoRegionOrAnAllowedOneDrawsWhatItDrawsToday() {
        for (region in listOf(null, allowed)) {
            val runner = hpc(region)
            assertFalse(RunnerPage.claudeRegionBlocked(runner, "claude"))
            assertNull(RunnerPage.claudeRegionNote(runner, now))
            assertEquals("Signed out" to "warn", RunnerPage.engineStatus(health(runner, "claude"), runner))
            assertTrue(RunnerPage.canSignIn(runner, "claude"))
            assertTrue(RunnerPage.canAddAccount(runner, "claude"))
            assertTrue(RunnerPage.accountWindows(runner, "claude", "default").isNotEmpty())
            assertTrue(RunnerPage.needsSignIn(health(runner, "claude"), runner))
            assertEquals(RunnerPage.attention(hpc(null), emptyList(), now, null), RunnerPage.attention(runner, emptyList(), now, null))
        }
    }

    // the transcript (Transcript.claudeRegion.test.tsx)

    private val refusal = "CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude."
    private val stopped = "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, " +
        "where Anthropic doesn’t offer Claude."
    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun turn(error: String) = transcriptRows(listOf(
        event(1, "user", """{"text":"Now do the same for the sign-up test."}"""),
        event(2, "error", buildJsonObject { put("message", error) }.toString()),
        event(3, "turn_end", """{"subtype":"error_during_execution","numTurns":0,"costUsd":0}""")))
    private fun errorLines(error: String) = turn(error).filter { it.event.type == "error" }.map { it.event.body() }

    @Test fun aRefusalDrawsNoLineAndItsTurnCountsAsAnswered() {
        val rows = turn(refusal)
        assertEquals(listOf("user"), rows.map { it.event.type })
        assertEquals(emptyList<String>(), errorLines(refusal))
    }

    @Test fun aStoppedTurnSaysItsSentenceWithoutTheCode() {
        assertEquals(listOf("Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude."),
            errorLines(stopped))
    }

    @Test fun otherErrorsAreDrawnAsBefore() {
        assertEquals(listOf("spawn claude: no such file"), errorLines("spawn claude: no such file"))
    }

    // a held session's words in the list (sessionLine, statusLabel)

    @Test fun aHeldSessionIsQueuedWithARegionRefusal() {
        assertTrue(DirectorySession("s", status = "PENDING", runState = "QUEUED", error = refusal).regionHeld)
        assertTrue("from a server that names no run state", DirectorySession("s", status = "PENDING", error = stopped).regionHeld)
        assertFalse(DirectorySession("s", status = "PENDING", runState = "QUEUED").regionHeld)
        assertFalse(DirectorySession("s", status = "FAILED", runState = "FAILED", error = refusal).regionHeld)
        assertFalse(DirectorySession("s", status = "PENDING", runState = "QUEUED", error = "Waiting for a slot").regionHeld)
    }
}
