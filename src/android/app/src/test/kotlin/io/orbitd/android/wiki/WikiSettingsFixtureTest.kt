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
        val workspaces = settings.fobj("workspaces")
        assertEquals(workspaces.fstr("lead"), WikiModeCopy.workspacesLead)
        assertEquals(workspaces.fstr("leftOut"), WikiModeCopy.workspaceLeftOut)
        assertEquals(workspaces.fstr("join"), WikiModeCopy.workspacesJoin)
        assertEquals(workspaces.fstr("joinNoRepository"), WikiModeCopy.workspacesJoinNoRepository)
        assertEquals(workspaces.fstr("empty"), WikiModeCopy.workspacesEmpty)
        assertEquals(workspaces.fstr("add"), WikiModeCopy.addWorkspace)
        assertEquals(workspaces.fstr("addGroup"), WikiModeCopy.addWorkspaceGroup)
        val delete = settings.fobj("delete")
        assertEquals(delete.fstr("note"), WikiModeCopy.deleteNote)
        assertEquals(delete.fstr("open"), WikiModeCopy.deleteOpen)
        assertEquals(delete.fstr("confirm"), WikiModeCopy.deleteConfirm)
        assertEquals(delete.fstr("kept"), WikiModeCopy.deleteKept)
        assertEquals(delete.fstr("failedNative"), WikiModeCopy.deleteFailed)
        assertEquals(delete.fobj("question").fstr("text"), WikiModeCopy.deleteQuestion(delete.fobj("question").fstr("name")))
        assertEquals(delete.fobj("deleted").fstr("text"), WikiModeCopy.deleted(delete.fobj("deleted").fstr("name")))
        assertEquals(delete.fobj("comesBack").fstr("text"), WikiModeCopy.deleteComesBack(delete.fobj("comesBack").fstr("repository")))
        val bodies = delete.farr("bodies").map { it.jsonObject }
        assertTrue(bodies.isNotEmpty())
        bodies.forEach { assertEquals(it.fstr("text"), WikiModeCopy.deleteBody(it["entries"]?.jsonPrimitive?.intOrNull, it.fint("documents"))) }
        assertEquals(listOf(WikiModeCopy.deleteBody(null, 0), delete.fobj("comesBack").fstr("text"), delete.fstr("kept")).joinToString("\n\n"),
            WikiModeCopy.deleteMessage(null, 0, delete.fobj("comesBack").fstr("repository")))
        assertEquals(listOf(WikiModeCopy.deleteBody(2606, 0), delete.fstr("kept")).joinToString("\n\n"), WikiModeCopy.deleteMessage(2606, 0, null))
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

        // The rows once on, the form's fields and the sentence under the card are the server execution fixture's
        // (`WikiServerExecutionFixtureTest`).
        val maintenance = settings.fobj("maintenance")
        assertEquals(listOf(maintenance.fstr("name"), maintenance.fstr("off"), maintenance.fstr("on"), maintenance.fstr("setUp")),
            listOf(WikiModeCopy.maintenanceName, WikiModeCopy.off, WikiModeCopy.on, WikiModeCopy.setUp))
        val form = maintenance.fobj("form")
        assertEquals(form.fstr("title"), WikiModeCopy.setUpTitle)
        assertEquals(form.fstr("unit"), WikiModeCopy.runsADayUnit)
        assertEquals(listOf(form.fstr("cancel"), form.fstr("turnOn"), form.fstr("save")), listOf(WikiModeCopy.cancel, WikiModeCopy.turnOn, WikiModeCopy.save))
        val defaults = form.fobj("defaults")
        assertEquals(defaults.fint("dailyRunLimit"), WikiMaintenanceSettings.default.dailyRunLimit)
        assertEquals(defaults.fint("min")..defaults.fint("max"), WikiMaintenanceSettings.dailyRunLimitRange)
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

    /** The workspaces the forms list are the ones the runner reads name, by the runner's display name when it has one, each with
     * its repository and whether its runner is offline — a workspace with no runner the reads name is not known to be. */
    @Test fun theFormsOptionsAreTheAccountsWorkspaces() {
        val reads = WikiMaintenanceReads(
            workspaces = Json.parseToJsonElement("""[{"id":"w1","name":"orbit","runnerId":"r1","repoUrl":"git@github.com:acme/orbit.git"},{"id":"w2","name":"docs","runnerId":"r2"},{"id":"w3","name":"loose"}]""").jsonArray,
            runners = Json.parseToJsonElement("""[{"id":"r1","name":"host-1","displayName":"Mac mini","online":true},{"id":"r2","name":"wikova","displayName":null,"online":false}]""").jsonArray)
        assertEquals(listOf(WikiPickerOption("w1", "orbit · Mac mini"), WikiPickerOption("w2", "docs · wikova", offline = true), WikiPickerOption("w3", "loose")),
            wikiWorkspaceRows(reads, DirectoryData()).map { it.option() })
        assertEquals(listOf("github.com/acme/orbit", null, null), wikiWorkspaceRows(reads, DirectoryData()).map { it.repository })
        // Before the reads come back (or when they fail), the directory this client already holds names them.
        val data = DirectoryData(workspaces = listOf(DirectoryWorkspace("w1", "orbit", "r1", repoUrl = "https://github.com/acme/orbit.git")),
            runners = listOf(DirectoryRunner("r1", "host-1", online = true)))
        assertEquals(listOf(WikiWorkspaceChoice("w1", "orbit · host-1", "github.com/acme/orbit", "https://github.com/acme/orbit.git", true)),
            wikiWorkspaceRows(WikiMaintenanceReads(), data))
    }

    /** What the page writes (`PATCH /api/wiki/spaces/:id`): a key left out is left as it was, and all of history is sent
     * as null — a value — never left out; no provider, ever. Changing the look-back later never moves maintenance back:
     * that is the server's rule (contract `cursor.start`), so the form sends what was picked and the server keeps its
     * cursor. */
    @Test fun theSetUpFormWritesTheLookBackAsZeroDaysOrNull() {
        fun body(lookback: WikiModeLogic.LookbackChoice, days: Int) =
            wikiMaintenanceUpdate(WikiMaintenanceChoice("w1", 8, lookback, days)).toString()
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","dailyRunLimit":8,"lookbackDays":0}}""",
            body(WikiModeLogic.LookbackChoice.NOW, 14))
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","dailyRunLimit":8,"lookbackDays":30}}""",
            body(WikiModeLogic.LookbackChoice.DAYS, 30))
        assertEquals("""{"maintenance":{"enabled":true,"workspaceId":"w1","dailyRunLimit":8,"lookbackDays":null}}""",
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
