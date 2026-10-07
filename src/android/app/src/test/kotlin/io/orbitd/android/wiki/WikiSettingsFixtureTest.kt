package io.orbitd.android.wiki

import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.DirectoryRunner
import io.orbitd.android.directory.DirectoryWorkspace
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiReviewModeCopyParityTests`, the settings page's fixture half (`src/shared/src/wiki-review-mode.fixture.json`,
 * which the web's `lib/wikiReviewMode.test.ts` reads too) and its contract check — and what the settings page writes:
 * the PATCH bodies of a mode, the spot checks, Turn off and Set up, with the look-back's three ways to be written. */
class WikiSettingsFixtureTest {
    private val settings get() = WikiFixtures.reviewMode.obj("settings")

    @Test fun theSettingsPageSaysTheFixturesWordsInItsOrder() {
        val settings = settings
        assertEquals(settings.str("title"), WikiModeCopy.settingsTitle)
        assertEquals(settings.str("crumb"), WikiModeCopy.settings)
        assertEquals(settings.strings("sections"), WikiModeLogic.SettingsSection.entries.map { it.title })
        assertEquals(settings.str("reviewModeHint"), WikiModeCopy.reviewModeHint)
        assertEquals(settings.str("lead"), WikiModeCopy.reviewModeLead)
        assertEquals(settings.str("defaultTag"), WikiModeCopy.modeDefault)
        val modes = settings.arr("modes").map { it.jsonObject }
        assertEquals(modes.map { it.str("mode") }, WikiModeLogic.modes)
        modes.forEach { mode ->
            assertEquals(mode.str("label"), WikiModeCopy.modeLabel(mode.str("mode")))
            assertEquals(mode.str("note"), WikiModeCopy.modeNote(mode.str("mode")))
            assertEquals(mode["default"].bool(), mode.str("mode") == WikiModeLogic.defaultMode)
        }
        assertEquals(settings.obj("spotCheck").str("title"), WikiModeCopy.spotCheck)
        assertEquals(settings.obj("spotCheck").str("note"), WikiModeCopy.spotCheckNote)
        assertEquals(settings.obj("floors").str("lead"), WikiModeCopy.floorsLead)
        assertEquals(settings.obj("floors").str("note"), WikiModeCopy.floorsNote)

        val maintenance = settings.obj("maintenance")
        assertEquals(listOf(maintenance.str("name"), maintenance.str("note"), maintenance.str("off"), maintenance.str("on"), maintenance.str("setUp")),
            listOf(WikiModeCopy.maintenanceName, WikiModeCopy.maintenanceNote, WikiModeCopy.off, WikiModeCopy.on, WikiModeCopy.setUp))
        val form = maintenance.obj("form")
        assertEquals(form.str("title"), WikiModeCopy.setUpTitle)
        assertEquals(form.arr("fields").map { it.jsonObject.str("label") },
            listOf(WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        assertEquals(form.arr("fields").map { it.jsonObject.str("note") },
            listOf(WikiModeCopy.workspaceNote, WikiModeCopy.providerNote, WikiModeCopy.dailyLimitNote, WikiModeCopy.lookbackNote))
        assertEquals(form.str("unit"), WikiModeCopy.runsADayUnit)
        assertEquals(listOf(form.str("cancel"), form.str("turnOn"), form.str("save")), listOf(WikiModeCopy.cancel, WikiModeCopy.turnOn, WikiModeCopy.save))
        val defaults = form.obj("defaults")
        assertEquals(defaults.str("provider"), WikiMaintenanceSettings.default.provider)
        assertEquals(defaults.int("dailyRunLimit"), WikiMaintenanceSettings.default.dailyRunLimit)
        assertEquals(defaults.int("min")..defaults.int("max"), WikiMaintenanceSettings.dailyRunLimitRange)
        assertEquals(maintenance.strings("rows"),
            listOf(WikiModeCopy.status, WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        assertEquals(listOf(maintenance.str("edit"), maintenance.str("turnOff")), listOf(WikiModeCopy.maintenanceEdit, WikiModeCopy.turnOff))
        maintenance.arr("runsADay").map { it.jsonObject }.forEach { assertEquals(it.str("says"), WikiModeCopy.runsADay(it.int("runs"))) }
        // The look-back: from now on, some days, all of history — the form opening on the contract's 14 days.
        val lookback = form.obj("lookback")
        assertEquals(lookback.strings("choices"), WikiModeLogic.LookbackChoice.entries.map { it.name.lowercase() })
        assertEquals(lookback.strings("says"), WikiModeLogic.LookbackChoice.entries.map {
            WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays(it, lookback.int("defaultDays"))) })
        assertEquals(lookback.str("unit"), WikiModeCopy.lookbackUnit)
        assertEquals(lookback.int("defaultDays"), WikiMaintenanceSettings.default.lookbackDays)
        assertEquals(lookback.int("min")..lookback.int("max"), WikiMaintenanceSettings.lookbackDaysRange)
        maintenance.arr("lookbacks").map { it.jsonObject }.forEach { row ->
            val days = row["days"].integer()
            val named = days.toString()
            assertEquals(named, row.str("says"), WikiModeCopy.lookbackLabel(days))
            assertEquals(named, row.str("choice"), WikiModeLogic.lookbackChoice(days).name.lowercase())
            assertEquals(named, row.int("offered"), WikiModeLogic.lookbackDaysOffered(days))
            // What the picker opens on writes back the setting it was read from.
            assertEquals(named, days, WikiModeLogic.lookbackDays(WikiModeLogic.lookbackChoice(days), WikiModeLogic.lookbackDaysOffered(days)))
        }
        maintenance.arr("workspaceLabels").map { it.jsonObject }.forEach { row ->
            val workspace = row.obj("workspace")
            val runner = (workspace["runner"] as? JsonObject)?.let { it["displayName"].text() ?: it["name"].text() }
            assertEquals(row.str("says"), WikiModeLogic.workspaceLabel(workspace["name"].text(), runner))
        }
        maintenance.arr("providerLabels").map { it.jsonObject }.forEach { row ->
            assertEquals(row.str("says"), WikiModeLogic.providerLabel(row.str("provider"), row["model"].text()))
        }
    }

    @Test fun theModeFallbackIsSaidWhileTheSpaceIsStillInIt() {
        settings.arr("fallbacks").map { it.jsonObject }.forEach { row ->
            val space = row.obj("settings").decode(WikiSpaceSettings.serializer())
            assertEquals("${space.reviewMode} by ${space.reviewModeChangedBy}", row["says"].text(), WikiModeLogic.modeFallback(space, ZoneId.of("UTC")))
        }
        // A space that names no mode is Manual: it was made before review modes existed.
        assertEquals("manual", WikiModeLogic.mode(null))
        assertEquals("manual", WikiModeLogic.mode(WikiSpaceSettings(reviewMode = "experimental")))
    }

    /** The workspaces the Set up form lists are the ones the runner reads name, by the runner's display name when it has
     * one; the providers are the configured ones on the Claude Code runtime, by their default model. */
    @Test fun theFormsOptionsAreTheAccountsWorkspacesAndClaudeProviders() {
        val reads = WikiMaintenanceReads(
            workspaces = Json.parseToJsonElement("""[{"id":"w1","name":"orbit","runnerId":"r1"},{"id":"w2","name":"docs","runnerId":"r2"},{"id":"w3","name":"loose"}]""").jsonArray,
            runners = Json.parseToJsonElement("""[{"id":"r1","name":"host-1","displayName":"Mac mini"},{"id":"r2","name":"wikova","displayName":null}]""").jsonArray,
            providers = Json.parseToJsonElement("""[{"slug":"local-vllm","runtime":"claude","defaultModel":"qwen3.8-27b-fp8","models":[]},
                {"slug":"anthropic","runtime":"claude","models":[{"value":"claude-sonnet","label":"Sonnet"}]},
                {"slug":"openai","runtime":"codex","defaultModel":"gpt"}]""").jsonArray)
        assertEquals(listOf(WikiPickerOption("w1", "orbit · Mac mini"), WikiPickerOption("w2", "docs · wikova"), WikiPickerOption("w3", "loose")),
            wikiWorkspaceRows(reads, DirectoryData()).map { it.option })
        assertEquals(listOf(WikiPickerOption("local-vllm", "local-vllm · qwen3.8-27b-fp8"), WikiPickerOption("anthropic", "anthropic · claude-sonnet")),
            wikiProviderOptions(reads.providers))
        // Before the reads come back (or when they fail), the directory this client already holds names them.
        val data = DirectoryData(workspaces = listOf(DirectoryWorkspace("w1", "orbit", "r1")), runners = listOf(DirectoryRunner("r1", "host-1")))
        assertEquals(listOf(WikiPickerOption("w1", "orbit · host-1")), wikiWorkspaceRows(WikiMaintenanceReads(), data).map { it.option })
    }

    /** What the page writes (`PATCH /api/wiki/spaces/:id`): a key left out is left as it was, and all of history is sent
     * as null — a value — never left out. Changing the look-back later never moves maintenance back: that is the
     * server's rule (contract `cursor.start`), so the form sends what was picked and the server keeps its cursor. */
    @Test fun theSetUpFormWritesTheLookBackAsZeroDaysOrNull() {
        fun body(lookback: WikiModeLogic.LookbackChoice, days: Int) =
            wikiMaintenanceUpdate(WikiMaintenanceChoice("w1", "local-vllm", 8, lookback, days)).toString()
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}""",
            body(WikiModeLogic.LookbackChoice.NOW, 14))
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":30}}""",
            body(WikiModeLogic.LookbackChoice.DAYS, 30))
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":null}}""",
            body(WikiModeLogic.LookbackChoice.ALL, 14))
        assertEquals("""{"reviewMode":"automatic"}""", wikiReviewModeUpdate("automatic").toString())
        assertEquals("""{"automaticSpotChecks":true}""", wikiSpotChecksUpdate(true).toString())
        assertEquals("""{"maintenance":{"enabled":false}}""", wikiMaintenanceOff().toString())
    }

    /** The review modes, who changes them and the spot checks are the contract's; every write the page makes goes to the
     * user door's PATCH, which is where the client sends it. */
    @Test fun theReviewModesAndTheOwnersRoutesAreTheContracts() {
        val contract = WikiFixtures.contract
        val reviewModes = contract.obj("reviewModes")
        assertEquals(reviewModes.strings("values"), WikiModeLogic.modes)
        val settings = contract.obj("space").obj("settings")
        assertEquals(settings.obj("reviewMode").str("default"), WikiModeLogic.defaultMode)
        assertEquals(settings.obj("reviewMode").str("unset"), WikiModeLogic.mode(null))
        val changedBy = settings.obj("reviewModeChangedBy").str("type").split(" | ")
        assertEquals(listOf("owner", "spot_checks", "verification"), changedBy)
        assertEquals(false, settings.obj("automaticSpotChecks")["default"].bool())
        assertEquals("the spot check's sentence says 1 in 200", 200, reviewModes.obj("rules").int("automaticSpotCheckEvery"))
        assertTrue(WikiModeCopy.spotCheckNote.contains("1 in 200"))
        val routes = contract.obj("agentSurface").obj("doors").obj("user").strings("routes").toSet()
        listOf("PATCH /api/wiki/spaces/:id", "POST /api/wiki/entries/:id/confirm", "POST /api/wiki/entries/:id/reject",
            "POST /api/wiki/changesets/:id/revert", "GET /api/wiki/changesets/:id").forEach { assertTrue("$it is not a route the user door declares", it in routes) }
        val rig = WikiTestRig { request -> if (request.method.name == "PATCH") 200 to "{}" else 200 to "[]" }
        runBlocking { rig.store().client.updateSpace("SP", wikiReviewModeUpdate("manual")) }
        assertEquals("PATCH /api/wiki/spaces/:id", rig.line(rig.requests.single()).replace("SP", ":id"))
    }
}
