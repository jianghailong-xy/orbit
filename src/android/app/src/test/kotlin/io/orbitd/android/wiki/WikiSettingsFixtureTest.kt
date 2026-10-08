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
    private val settings get() = WikiSharedFiles.reviewMode.fobj("settings")

    @Test fun theSettingsPageSaysTheFixturesWordsInItsOrder() {
        val settings = settings
        assertEquals(settings.fstr("title"), WikiModeCopy.settingsTitle)
        assertEquals(settings.fstr("crumb"), WikiModeCopy.settings)
        assertEquals(settings.fstrings("sections"), WikiModeLogic.SettingsSection.entries.map { it.title })
        assertEquals(settings.fstr("reviewModeHint"), WikiModeCopy.reviewModeHint)
        assertEquals(settings.fstr("lead"), WikiModeCopy.reviewModeLead)
        assertEquals(settings.fstr("defaultTag"), WikiModeCopy.modeDefault)
        val modes = settings.farr("modes").map { it.jsonObject }
        assertEquals(modes.map { it.fstr("mode") }, WikiModeLogic.modes)
        modes.forEach { mode ->
            assertEquals(mode.fstr("label"), WikiModeCopy.modeLabel(mode.fstr("mode")))
            assertEquals(mode.fstr("note"), WikiModeCopy.modeNote(mode.fstr("mode")))
            assertEquals(mode["default"].bool(), mode.fstr("mode") == WikiModeLogic.defaultMode)
        }
        assertEquals(settings.fobj("spotCheck").fstr("title"), WikiModeCopy.spotCheck)
        assertEquals(settings.fobj("spotCheck").fstr("note"), WikiModeCopy.spotCheckNote)
        assertEquals(settings.fobj("floors").fstr("lead"), WikiModeCopy.floorsLead)
        assertEquals(settings.fobj("floors").fstr("note"), WikiModeCopy.floorsNote)

        val maintenance = settings.fobj("maintenance")
        assertEquals(listOf(maintenance.fstr("name"), maintenance.fstr("note"), maintenance.fstr("off"), maintenance.fstr("on"), maintenance.fstr("setUp")),
            listOf(WikiModeCopy.maintenanceName, WikiModeCopy.maintenanceNote, WikiModeCopy.off, WikiModeCopy.on, WikiModeCopy.setUp))
        val form = maintenance.fobj("form")
        assertEquals(form.fstr("title"), WikiModeCopy.setUpTitle)
        assertEquals(form.farr("fields").map { it.jsonObject.fstr("label") },
            listOf(WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        assertEquals(form.farr("fields").map { it.jsonObject.fstr("note") },
            listOf(WikiModeCopy.workspaceNote, WikiModeCopy.providerNote, WikiModeCopy.dailyLimitNote, WikiModeCopy.lookbackNote))
        assertEquals(form.fstr("unit"), WikiModeCopy.runsADayUnit)
        assertEquals(listOf(form.fstr("cancel"), form.fstr("turnOn"), form.fstr("save")), listOf(WikiModeCopy.cancel, WikiModeCopy.turnOn, WikiModeCopy.save))
        val defaults = form.fobj("defaults")
        assertEquals(defaults.fstr("provider"), WikiMaintenanceSettings.default.provider)
        assertEquals(defaults.fint("dailyRunLimit"), WikiMaintenanceSettings.default.dailyRunLimit)
        assertEquals(defaults.fint("min")..defaults.fint("max"), WikiMaintenanceSettings.dailyRunLimitRange)
        assertEquals(maintenance.fstrings("rows"),
            listOf(WikiModeCopy.status, WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit, WikiModeCopy.lookback))
        assertEquals(listOf(maintenance.fstr("edit"), maintenance.fstr("turnOff")), listOf(WikiModeCopy.maintenanceEdit, WikiModeCopy.turnOff))
        maintenance.farr("runsADay").map { it.jsonObject }.forEach { assertEquals(it.fstr("says"), WikiModeCopy.runsADay(it.fint("runs"))) }
        // The look-back: from now on, some days, all of history — the form opening on the contract's 14 days.
        val lookback = form.fobj("lookback")
        assertEquals(lookback.fstrings("choices"), WikiModeLogic.LookbackChoice.entries.map { it.name.lowercase() })
        assertEquals(lookback.fstrings("says"), WikiModeLogic.LookbackChoice.entries.map {
            WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays(it, lookback.fint("defaultDays"))) })
        assertEquals(lookback.fstr("unit"), WikiModeCopy.lookbackUnit)
        assertEquals(lookback.fint("defaultDays"), WikiMaintenanceSettings.default.lookbackDays)
        assertEquals(lookback.fint("min")..lookback.fint("max"), WikiMaintenanceSettings.lookbackDaysRange)
        maintenance.farr("lookbacks").map { it.jsonObject }.forEach { row ->
            val days = row["days"].integer()
            val named = days.toString()
            assertEquals(named, row.fstr("says"), WikiModeCopy.lookbackLabel(days))
            assertEquals(named, row.fstr("choice"), WikiModeLogic.lookbackChoice(days).name.lowercase())
            assertEquals(named, row.fint("offered"), WikiModeLogic.lookbackDaysOffered(days))
            // What the picker opens on writes back the setting it was read from.
            assertEquals(named, days, WikiModeLogic.lookbackDays(WikiModeLogic.lookbackChoice(days), WikiModeLogic.lookbackDaysOffered(days)))
        }
        maintenance.farr("workspaceLabels").map { it.jsonObject }.forEach { row ->
            val workspace = row.fobj("workspace")
            val runner = (workspace["runner"] as? JsonObject)?.let { it["displayName"].text() ?: it["name"].text() }
            assertEquals(row.fstr("says"), WikiModeLogic.workspaceLabel(workspace["name"].text(), runner))
        }
        maintenance.farr("providerLabels").map { it.jsonObject }.forEach { row ->
            assertEquals(row.fstr("says"), WikiModeLogic.providerLabel(row.fstr("provider"), row["model"].text()))
        }
    }

    @Test fun theModeFallbackIsSaidWhileTheSpaceIsStillInIt() {
        settings.farr("fallbacks").map { it.jsonObject }.forEach { row ->
            val space = row.fobj("settings").decode(WikiSpaceSettings.serializer())
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
        val contract = WikiSharedFiles.contract
        val reviewModes = contract.fobj("reviewModes")
        assertEquals(reviewModes.fstrings("values"), WikiModeLogic.modes)
        val settings = contract.fobj("space").fobj("settings")
        assertEquals(settings.fobj("reviewMode").fstr("default"), WikiModeLogic.defaultMode)
        assertEquals(settings.fobj("reviewMode").fstr("unset"), WikiModeLogic.mode(null))
        val changedBy = settings.fobj("reviewModeChangedBy").fstr("type").split(" | ")
        assertEquals(listOf("owner", "spot_checks", "verification"), changedBy)
        assertEquals(false, settings.fobj("automaticSpotChecks")["default"].bool())
        assertEquals("the spot check's sentence says 1 in 200", 200, reviewModes.fobj("rules").fint("automaticSpotCheckEvery"))
        assertTrue(WikiModeCopy.spotCheckNote.contains("1 in 200"))
        val routes = contract.fobj("agentSurface").fobj("doors").fobj("user").fstrings("routes").toSet()
        listOf("PATCH /api/wiki/spaces/:id", "POST /api/wiki/entries/:id/confirm", "POST /api/wiki/entries/:id/reject",
            "POST /api/wiki/changesets/:id/revert", "GET /api/wiki/changesets/:id").forEach { assertTrue("$it is not a route the user door declares", it in routes) }
        val rig = WikiTestRig { request -> if (request.method.name == "PATCH") 200 to "{}" else 200 to "[]" }
        runBlocking { rig.store().client.updateSpace("SP", wikiReviewModeUpdate("manual")) }
        assertEquals("PATCH /api/wiki/spaces/:id", rig.line(rig.requests.single()).replace("SP", ":id"))
    }
}
