package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The composer on Cursor CLI (the owner's board, iOS 1, 5 and 6; web P7a's `sessionProviderChoices` and `workspaceDefaults`): the Engine
 * list's row and the four ways a runner can't run it, its credentials — its own sign-in and its accounts, Cursor keys — Auto and the
 * catalogue with Effort, Context and Speed, the modes it keeps, and the slash commands that are its own.
 */
class CursorComposerTest {
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private val opus = """{"value":"claude-opus-5-5","label":"Claude Opus 5.5","reasoningLevels":["low","medium","high","xhigh","max"],
        "defaultReasoningLevel":"medium","parameters":[
          {"id":"context","label":"Context","category":"model_config","default":"300k","values":[{"value":"300k","label":"300K"},{"value":"1m","label":"1M"}]},
          {"id":"effort","label":"Effort","category":"thought_level","default":"medium","values":[{"value":"low","label":"Low"},{"value":"high","label":"High"}]},
          {"id":"fast","label":"Fast","category":"model_config","default":"false","values":[{"value":"false","label":"Off"},{"value":"true","label":"Fast"}]}]}"""
    private val catalogue = """"modelCatalog":{"cursor":[{"value":"default","label":"Auto"},$opus]}"""
    private val signedIn = """{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes",
        "accounts":[{"id":"default","auth":"yes","home":"/root/.orbit/cursor/default"},{"id":"5c2e91a0","name":"Team","auth":"yes","home":"/root/.orbit/cursor-accounts/5c2e91a0"}]}"""
    private val usage = """"planUsage":{"cursor":{"provider":"cursor","account":"default","planName":"Free",
        "includedUsage":{"startsAt":"2026-09-24T16:32:26.082Z","resetsAt":"2099-10-24T16:32:26.082Z"},
        "accounts":{"5c2e91a0":{"provider":"cursor","account":"5c2e91a0","planName":"Pro",
          "includedUsage":{"period":"monthly","startsAt":"2026-10-03T00:00:00Z","resetsAt":"2099-11-03T00:00:00Z","percentUsed":34}}}}}"""
    private fun runner(cursor: String? = signedIn, capabilities: String = "\"provider:cursor\",\"cursor-account-login/v1\"", extra: String = ",$catalogue,$usage") =
        obj("""{"id":"r","name":"hpc","displayName":"hpc","capabilities":[$capabilities],"engines":[${cursor ?: ""}]$extra}""")
    private val cursorKey = obj("""{"slug":"cursor-api","label":"Cursor","runtime":"cursor","presetSlug":"cursor-api","engines":["cursor"],"modelsFromRuntime":true,"models":[]}""")
    private val glm = obj("""{"slug":"glm","label":"Z.AI (GLM)","runtime":"claude","presetSlug":"glm","engines":["claude","opencode"]}""")
    private fun cursorRow(catalog: ComposerCatalog) = catalog.engines().first { it.engine == "cursor" }

    /** iOS 1: Cursor CLI's row says Auto where it can run, and otherwise why not, the way every engine's does: the reason, then the way to
     * the runner's page for it — ", sign in →" for a sign-in. A Cursor key still needs the runner to run the pinned build. */
    @Test fun theEngineRowSaysAutoOrWhyItCantRunHere() {
        val ready = ComposerCatalog(runner(), listOf(glm))
        assertEquals("Auto", cursorRow(ready).let { ready.modelLabel("cursor", it.landing!!.id, ready.defaultModel("cursor", it.landing.id)) })
        assertNull(cursorRow(ready).unavailable)
        fun why(catalog: ComposerCatalog) = cursorRow(catalog).let { it.unavailable + ProviderChoices.fixSuffix(it.fixEngine, it.unavailable) }
        assertEquals("Not installed →", why(ComposerCatalog(runner("""{"engine":"cursor","installed":false}"""), listOf(glm))))
        assertEquals("Not signed in, sign in →", why(ComposerCatalog(runner("""{"engine":"cursor","installed":true,"auth":"no"}"""), listOf(glm))))
        // A runner that predates Cursor CLI, in view beside one that knows it: listed, greyed, and the update is what fixes it.
        val older = runner(cursor = null, capabilities = "")
        assertEquals("Update runner →", why(ComposerCatalog(older, listOf(glm), fleet = listOf(older, runner()))))
        assertEquals("Unsupported version →", why(ComposerCatalog(runner("""{"engine":"cursor","installed":true,"version":"2026.10.16-e3cb207",
            "installationError":"CURSOR_VERSION_INCOMPATIBLE: x"}""", capabilities = ""), listOf(glm))))
        // With nothing of the account's knowing it, the row is not there at all.
        assertFalse(ComposerCatalog(older, listOf(glm)).engines().any { it.engine == "cursor" })
        // A key brings its own credential, but not the pinned build: on a runner that predates Cursor CLI it waits with the sign-in.
        val keyOnOlder = ComposerCatalog(older, listOf(cursorKey), fleet = listOf(older, runner())).credentials("cursor")
        assertEquals(listOf("cursor" to "Update runner", "cursor-api" to "Update runner"), keyOnOlder.map { it.id to it.unavailable })
    }

    @Test fun itsCredentialsAreItsOwnSignInItsAccountsAndCursorKeys() {
        val catalog = ComposerCatalog(runner(), listOf(glm, cursorKey))
        assertEquals(listOf("cursor" to CredentialKind.LOGIN, "cursor-api" to CredentialKind.KEY), catalog.credentials("cursor").map { it.id to it.kind })
        // Each account with its own included usage: Team's month a reading, Default's none (Free: Cursor reports no share).
        assertEquals(listOf(AccountChoice("default", "Default"), AccountChoice("5c2e91a0", "Team", "Monthly 34%")), catalog.accountChoices("cursor"))
        // A Cursor CLI account a turn met the limit on is spent, which no reading says.
        val spent = ComposerCatalog(runner(extra = ",$catalogue," + usage.replace(""""percentUsed":34""", """"percentUsed":34,"limitReachedAt":"2026-10-18T09:00:00Z"""")), listOf(glm))
        assertEquals(AccountChoice("5c2e91a0", "Team", "Spent", nearLimit = true), spent.accountChoices("cursor").last())
        // A session on the sign-in left to Orbit is on Automatic — listed for every Cursor CLI session, whether or not it may still move.
        val session = obj("""{"id":"s","engine":"cursor","provider":"cursor","numTurns":3,"workspace":{"id":"w"}}""")
        val login = catalog.current("cursor", "cursor")
        assertEquals("Automatic", catalog.providerValue(login, "cursor", session, JsonObject(emptyMap()), draft = false))
        assertEquals("cursor-account-move/v1", io.orbitd.android.management.EngineAccounts.moveCapability("cursor"))
        assertFalse(catalog.movesAccounts("cursor"))
        // A Cursor key says which vendor's it is in a sentence.
        assertEquals("the Cursor key “Cursor”", ProviderEngines.keyName(cursorKey))
    }

    /** iOS 5 ①②③: Auto first, then the catalogue, each model with the efforts it takes by its own values — Auto none. Until a runner
     * reports a catalogue, Auto is the one choice, by naming no model; once it does, Auto is its own row (`default`). */
    @Test fun autoThenTheCatalogueWithEachModelsOwnEfforts() {
        val bare = ComposerCatalog(runner(extra = ""), listOf(glm))
        assertEquals(listOf("" to "Auto"), bare.models("cursor", "cursor").map { it["value"]!!.jsonPrimitive.content to it["label"]!!.jsonPrimitive.content })
        assertEquals("", bare.defaultModel("cursor", "cursor"))
        assertEquals("Auto", bare.modelLabel("cursor", "cursor", ""))
        val catalog = ComposerCatalog(runner(), listOf(glm, cursorKey))
        assertEquals(listOf("default", "claude-opus-5-5"), catalog.models("cursor", "cursor").map { it["value"]!!.jsonPrimitive.content })
        // A Cursor key's models are the same catalogue: Cursor CLI's on the machine, whichever credential it spends.
        assertEquals(catalog.models("cursor", "cursor"), catalog.models("cursor", "cursor-api"))
        assertEquals("default", catalog.defaultModel("cursor", "cursor"))
        assertEquals("Auto", catalog.modelLabel("cursor", "cursor", "default"))
        assertEquals("Claude Opus 5.5", catalog.modelLabel("cursor", "cursor", "claude-opus-5-5[context=1m]"))
        assertEquals(emptyList<String>(), catalog.efforts("cursor", "cursor", "default"))
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), catalog.efforts("cursor", "cursor", "claude-opus-5-5[fast=true]"))
        assertFalse(catalog.fast("cursor", "cursor", "claude-opus-5-5"))
        // A runner that names its own default model starts a session there.
        val named = ComposerCatalog(runner(extra = ",$catalogue,\"runtimeDefaultModels\":{\"cursor\":\"claude-opus-5-5\"}"), listOf(glm))
        assertEquals("claude-opus-5-5", named.defaultModel("cursor", "cursor"))
        // A model picked last for the pair is the next session's while the runner still offers it, its parameters with it.
        assertEquals("claude-opus-5-5[context=1m]",
            catalog.newSessionModel("cursor", "cursor", mapOf("cursor:cursor" to "claude-opus-5-5[context=1m]")))
        assertEquals("default", catalog.newSessionModel("cursor", "cursor", mapOf("cursor:cursor" to "retired-model")))
    }

    /** The coordinator's convention (2026-10-18): a model's context and speed travel in the model value, as Cursor writes them; a
     * value at the model's own default is left out, so a model on every default is its bare name; Auto carries none. */
    @Test fun contextAndSpeedTravelInTheModelValue() {
        val row = obj(opus)
        assertEquals("claude-opus-5-5", CursorRuntime.modelBase("claude-opus-5-5[context=1m,fast=true]"))
        assertEquals(mapOf("context" to "1m", "fast" to "true"), CursorRuntime.modelParameters("claude-opus-5-5[context=1m,fast=true]"))
        assertEquals(emptyMap<String, String>(), CursorRuntime.modelParameters("claude-opus-5-5"))
        assertEquals("claude-opus-5-5[context=1m,fast=true]", CursorRuntime.withParameters("claude-opus-5-5", mapOf("fast" to "true", "context" to "1m"), row))
        assertEquals("claude-opus-5-5[fast=true]", CursorRuntime.withParameters("claude-opus-5-5", mapOf("context" to "300k", "fast" to "true"), row))
        assertEquals("claude-opus-5-5", CursorRuntime.withParameters("claude-opus-5-5", mapOf("context" to "300k", "fast" to "false"), row))
        // The chip's words after the name: a context set away from its default, and Fast while the lane is on.
        assertEquals(listOf("1M", "Fast"), CursorRuntime.chipParameters("claude-opus-5-5[context=1m,fast=true]", row))
        assertEquals(emptyList<String>(), CursorRuntime.chipParameters("claude-opus-5-5", row))
        // The name the chip and the context sheet give it: the catalogue's, the effort set on it, then those words — never the brackets.
        val catalog = ComposerCatalog(runner(), emptyList())
        assertEquals("Claude Opus 5.5 High · 1M · Fast", CursorRuntime.modelName(catalog, "cursor", "claude-opus-5-5[context=1m,fast=true]", "high"))
        assertEquals("Claude Opus 5.5", CursorRuntime.modelName(catalog, "cursor", "claude-opus-5-5", ""))
        assertEquals("Auto", CursorRuntime.modelName(catalog, "cursor", "default", ""))
        assertEquals("claude-opus-5-5", CursorRuntime.modelName(null, "cursor", "claude-opus-5-5[context=1m]", null))
        assertEquals(listOf("300K", "1M"), CursorRuntime.values(CursorRuntime.parameter(row, "context")!!).map { CursorRuntime.valueLabel(CursorRuntime.parameter(row, "context")!!, it) })
        assertEquals(listOf("Standard", "Fast"), CursorRuntime.values(CursorRuntime.parameter(row, "fast")!!).map { CursorRuntime.speedLabel(CursorRuntime.parameter(row, "fast")!!, it) })
        assertTrue(CursorRuntime.onAuto("cursor", "default"))
        assertNull(CursorRuntime.parameter(obj("""{"value":"default","label":"Auto"}"""), "context"))
    }

    /** iOS 6 ①: every mode but Default, which the server refuses on Cursor CLI (D6); Bypass goes on a root runner, as on every engine. */
    @Test fun itKeepsEveryModeButDefault() {
        val catalog = ComposerCatalog(runner(), emptyList())
        assertEquals(listOf("acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"), catalog.permissions("cursor", "cursor", "default"))
        val root = ComposerCatalog(runner(extra = ",$catalogue,\"runsAsRoot\":true"), emptyList())
        assertEquals(listOf("acceptEdits", "plan", "auto", "dontAsk"), root.permissions("cursor", "cursor", "claude-opus-5-5"))
    }

    /** Cursor CLI lists its own slash commands, which the runner reports tagged with the engine; Claude Code's are not its. */
    @Test fun aCursorSessionListsCursorsOwnSlashCommands() {
        val catalog = ComposerCatalog(runner(extra = ",\"commands\":[{\"name\":\"plan\",\"type\":\"command\",\"provider\":\"cursor\"}," +
            "{\"name\":\"review\",\"type\":\"command\",\"provider\":\"claude\"},{\"name\":\"init\",\"type\":\"command\"}]"), emptyList())
        assertEquals(listOf("plan"), catalog.slashItems("cursor", null).map { it["name"]!!.jsonPrimitive.content })
        assertEquals(listOf("init", "review"), catalog.slashItems("claude", null).map { it["name"]!!.jsonPrimitive.content })
    }
}
