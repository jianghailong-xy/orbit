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
 * Cursor CLI, the seventh engine (projects P1, P7c; @orbit/shared `cursor-engine.spec.ts`). The mirror knows it, so a session, a
 * workspace or a runner's report on it reads as what it is; and every list of engines here offers it once a runner of the account knows
 * it (ProviderEngines.androidShowsEngine, web `webShowsEngine`) — the order its rollout keeps (P9): the runners first, then the entrances.
 * Until one does, each list reads as it did before Cursor CLI was registered.
 */
class CursorEngineTest {
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private val now = Instant.parse("2026-10-17T09:00:00Z").toEpochMilli()

    private val claude = """{"engine":"claude","installed":true,"auth":"yes"}"""
    /** Cursor CLI as a runner reports it once it can (P3): installed, signed out, its updates failing for a fortnight. */
    private val cursor = """{"engine":"cursor","installed":true,"auth":"no","version":"2026.10.14-941492e",
        "update":{"status":"failed","at":"2026-10-17T08:30:00Z","okAt":"2026-10-01T00:00:00Z","latest":"2026.10.16-e3cb207",
          "behindSince":"2026-10-01T00:00:00Z"}}"""
    private fun runner(vararg engines: String, capabilities: String = "\"provider:cursor\"") = obj("""{"id":"r","name":"hpc","displayName":"hpc","online":true,
        "status":"ONLINE","lastHeartbeatAt":"2026-10-17T08:59:50Z","capabilities":[$capabilities],"engines":[${engines.joinToString(",")}],
        "modelCatalog":{"cursor":[{"value":"default","label":"Auto"}]}}""")
    /** A runner that predates Cursor CLI: it neither declares it nor reports it. */
    private fun older(vararg engines: String) = runner(*engines, capabilities = "")
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
        // Cursor's own dialect is its User API Key's (P2): such a key runs on Cursor CLI alone, from the preset or typed in by hand.
        assertEquals("cursor", ProviderEngines.keyDialect("cursor"))
        assertEquals(listOf("cursor"), ProviderEngines.credentialEngines(Credential.Key("cursor", null, "https://api2.cursor.sh")))
        for (near in listOf("Cursor", "cursor-cli", "cursor-agent", "agent", " cursor")) assertFalse(near, ProviderEngines.isEngine(near))
    }

    /** Every engine but Cursor CLI is always drawn; Cursor CLI once a runner in view declares `provider:cursor` or reports the engine. */
    @Test fun cursorCliIsDrawnOnceARunnerKnowsIt() {
        for (none in listOf(null, emptyList(), listOf(older(claude)))) {
            assertFalse("$none", ProviderEngines.androidShowsEngine("cursor", none))
            assertEquals(listOf("claude", "codex", "kimi", "antigravity", "opencode", "dsh"),
                ProviderEngines.ALL_ENGINES.filter { ProviderEngines.androidShowsEngine(it, none) })
        }
        // Declared, reported, or both — one runner of the account is enough.
        assertTrue(ProviderEngines.androidShowsEngine("cursor", listOf(runner(claude))))
        assertTrue(ProviderEngines.androidShowsEngine("cursor", listOf(older(claude, cursor))))
        assertTrue(ProviderEngines.androidShowsEngine("cursor", listOf(older(claude), runner(claude))))
        assertEquals(ProviderEngines.ALL_ENGINES, ProviderEngines.ALL_ENGINES.filter { ProviderEngines.androidShowsEngine(it, listOf(runner(claude, cursor))) })
    }

    /** While no runner knows Cursor CLI, a key that runs it changes no list of engines: the New Session's, a runner's Engines rows and both
     * attention lists read as they do without it. */
    @Test fun noListOffersCursorCliWhileNoRunnerKnowsIt() {
        val without = older(claude)
        val catalog = ComposerCatalog(without, listOf(cursorKey, glm))
        assertEquals(ComposerCatalog(without, listOf(glm)).engines(), catalog.engines())
        assertEquals(listOf("claude", "opencode"), catalog.engines().map { it.engine })
        fun rows(runner: JsonObject, fleet: List<JsonObject>? = null) = RunnerPage.engines(runner, fleet).map { it["engine"]!!.jsonPrimitive.content }
        assertEquals(listOf("claude", "antigravity"), rows(without))
        // An engine this build doesn't know yet is still drawn, after the rest.
        assertEquals(listOf("claude", "antigravity", "next-cli"), rows(older(claude, """{"engine":"next-cli","installed":true}""")))
        assertEquals(emptyList<Infrastructure.Attention>(), Infrastructure.attention(listOf(without), emptyList(), emptyList(), emptyList(), now))
        assertEquals("1 of 3 signed in", Infrastructure.summary(without, now))
    }

    /** Once one does, every list offers it: last among the engines, on a machine that predates it too — whose row says it needs an
     * update — and its sign-in, signed out under a workspace that runs on it, is raised as any engine's is. */
    @Test fun everyListOffersCursorCliOnceARunnerKnowsIt() {
        val withCursor = runner(claude, cursor)
        val catalog = ComposerCatalog(withCursor, listOf(cursorKey, glm))
        assertEquals(listOf("claude", "opencode", "cursor"), catalog.engines().map { it.engine })
        assertEquals("Cursor CLI", catalog.engines().last().label)
        fun rows(runner: JsonObject, fleet: List<JsonObject>? = null) = RunnerPage.engines(runner, fleet).map { it["engine"]!!.jsonPrimitive.content }
        assertEquals(listOf("claude", "antigravity", "cursor"), rows(withCursor))
        // A machine that predates it has a row too, with the fleet in view: nothing reported, so it says to update the runner.
        assertEquals(listOf("claude", "antigravity", "cursor"), rows(older(claude), listOf(older(claude), withCursor)))
        assertEquals("Update runner" to "warn", RunnerPage.engineStatus(RunnerPage.engines(older(claude), listOf(withCursor)).last(), older(claude)))
        // Signed out under a workspace that runs on it: the runner page raises it — Infrastructure's Needs you does not, as the web's
        // machine card draws it nothing.
        val items = RunnerPage.attention(withCursor, listOf(onCursor), now, latestVersion = null)
        assertEquals(listOf("Cursor CLI signed out"), items.filter { it.kind == "engineSignedOut" }.map { it.short })
        assertEquals(emptyList<Infrastructure.Attention>(), Infrastructure.attention(listOf(withCursor), emptyList(), emptyList(), emptyList(), now))
        // Cursor CLI's update note is the pinned build's: a fortnight behind the release it doesn't follow is still worth a person.
        assertTrue(items.any { it.kind == "engineNotUpdating" && it.short == "Cursor CLI update failed" })
    }

    /** What the server says of Cursor CLI decodes as what it is: a session's own engine, never another's; a workspace's efforts its
     * catalogue's; and the refusal that names seven engines. */
    @Test fun aSessionAWorkspaceAndARefusalOnCursorReadAsCursorCli() {
        val catalog = ComposerCatalog(runner(claude, cursor), listOf(cursorKey, glm))
        assertEquals("cursor", catalog.engineOf(obj("""{"id":"s","engine":"cursor","provider":"cursor","model":"default"}""")))
        assertEquals("cursor", ProviderEngines.sessionEngine("cursor", "cursor", listOf(cursorKey)))
        assertEquals("cursor", ProviderEngines.sessionEngine("cursor", "cursor-key", listOf(cursorKey)))
        assertEquals(listOf("cursor"), ProviderEngines.providerEngines("cursor-key", listOf(cursorKey)))
        assertEquals(listOf("cursor"), ProviderEngines.providerEngines("cursor", listOf(cursorKey)))
        assertEquals("Cursor CLI", ProviderEngines.cliName("cursor"))
        // A workspace that last ran on it offers its catalogue's efforts for its default model — Auto's none, so Default alone.
        val engine = ProviderEngines.sessionEngine(onCursor["lastEngine"]?.jsonPrimitive?.content, "cursor", emptyList())
        assertEquals("cursor", engine)
        assertEquals(listOf(""), WorkspaceEffort.options(engine, runner(claude, cursor)))
        val opus = obj("""{"id":"r","runtimeDefaultModels":{"cursor":"claude-opus-5-5"},
            "modelCatalog":{"cursor":[{"value":"claude-opus-5-5","label":"Claude Opus 5.5","reasoningLevels":["low","medium","high","xhigh","max"]}]}}""")
        assertEquals(listOf("", "low", "medium", "high", "xhigh", "max"), WorkspaceEffort.options(engine, opus))
        val message = "engine \"gpt\" is not one of claude, codex, kimi, antigravity, opencode, dsh, cursor"
        val refusal = ApiError.parse(400, """{"statusCode":400,"code":"ENGINE_UNKNOWN","message":${JsonPrimitive(message)}}""".encodeToByteArray())
        assertEquals("ENGINE_UNKNOWN", refusal.code)
        assertEquals(listOf(message), refusal.messages)
    }
}
