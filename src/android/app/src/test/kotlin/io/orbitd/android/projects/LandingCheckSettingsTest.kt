package io.orbitd.android.projects

import io.orbitd.android.core.cards.LandingChangesCopy
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LandingCheckSettingsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-11-21T12:00:00Z")

    @Test fun commandAndBudgetSaveIndependentlyWithoutTrimmingTheCommand() {
        val view = json("""{"landingCheckCommand":null,"landingCheckTimeoutSeconds":null}""")
        val set = landingCheckWrite(view, LandingCheckMode.COMMAND, "  make fast  ", 600)!!
        assertEquals("  make fast  ", set["landingCheckCommand"]!!.jsonPrimitive.content)
        assertEquals(600, set["landingCheckTimeoutSeconds"]!!.jsonPrimitive.int)
        val clear = landingCheckWrite(set, LandingCheckMode.COMMAND, " ", null)!!
        assertEquals(JsonNull, clear["landingCheckCommand"])
        assertEquals(JsonNull, clear["landingCheckTimeoutSeconds"])
        assertNull(landingCheckWrite(view, LandingCheckMode.MERGE_CHECK, "", null))
    }

    @Test fun noCheckWritesByNameAndLeavingItWritesTheCommandEvenWhenNull() {
        val prior = json("""{"landingCheckCommand":"make fast","landingCheckTimeoutSeconds":600}""")
        assertEquals(json("""{"landingCheck":"NONE"}"""), landingCheckWrite(prior, LandingCheckMode.NO_CHECK, "make fast", 300))
        val none = json("""{"landingCheckCommand":null,"landingCheckTimeoutSeconds":600,"landingCheck":{"command":"NONE"}}""")
        assertNull(landingCheckWrite(none, LandingCheckMode.NO_CHECK, "", null))
        assertEquals(json("""{"landingCheckCommand":null}"""), landingCheckWrite(none, LandingCheckMode.MERGE_CHECK, "retained draft", 600))
        assertEquals(json("""{"landingCheckCommand":"make fast"}"""), landingCheckWrite(none, LandingCheckMode.COMMAND, "make fast", 600))
    }

    @Test fun nestedCheckTakesPrecedenceAndNamesItsWriter() {
        val view = json("""{"landingCheckCommand":"make old","landingCheck":{"command":null,"setBy":"COORDINATOR","setAt":"2026-11-21T10:00:00Z"}}""")
        val check = ProjectLandingCheck.read(view)
        assertEquals(LandingCheckMode.MERGE_CHECK, check.mode)
        assertEquals("Coordinator · set 2h ago", check.originLine(now))
        assertEquals("Coordinator · set just now", check.copy(setAt = now.minusSeconds(45).toString()).originLine(now))
        assertEquals(listOf("Merge check", "Command", "No check"), LandingCheckMode.entries.map { it.label })
        assertEquals("You", ProjectLandingCheck.read(json("""{"landingCheck":{"command":"NONE","setBy":"OWNER"}}""")).originLine(now))
        assertNull(ProjectLandingCheck.read(json("""{"landingCheck":{"command":"NONE","setBy":"FUTURE"}}""")).originLine(now))
        val legacy = ProjectLandingCheck.read(json("""{"landingCheckCommand":"make old"}"""))
        assertEquals(LandingCheckMode.COMMAND, legacy.mode)
        assertNull(legacy.originLine(now))
    }

    @Test fun settingsAndHistoryFollowTheWebsRules() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/web/src/lib/landingCheck.ts").isFile }
        val settings = File(root, "src/web/src/components/ProjectRunSettings.tsx").readText()
        val mode = File(root, "src/web/src/lib/landingCheck.ts").readText()
        val list = File(root, "src/web/src/components/ProjectLandingChanges.tsx").readText()
        assertTrue(mode.contains("view.landingCheck ? view.landingCheck.command : view.landingCheckCommand"))
        assertTrue(mode.contains("if (command === 'NONE') return 'NONE';"))
        assertTrue(settings.contains("`set ${'$'}{ago(setAt, now)}`"))
        listOf("storedMode !== 'NONE' ? { landingCheck: 'NONE' }",
            "|| storedMode === 'NONE' ? { landingCheckCommand: landing }",
            "draft.landingMode !== 'NONE' && draft.landingCheckTimeoutSeconds",
            "<b>{LANDING_MODE_COPY.NONE_HEAD}</b> {LANDING_MODE_COPY.NONE_BODY}",
            "{LANDING_CHECK_COPY.HINT} {LANDING_MODE_COPY.COMMAND_NOTE}").forEach {
            assertTrue("ProjectRunSettings.tsx no longer says $it", settings.contains(it))
        }
        val rows = listOf("{LANDING_CHECK_COPY.LABEL}</div>", "<ProjectChangesRow projectId={projectId} changes={project.settingChanges} />",
            "{RUN_MERGE_CHECK}</div>").map { settings.indexOf(it) }
        assertTrue("Web places change history between the landing and merge checks", rows.all { it >= 0 } && rows == rows.sorted())
        listOf("if (!changes || changes.length === 0) return null;", "{changesRowLabel(changes.length)} ›",
            "change.revertible ?", "change.origin !== 'COORDINATOR' && !change.revertsChangeId",
            "revertedLine(ago(change.revertedAt, now))", "if (value.none) return <>{CHANGES_COPY.NO_CHECK}</>;",
            "confirmText: CHANGES_COPY.REVERT,", "cancelText: CHANGES_COPY.CANCEL,",
            "}>${LandingChangesCopy.openTask}</Link>", "goes back from{' '}", " to <ValueText value={change.oldValue} />.",
            "CHANGES_COPY.CONFIRM_CONSEQUENCE",
            "/projects/${'$'}{encodeURIComponent(projectId)}/setting-changes/${'$'}{encodeURIComponent(change.id)}/revert`, { method: 'POST' }")
            .forEach { assertTrue("ProjectLandingChanges.tsx no longer says $it", list.contains(it)) }
    }

    @Test fun historyUsesServerOrderAndActionsIncludingTaskExemptions() {
        val history = ProjectSettingChange.read(json("""{"settingChanges":[
            {"id":"owner","field":"LANDING_CHECK","origin":"OWNER","oldValue":{"none":false},"newValue":{"none":true}},
            {"id":"revert","field":"LANDING_CHECK","origin":"OWNER","revertsChangeId":"old","oldValue":{"none":true},"newValue":{"none":false}},
            {"id":"exempt","field":"TASK_LANDING_CHECK_EXEMPT","taskId":"task-1","origin":"COORDINATOR","revertible":true,
              "oldValue":{"exempt":false},"newValue":{"exempt":true,"reason":"Docs"},"reason":"Docs"},
            {"id":"old","field":"LANDING_CHECK","origin":"COORDINATOR","oldValue":{"none":false},"newValue":{"none":true},
              "revertedAt":"2026-11-21T10:00:00Z"},
            {"id":"future","field":"FUTURE"}
        ]}"""))
        assertEquals(listOf("owner", "revert", "exempt", "old"), history.map { it.id })
        assertEquals("Your change · nothing to revert", history[0].ownerNote)
        assertNull(history[1].ownerNote)
        assertTrue(history[2].revertible)
        assertEquals("task-1", history[2].taskId)
        assertEquals("Check exempt goes back from exempt to not exempt.", history[2].confirmation)
        assertFalse(history[3].revertible)
        assertEquals("2026-11-21T10:00:00Z", history[3].revertedAt)
        assertEquals("Landing check goes back from No check to Uses merge check.", history[3].confirmation)
    }
}
