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

    /** A model's context and speed travel in the model value by shared cursorModels.ts's rules (iOS 8629bebf3; the shared spec's own
     * cases are CursorModelVariantsSpecTest's): a value at the model's own default is left out, so a model on every default is its bare
     * name; Auto carries none; anything not written as a variant is a model name as it stands. */
    @Test fun contextAndSpeedTravelInTheModelValue() {
        val row = obj(opus)
        assertEquals(CursorRuntime.Variant("claude-opus-5-5", mapOf("context" to "1m", "fast" to "true")),
            CursorRuntime.decodeModel("claude-opus-5-5[context=1m,fast=true]"))
        assertEquals(CursorRuntime.Variant("claude-opus-5-5", emptyMap()), CursorRuntime.decodeModel("claude-opus-5-5"))
        // Read strictly: no `default[...]` is Auto, and a repeated or malformed setting makes the whole value a name.
        assertEquals(CursorRuntime.Variant("default[]", emptyMap()), CursorRuntime.decodeModel("default[]"))
        assertEquals(CursorRuntime.Variant("claude-opus-5-5[context=1m,context=300k]", emptyMap()),
            CursorRuntime.decodeModel("claude-opus-5-5[context=1m,context=300k]"))
        assertFalse(CursorRuntime.onAuto("cursor", "default[]"))
        assertTrue(CursorRuntime.onAuto("cursor", " default "))
        // Written in the order of the ids, and without what is the model's own.
        assertEquals("claude-opus-5-5[context=1m,fast=true]", CursorRuntime.encodeModel("claude-opus-5-5", mapOf("fast" to "true", "context" to "1m"), row))
        assertEquals("claude-opus-5-5[fast=true]", CursorRuntime.encodeModel("claude-opus-5-5", mapOf("context" to "300k", "fast" to "true"), row))
        assertEquals("claude-opus-5-5", CursorRuntime.encodeModel("claude-opus-5-5", mapOf("context" to "300k", "fast" to "false"), row))
        assertEquals("default", CursorRuntime.encodeModel("default", mapOf("fast" to "true"), row))

        // The menu's rows and the chip's words after the effort (web cursorSettingRows, cursorChipSettings).
        val catalog = ComposerCatalog(runner(), emptyList())
        val pick = CursorRuntime.pick("claude-opus-5-5[context=1m,fast=true]", catalog)
        assertEquals(CursorRuntime.Pick("claude-opus-5-5", row, mapOf("context" to "1m", "fast" to "true")), pick)
        val rows = CursorRuntime.settingRows(pick)
        assertEquals(listOf("Context" to "1M", "Speed" to "Fast"), rows.map { it.title to it.label })
        assertEquals(listOf("300k" to "300K", "1m" to "1M"), rows[0].values)
        assertEquals(listOf("false" to "Standard", "true" to "Fast"), rows[1].values)
        assertEquals(listOf("1M", "Fast"), CursorRuntime.chipSettings(rows))
        assertEquals(emptyList<String>(), CursorRuntime.chipSettings(CursorRuntime.settingRows(CursorRuntime.pick("claude-opus-5-5", catalog))))
        // A value the model doesn't offer reads as the model's own: the menu ticks 300K and the chip says nothing of it.
        val unoffered = CursorRuntime.settingRows(CursorRuntime.pick("claude-opus-5-5[context=2m]", catalog))
        assertEquals("300k", unoffered[0].value)
        assertEquals(emptyList<String>(), CursorRuntime.chipSettings(unoffered))
        assertEquals("Claude Opus 5.5 High", CursorRuntime.modelName(catalog, "cursor", "claude-opus-5-5[context=2m]", "high"))
        assertEquals(emptyList<CursorRuntime.SettingRow>(), CursorRuntime.settingRows(CursorRuntime.pick("default", catalog)))

        // The name the chip and the context sheet give it: the catalogue's, the effort set on it, then those words — never the brackets.
        assertEquals("Claude Opus 5.5 High · 1M · Fast", CursorRuntime.modelName(catalog, "cursor", "claude-opus-5-5[context=1m,fast=true]", "high"))
        assertEquals("Claude Opus 5.5", CursorRuntime.modelName(catalog, "cursor", "claude-opus-5-5", ""))
        assertEquals("Auto", CursorRuntime.modelName(catalog, "cursor", "default", ""))
        assertEquals("claude-opus-5-5", CursorRuntime.modelName(null, "cursor", "claude-opus-5-5[context=1m]", null))
        // Aloud, the effort once (iOS `chipAccessibilityLabel`), and Auto, which has none, by its name alone.
        assertEquals("Model Claude Opus 5.5, effort High, 1M, Fast", CursorRuntime.spokenName(catalog, "cursor", "claude-opus-5-5[context=1m,fast=true]", "high"))
        assertEquals("Model Claude Opus 5.5, effort Default", CursorRuntime.spokenName(catalog, "cursor", "claude-opus-5-5", null))
        assertEquals("Model Auto", CursorRuntime.spokenName(catalog, "cursor", "default", ""))
    }

    /** A value the catalogue lists as it stands is a model of its own (shared `runnerCatalogRow`, web `cursorModelPick`): its row is found
     * by the whole value before the model it names, and it names no settings. Another engine's brackets are its own ids. */
    @Test fun aRowIsTheValuesOwnBeforeItsModels() {
        val own = """{"value":"gpt-5.5[fast=true]","label":"GPT-5.5 Fast"}"""
        val catalog = ComposerCatalog(runner(extra = ""","modelCatalog":{"cursor":[{"value":"default","label":"Auto"},{"value":"gpt-5.5","label":"GPT-5.5"},$own],
            "claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}"""), emptyList())
        assertEquals(CursorRuntime.Pick("gpt-5.5[fast=true]", obj(own), emptyMap()), CursorRuntime.pick("gpt-5.5[fast=true]", catalog))
        assertEquals("GPT-5.5 Fast", catalog.modelLabel("cursor", "cursor", "gpt-5.5[fast=true]"))
        assertEquals("GPT-5.5", catalog.modelLabel("cursor", "cursor", "gpt-5.5[context=272k]"))
        assertNull(catalog.modelRow("cursor", "cursor", "gemini-3.1-pro[fast=true]"))
        assertNull(catalog.modelRow("claude", "claude", "claude-opus-5-5[context=1m]"))
        // A variant remembered for the next session is live while its model is.
        assertEquals("gpt-5.5[context=272k]", catalog.newSessionModel("cursor", "cursor", mapOf("cursor:cursor" to "gpt-5.5[context=272k]")))
        assertEquals("default", catalog.newSessionModel("cursor", "cursor", mapOf("cursor:cursor" to "grok-9[fast=true]")))
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
