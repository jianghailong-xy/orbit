package io.orbitd.android.composer

import io.orbitd.android.composer.ProviderEngines.Credential
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * `ProviderEngines` is the Kotlin mirror of @orbit/shared `providerEngines.ts`, the compatibility table every client and the server
 * share (docs/provider-engine-contract.md §2.1). Its cases are `providerEngines.spec.ts`'s, one for one, in the same order — then
 * `cursor-api-key.spec.ts`'s for a Cursor User API Key (P2); the last ones read the shared sources back, so an engine, a CLI name, a
 * key's dialect or Cursor CLI's modes changed there reds here.
 */
class ProviderEnginesTest {
    private fun key(runtime: String?, presetSlug: String?, baseUrl: String, subscriptionToken: Boolean = false) =
        Credential.Key(runtime, presetSlug, baseUrl, subscriptionToken)
    private val deepSeek = key("claude", "deepseek", "https://api.deepseek.com/anthropic")
    private val glm = key("claude", "glm", "https://api.z.ai/api/anthropic")

    // describe('engines')

    @Test fun listsEveryEngineOnceEachUnderItsCliName() {
        assertEquals(setOf("claude", "codex", "kimi", "antigravity", "opencode", "dsh", "cursor"), ProviderEngines.ALL_ENGINES.toSet())
        assertEquals(7, ProviderEngines.ALL_ENGINES.size)
        assertEquals(mapOf("claude" to "Claude Code", "codex" to "Codex", "kimi" to "Kimi Code", "antigravity" to "Antigravity CLI",
            "opencode" to "OpenCode", "dsh" to "DeepSeek Harness", "cursor" to "Cursor CLI"), ProviderEngines.ENGINE_CLI_NAMES)
        ProviderEngines.ALL_ENGINES.forEach { assertTrue(ProviderEngines.isEngine(it)) }
        assertFalse(ProviderEngines.isEngine("deepseek-harness"))
        assertFalse(ProviderEngines.isEngine(""))
        assertFalse(ProviderEngines.isEngine(null))
    }

    // describe('credentialEngines')

    @Test fun runsASignInAPoolAndOpenCodeConfigOnTheirOwnEngineOnly() {
        for (engine in listOf("claude", "codex", "kimi", "antigravity")) assertEquals(listOf(engine), ProviderEngines.credentialEngines(Credential.Login(engine)))
        assertEquals(listOf("claude"), ProviderEngines.credentialEngines(Credential.Pool("claude")))
        assertEquals(listOf("codex"), ProviderEngines.credentialEngines(Credential.Pool("codex")))
        assertEquals(listOf("opencode"), ProviderEngines.credentialEngines(Credential.OpenCode))
    }

    @Test fun runsAKeyOnItsDialectsOwnEngineFirstThenOpenCode() {
        assertEquals(listOf("claude", "opencode"), ProviderEngines.credentialEngines(glm))
        assertEquals(listOf("codex", "opencode"), ProviderEngines.credentialEngines(key("codex", "openai", "https://api.openai.com/v1")))
        assertEquals(listOf("kimi", "opencode"), ProviderEngines.credentialEngines(key("kimi", "moonshot", "https://api.moonshot.ai/v1")))
        assertEquals(listOf("antigravity", "opencode"),
            ProviderEngines.credentialEngines(key("antigravity", "gemini", "https://generativelanguage.googleapis.com")))
    }

    @Test fun addsDeepSeekHarnessForADeepSeekKeyPresetOrCustomHostAlike() {
        assertEquals(listOf("claude", "opencode", "dsh"), ProviderEngines.credentialEngines(deepSeek))
        assertEquals(listOf("claude", "opencode", "dsh"), ProviderEngines.credentialEngines(key("claude", null, "https://api.deepseek.com/anthropic")))
        assertEquals(listOf("claude", "opencode"), ProviderEngines.credentialEngines(key("claude", null, "https://api.deepseek.com.evil.example/anthropic")))
    }

    @Test fun keepsARowStillOnTheDshRuntimeOnDeepSeekHarnessByDefault() {
        assertEquals(listOf("dsh", "claude", "opencode"),
            ProviderEngines.credentialEngines(key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic")))
        // A custom endpoint chosen for Harness (a mock, a proxy) ran on it whatever its host.
        assertEquals(listOf("dsh", "claude", "opencode"), ProviderEngines.credentialEngines(key("dsh", null, "http://127.0.0.1:8787/anthropic")))
    }

    @Test fun runsAClaudeSubscriptionTokenOnClaudeCodeAlone() {
        assertEquals(listOf("claude"), ProviderEngines.credentialEngines(key("claude", "anthropic", "https://api.anthropic.com", true)))
        assertEquals(listOf("claude"), ProviderEngines.credentialEngines(key("claude", "deepseek", "https://api.deepseek.com/anthropic", true)))
        assertEquals(emptyList<String>(), ProviderEngines.credentialEngines(key("codex", "openai", "https://api.openai.com/v1", true)))
        // The token rule outranks a legacy Harness row's default: Harness cannot spend a subscription.
        val legacyToken = key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic", true)
        assertEquals(listOf("claude"), ProviderEngines.credentialEngines(legacyToken))
        assertEquals("claude", ProviderEngines.defaultEngineOf(legacyToken))
    }

    @Test fun runsAKeyOnAProtocolNoEngineSpeaksNowhere() {
        assertEquals(emptyList<String>(), ProviderEngines.credentialEngines(key("opencode", null, "https://x.example")))
        assertNull(ProviderEngines.defaultEngineOf(key("opencode", null, "https://x.example")))
    }

    // describe('defaultEngineOf')

    @Test fun isTheEngineTheCredentialRanOnBeforeTheSplit() {
        assertEquals("kimi", ProviderEngines.defaultEngineOf(Credential.Login("kimi")))
        assertEquals("codex", ProviderEngines.defaultEngineOf(Credential.Pool("codex")))
        assertEquals("opencode", ProviderEngines.defaultEngineOf(Credential.OpenCode))
        assertEquals("claude", ProviderEngines.defaultEngineOf(deepSeek))
        assertEquals("dsh", ProviderEngines.defaultEngineOf(key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic")))
        assertEquals("antigravity", ProviderEngines.defaultEngineOf(key("antigravity", "gemini", "https://generativelanguage.googleapis.com")))
    }

    // describe('isEngineCompatible')

    @Test fun pairsAnEngineWithACredentialOnlyWhereTheTableAllowsIt() {
        assertTrue(ProviderEngines.isEngineCompatible("dsh", deepSeek))
        assertTrue(ProviderEngines.isEngineCompatible("opencode", deepSeek))
        assertFalse(ProviderEngines.isEngineCompatible("dsh", glm))
        assertFalse(ProviderEngines.isEngineCompatible("codex", glm))
        assertFalse(ProviderEngines.isEngineCompatible("claude", Credential.Login("codex")))
        assertFalse(ProviderEngines.isEngineCompatible("opencode", key("claude", "anthropic", "https://api.anthropic.com", true)))
        assertFalse(ProviderEngines.isEngineCompatible("deepseek", deepSeek))
    }

    // describe('isDeepSeekKey')

    @Test fun isTheTwoPresetsElseACustomEndpointOnApiDeepseekCom() {
        assertTrue(ProviderEngines.isDeepSeekKey("deepseek", "https://api.deepseek.com/anthropic"))
        assertTrue(ProviderEngines.isDeepSeekKey("deepseek-harness", "https://api.deepseek.com/anthropic"))
        assertTrue(ProviderEngines.isDeepSeekKey(null, "https://API.DeepSeek.com/v1"))
        assertFalse(ProviderEngines.isDeepSeekKey(null, "https://api.deepseek.com.evil.example/v1"))
        assertFalse(ProviderEngines.isDeepSeekKey(null, "not a url"))
        assertFalse(ProviderEngines.isDeepSeekKey("moonshot", "https://api.deepseek.com/anthropic"))
    }

    // @orbit/shared cursor-api-key.spec.ts (project P2): a Cursor User API Key in the same tables, case for case.

    @Test fun p2CursorsDialectIsItsKeysOwnAndEveryOtherRuntimeKeepsItsDialect() {
        assertEquals("cursor", ProviderEngines.keyDialect("cursor"))
        for ((runtime, dialect) in listOf("claude" to "anthropic", "dsh" to "anthropic", "codex" to "openai", "kimi" to "openai-compatible",
            "antigravity" to "gemini")) assertEquals(runtime, dialect, ProviderEngines.keyDialect(runtime))
        assertNull(ProviderEngines.keyDialect("opencode"))
        // The vendor a sentence names a Cursor key by: its preset's.
        assertEquals("the Cursor key “Cursor 2”",
            ProviderEngines.keyName(Json.parseToJsonElement("""{"slug":"cursor-api-2","label":"Cursor 2","presetSlug":"cursor-api"}""").jsonObject))
    }

    @Test fun p2ACursorKeyRunsOnCursorCliAloneAndEveryOtherKeyAndEngineKeepsItsOwn() {
        val cursorKey = key("cursor", "cursor-api", "https://api2.cursor.sh")
        assertEquals(listOf("cursor"), ProviderEngines.credentialEngines(cursorKey))
        assertEquals("cursor", ProviderEngines.defaultEngineOf(cursorKey))
        for (engine in ProviderEngines.ALL_ENGINES) assertEquals(engine, engine == "cursor", ProviderEngines.isEngineCompatible(engine, cursorKey))
        // The dialect decides, not the preset: a Cursor key typed in by hand is the same key.
        assertEquals(listOf("cursor"), ProviderEngines.credentialEngines(key("cursor", null, "https://api2.cursor.sh")))
        // Cursor CLI runs a Cursor key and its own sign-in; no other key runs on it, and they keep their engines.
        assertEquals(listOf("cursor"), ProviderEngines.credentialEngines(Credential.Login("cursor")))
        for ((credential, engines) in listOf(
            key("claude", "glm", "https://api.z.ai/api/anthropic") to listOf("claude", "opencode"),
            key("claude", "deepseek", "https://api.deepseek.com/anthropic") to listOf("claude", "opencode", "dsh"),
            key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic") to listOf("dsh", "claude", "opencode"),
            key("claude", "anthropic", "https://api.anthropic.com", true) to listOf("claude"),
            key("codex", "openai", "https://api.openai.com/v1") to listOf("codex", "opencode"),
            key("kimi", "moonshot", "https://api.moonshot.ai/v1") to listOf("kimi", "opencode"),
            key("antigravity", "gemini", "https://generativelanguage.googleapis.com") to listOf("antigravity", "opencode"),
            key("claude", "cursor-api", "https://api2.cursor.sh") to listOf("claude", "opencode"),
            key("opencode", null, "https://x.example") to emptyList(),
        )) {
            assertEquals("$credential", engines, ProviderEngines.credentialEngines(credential))
            assertFalse("$credential", ProviderEngines.isEngineCompatible("cursor", credential))
        }
        // GET /providers says so of a Cursor key; a payload from before `engines` reads it as its protocol's engine all the same.
        val rows = rows("""[{"slug":"cursor-api","runtime":"cursor","engines":["cursor"]},{"slug":"cursor-old","runtime":"cursor"}]""")
        assertEquals(listOf("cursor"), ProviderEngines.providerEngines("cursor-api", rows))
        assertEquals(listOf("cursor"), ProviderEngines.providerEngines("cursor-old", rows))
        assertEquals("cursor", ProviderEngines.nativeEngine("cursor"))
    }

    // What a client reads off the server's payloads (docs/provider-engine-contract.md §6.3).

    private fun rows(json: String) = Json.parseToJsonElement(json).jsonArray.map { it.jsonObject }

    /** A key runs where GET /providers says (`engines`, the server's answer: only it can tell a subscription token); an older
     * payload reads as its protocol's engine, plus OpenCode where `runsOnOpenCode` said so; a sign-in, OpenCode's own config and the
     * legacy built-in `dsh` need no row; anything else this account no longer has runs nowhere. */
    @Test fun aProviderRunsWhereTheServerSays() {
        val list = rows("""[{"slug":"deepseek","runtime":"claude","engines":["claude","opencode","dsh"]},
            {"slug":"claude-max","runtime":"claude","engines":["claude"]},
            {"slug":"old-openai","runtime":"codex","runsOnOpenCode":true},
            {"slug":"old-harness","runtime":"dsh"},
            {"slug":"pool","runtime":"codex","engines":["codex"],"pool":true}]""")
        assertEquals(listOf("claude", "opencode", "dsh"), ProviderEngines.providerEngines("deepseek", list))
        assertEquals(listOf("claude"), ProviderEngines.providerEngines("claude-max", list))
        assertEquals(listOf("codex", "opencode"), ProviderEngines.providerEngines("old-openai", list))
        assertEquals(listOf("dsh"), ProviderEngines.providerEngines("old-harness", list))
        assertEquals(listOf("codex"), ProviderEngines.providerEngines("pool", list))
        assertEquals(listOf("kimi"), ProviderEngines.providerEngines("kimi", list))
        assertEquals(listOf("opencode"), ProviderEngines.providerEngines("opencode", list))
        assertEquals(listOf("dsh"), ProviderEngines.providerEngines("dsh", list))
        assertEquals(emptyList<String>(), ProviderEngines.providerEngines("deleted", list))
        assertEquals(emptyList<String>(), ProviderEngines.providerEngines(null, list))
        // A session's engine is the one it recorded, which never changes; an unrecorded one's is its provider's default.
        assertEquals("dsh", ProviderEngines.sessionEngine("dsh", "deepseek", list))
        assertEquals("claude", ProviderEngines.sessionEngine(null, "deepseek", list))
        assertEquals("codex", ProviderEngines.sessionEngine("not-an-engine", "pool", list))
        assertEquals("claude", ProviderEngines.sessionEngine(null, "deleted", list))
    }

    /** An account pool read as a provider runs on its own engine alone, with that engine's catalogue as its models. */
    @Test fun aPoolRowRunsOnItsOwnEngine() {
        val own = ProviderEngines.poolRow(Json.parseToJsonElement("""{"slug":"claude-accounts","label":"Claude accounts"}""").jsonObject, "claude")
        val codex = ProviderEngines.poolRow(Json.parseToJsonElement("""{"slug":"chatgpt","engine":"codex"}""").jsonObject, "claude")
        assertEquals(listOf("claude"), ProviderEngines.providerEngines("claude-accounts", listOf(own)))
        assertEquals(listOf("codex"), ProviderEngines.providerEngines("chatgpt", listOf(codex)))
        assertEquals(true, own["pool"]?.jsonPrimitive?.boolean)
        assertEquals(true, own["modelsFromRuntime"]?.jsonPrimitive?.boolean)
    }

    // The shared sources, read back.

    private fun shared(file: String): String {
        val found = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.map { File(it, "src/shared/src/$file") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/$file was not found above the test's working directory", found)
        return found!!.readText()
    }

    @Test fun theEnginesAndTheirNamesAreTheSharedModulesOwn() {
        val source = shared("providerEngines.ts")
        val order = Regex("ALL_ENGINES: readonly AgentProvider\\[] = \\[(.*?)];", RegexOption.DOT_MATCHES_ALL).find(source)!!.groupValues[1]
        val enums = mapOf("CLAUDE" to "claude", "CODEX" to "codex", "KIMI" to "kimi", "ANTIGRAVITY" to "antigravity", "OPENCODE" to "opencode", "DSH" to "dsh",
            "CURSOR" to "cursor")
        assertEquals(Regex("AgentProvider\\.(\\w+)").findAll(order).map { enums.getValue(it.groupValues[1]) }.toList(), ProviderEngines.ALL_ENGINES)
        val names = Regex("\\[AgentProvider\\.(\\w+)]: '([^']+)'").findAll(source).associate { enums.getValue(it.groupValues[1]) to it.groupValues[2] }
        assertEquals(names, ProviderEngines.ENGINE_CLI_NAMES)
    }

    /** Each runtime's dialect is @orbit/shared `keyDialect`'s, its cases read back: a runtime added or moved there reds here. */
    @Test fun theKeyDialectsAreTheSharedModulesOwn() {
        val body = Regex("export function keyDialect\\([^)]*\\)[^{]*\\{(.*?)\\n}", RegexOption.DOT_MATCHES_ALL).find(shared("openCodeKeys.ts"))!!.groupValues[1]
        val dialects = mutableMapOf<String, String>()
        val waiting = mutableListOf<String>()
        Regex("case '([^']+)':|return '([^']+)';").findAll(body).forEach { match ->
            val (case, dialect) = match.destructured
            if (case.isNotEmpty()) waiting += case else { waiting.forEach { dialects[it] = dialect }; waiting.clear() }
        }
        assertEquals(setOf("claude", "dsh", "codex", "kimi", "antigravity", "cursor"), dialects.keys)
        dialects.forEach { (runtime, dialect) -> assertEquals(runtime, dialect, ProviderEngines.keyDialect(runtime)) }
    }

    /** Cursor CLI's modes and the one a session nobody named a mode for starts in are @orbit/shared `enums.ts`'s. */
    @Test fun cursorsPermissionModesAreTheSharedEnumsOwn() {
        val source = shared("enums.ts")
        val values = mapOf("DEFAULT" to "default", "AUTO" to "auto", "DONT_ASK" to "dontAsk", "ACCEPT_EDITS" to "acceptEdits", "PLAN" to "plan",
            "BYPASS" to "bypassPermissions")
        val modes = Regex("CURSOR_PERMISSION_MODES: readonly PermissionMode\\[] = \\[(.*?)];", RegexOption.DOT_MATCHES_ALL).find(source)!!.groupValues[1]
        assertEquals(Regex("PermissionMode\\.(\\w+)").findAll(modes).map { values.getValue(it.groupValues[1]) }.toList(), CursorRuntime.PERMISSION_MODES)
        val start = Regex("CURSOR_DEFAULT_PERMISSION_MODE = PermissionMode\\.(\\w+);").find(source)!!.groupValues[1]
        assertEquals(values.getValue(start), CursorRuntime.DEFAULT_PERMISSION_MODE)
    }

    @Test fun harnessesPermissionModesAreTheSharedEnumsOwn() {
        val source = shared("enums.ts")
        val modes = Regex("DSH_PERMISSION_MODES: readonly PermissionMode\\[] = \\[(.*?)];", RegexOption.DOT_MATCHES_ALL).find(source)!!.groupValues[1]
        val values = mapOf("DEFAULT" to "default", "AUTO" to "auto", "DONT_ASK" to "dontAsk", "ACCEPT_EDITS" to "acceptEdits", "PLAN" to "plan",
            "BYPASS" to "bypassPermissions")
        assertEquals(Regex("PermissionMode\\.(\\w+)").findAll(modes).map { values.getValue(it.groupValues[1]) }.toList(), ProviderEngines.DSH_PERMISSION_MODES)
    }
}
