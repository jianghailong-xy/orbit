package io.orbitd.android.composer

import io.orbitd.android.composer.ProviderEngines.Credential
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.management.Infrastructure
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.WorkspaceEffort
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * Cursor CLI, the seventh engine (project P1; @orbit/shared `cursor-engine.spec.ts`). The mirror knows it, so a session, a workspace or
 * a runner's report on it reads as what it is; and until P7c builds its screens no list of engines here offers it
 * (ProviderEngines.androidShowsEngine, web `webShowsEngine`): each list reads as it did before Cursor CLI was registered.
 */
class CursorEngineTest {
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private val now = Instant.parse("2026-10-17T09:00:00Z").toEpochMilli()

    private val claude = """{"engine":"claude","installed":true,"auth":"yes"}"""
    /** Cursor CLI as a runner reports it once it can (P3): installed, signed out, its updates failing for a fortnight. */
    private val cursor = """{"engine":"cursor","installed":true,"auth":"no","version":"2026.10.14-941492e",
        "update":{"status":"failed","at":"2026-10-17T08:30:00Z","okAt":"2026-10-01T00:00:00Z","latest":"2026.10.16-e3cb207",
          "behindSince":"2026-10-01T00:00:00Z"}}"""
    private fun runner(vararg engines: String) = obj("""{"id":"r","name":"hpc","displayName":"hpc","online":true,"status":"ONLINE",
        "lastHeartbeatAt":"2026-10-17T08:59:50Z","capabilities":["provider:cursor"],"engines":[${engines.joinToString(",")}],
        "modelCatalog":{"cursor":[{"value":"default[]","label":"Auto"}]}}""")
    /** A key that runs on Cursor CLI alone, as GET /providers would list one (P2). */
    private val cursorKey = obj("""{"slug":"cursor-key","label":"Cursor key","runtime":"cursor","engines":["cursor"],"enabled":true}""")
    private val glm = obj("""{"slug":"glm","label":"Z.AI (GLM)","runtime":"claude","presetSlug":"glm","engines":["claude","opencode"],"enabled":true}""")
    /** A workspace whose last session ran on this runner's Cursor CLI sign-in. */
    private val onCursor = obj("""{"id":"w","name":"orbit","lastProvider":"cursor","lastEngine":"cursor"}""")

    @Test fun aRunnerSignInToCursorRunsOnCursorAloneAndNoOtherCredentialRunsOnIt() {
        val login = Credential.Login("cursor")
        assertEquals(listOf("cursor"), ProviderEngines.credentialEngines(login))
        assertEquals("cursor", ProviderEngines.defaultEngineOf(login))
        assertTrue(ProviderEngines.isEngineCompatible("cursor", login))
        for (engine in ProviderEngines.ALL_ENGINES - "cursor") assertFalse(engine, ProviderEngines.isEngineCompatible(engine, login))
        val others: List<Credential> = listOf("claude", "codex", "kimi", "antigravity").map(Credential::Login) + listOf(Credential.Pool("claude"), Credential.Pool("codex"),
            Credential.OpenCode, Credential.Key("claude", "glm", "https://api.z.ai/api/anthropic"),
            Credential.Key("claude", "deepseek", "https://api.deepseek.com/anthropic"), Credential.Key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic"),
            Credential.Key("claude", "anthropic", "https://api.anthropic.com", subscriptionToken = true), Credential.Key("codex", "openai", "https://api.openai.com/v1"),
            Credential.Key("kimi", "moonshot", "https://api.moonshot.ai/v1"), Credential.Key("antigravity", "gemini", "https://generativelanguage.googleapis.com"))
        for (credential in others) {
            assertFalse("$credential", "cursor" in ProviderEngines.credentialEngines(credential))
            assertFalse("$credential", ProviderEngines.isEngineCompatible("cursor", credential))
        }
        // No key dialect is Cursor CLI's (its API key is P2's): a row on a `cursor` runtime runs nowhere.
        assertNull(ProviderEngines.keyDialect("cursor"))
        assertEquals(emptyList<String>(), ProviderEngines.credentialEngines(Credential.Key("cursor", null, "https://api2.cursor.sh")))
        for (near in listOf("Cursor", "cursor-cli", "cursor-agent", "agent", " cursor")) assertFalse(near, ProviderEngines.isEngine(near))
    }

    @Test fun cursorCliAloneIsNotDrawnYet() {
        assertFalse(ProviderEngines.androidShowsEngine("cursor"))
        assertEquals(listOf("claude", "codex", "kimi", "antigravity", "opencode", "dsh"), ProviderEngines.ALL_ENGINES.filter(ProviderEngines::androidShowsEngine))
    }

    /** A runner reporting Cursor CLI and a key that runs it change no list of engines: the New Session's, Infrastructure's cards, a
     * runner's Engines rows and both attention lists read as they do without them. */
    @Test fun noListOfEnginesOffersCursorCliThoughARunnerReportsItAndAKeyRunsIt() {
        val withCursor = runner(claude, cursor)
        val without = runner(claude)
        val catalog = ComposerCatalog(withCursor, listOf(cursorKey, glm))
        assertEquals(ComposerCatalog(without, listOf(glm)).engines(), catalog.engines())
        assertEquals(listOf("claude", "opencode"), catalog.engines().map { it.engine })
        assertEquals(listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"),
            Infrastructure.engineCards(listOf(withCursor), listOf(cursorKey, glm), emptyList()).map { it.name })
        assertEquals(Infrastructure.engineCards(listOf(without), listOf(glm), emptyList()),
            Infrastructure.engineCards(listOf(withCursor), listOf(cursorKey, glm), emptyList()))
        // A runner's rows: its report of Cursor CLI is not drawn, while an engine this build doesn't know yet still is, after the rest.
        fun rows(runner: JsonObject) = RunnerPage.engines(runner).map { it["engine"]!!.jsonPrimitive.content }
        assertEquals(listOf("claude", "antigravity"), rows(withCursor))
        assertEquals(listOf("claude", "antigravity", "next-cli"), rows(runner(cursor, claude, """{"engine":"next-cli","installed":true}""")))
        // Neither attention list raises Cursor CLI: not its failing updates, nor its sign-in out under a workspace that runs on it.
        val items = RunnerPage.attention(withCursor, listOf(onCursor), now, latestVersion = null)
        assertEquals(RunnerPage.attention(without, listOf(onCursor), now, latestVersion = null), items)
        assertTrue(items.none { "Cursor" in it.short + it.title + it.detail })
        assertEquals(emptyList<Infrastructure.Attention>(), Infrastructure.attention(listOf(withCursor), emptyList(), emptyList(), now))
    }

    /** What the server says of Cursor CLI decodes as what it is: a session's own engine, never another's; a workspace's form as it read
     * before; and the refusal that now names seven engines. */
    @Test fun aSessionAWorkspaceAndARefusalOnCursorReadAsCursorCli() {
        val catalog = ComposerCatalog(runner(claude, cursor), listOf(cursorKey, glm))
        assertEquals("cursor", catalog.engineOf(obj("""{"id":"s","engine":"cursor","provider":"cursor","model":"default[]"}""")))
        assertEquals("cursor", ProviderEngines.sessionEngine("cursor", "cursor", listOf(cursorKey)))
        assertEquals("cursor", ProviderEngines.sessionEngine("cursor", "cursor-key", listOf(cursorKey)))
        assertEquals(listOf("cursor"), ProviderEngines.providerEngines("cursor-key", listOf(cursorKey)))
        assertEquals("Cursor CLI", ProviderEngines.cliName("cursor"))
        // A workspace that last ran on it offers the efforts it offered before Cursor CLI was an engine here (Claude Code's).
        val engine = ProviderEngines.sessionEngine(onCursor["lastEngine"]?.jsonPrimitive?.content, "cursor", emptyList())
        assertEquals("cursor", engine)
        assertEquals(WorkspaceEffort.options("claude", null), WorkspaceEffort.options(engine, runner(claude, cursor)))
        assertEquals("high", WorkspaceEffort.normalize("high", engine))
        val message = "engine \"gpt\" is not one of claude, codex, kimi, antigravity, opencode, dsh, cursor"
        val refusal = ApiError.parse(400, """{"statusCode":400,"code":"ENGINE_UNKNOWN","message":${JsonPrimitive(message)}}""".encodeToByteArray())
        assertEquals("ENGINE_UNKNOWN", refusal.code)
        assertEquals(listOf(message), refusal.messages)
    }
}
