package io.orbitd.android.projects

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LandingCheckSettingsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-11-21T12:00:00Z")

    @Test fun commandAndBudgetSaveIndependentlyWithoutTrimmingTheCommand() {
        val view = Json.parseToJsonElement("""{"landingCheckCommand":null,"landingCheckTimeoutSeconds":null}""").jsonObject
        val set = landingCheckWrite(view, "  make fast  ", 600)!!
        assertEquals("  make fast  ", set["landingCheckCommand"]!!.jsonPrimitive.content)
        assertEquals(600, set["landingCheckTimeoutSeconds"]!!.jsonPrimitive.int)
        val clear = landingCheckWrite(set, " ", null)!!
        assertEquals(JsonNull, clear["landingCheckCommand"])
        assertEquals(JsonNull, clear["landingCheckTimeoutSeconds"])
        assertNull(landingCheckWrite(view, "", null))
    }

    // Ported from main's bc61299579 (its own Android port, removed in this merge): the assertions it made that the tests above and
    // LandingMeasuredTest did not, on this implementation's types.

    @Test fun leavingNoCheckWritesTheCommandEvenWhenNull() {
        // As the server sends No check: the command cleared beside the named value (project-integration-line.ts).
        val none = json("""{"landingCheckCommand":null,"landingCheckTimeoutSeconds":600,"landingCheck":{"command":"NONE"}}""")
        assertEquals(json("""{"landingCheckCommand":null}"""), landingCheckModeWrite(none, ProjectLandingCheck.Mode.MERGE_CHECK))
        assertEquals(json("""{"landingCheckCommand":"make fast"}"""), landingCheckWrite(none, "make fast", 600))
        val prior = json("""{"landingCheckCommand":"make fast","landingCheckTimeoutSeconds":600}""")
        assertEquals(json("""{"landingCheck":"NONE"}"""), landingCheckModeWrite(prior, ProjectLandingCheck.Mode.NONE))
    }

    @Test fun theNestedCheckTakesPrecedenceAndSaysWhenItWasSet() {
        val view = json("""{"landingCheckCommand":"make old","landingCheck":{"command":null,"setBy":"COORDINATOR","setAt":"2026-11-21T10:00:00Z"}}""")
        val read = ProjectLandingCheck.of(view)!!
        assertEquals(ProjectLandingCheck.Mode.MERGE_CHECK, read.mode)
        assertEquals("set 2h ago", LandingMeasuredCopy.setAgo(read.setBy, ProjectTime.ago(read.setAt, now)!!))
        // Web's `ago` (lib/watches.ts): "just now" under ten seconds, then the span. Main's port said "just now" at 45 s; web does not.
        assertEquals("set just now", LandingMeasuredCopy.setAgo("COORDINATOR", ProjectTime.ago(now.minusSeconds(5).toString(), now)!!))
        assertEquals("set 45s ago", LandingMeasuredCopy.setAgo("COORDINATOR", ProjectTime.ago(now.minusSeconds(45).toString(), now)!!))
        assertEquals(listOf("Merge check", "Command", "No check"),
            listOf(LandingMeasuredCopy.mergeCheck, LandingMeasuredCopy.command, LandingMeasuredCopy.noCheck))
        val owner = ProjectLandingCheck.of(json("""{"landingCheck":{"command":"NONE","setBy":"OWNER"}}"""))!!
        assertEquals("OWNER", owner.setBy); assertNull("no time is said when none is recorded", owner.setAt)
    }

    /** Web's settings and change list, held to the source where Android follows its rules. */
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
            "{LANDING_CHECK_COPY.HINT} {LANDING_MODE_COPY.COMMAND_NOTE}",
            "<div className=\"project-integration-setting-label\">{LANDING_MODE_COPY.WHO_CAN_SET}</div>").forEach {
            assertTrue("ProjectRunSettings.tsx no longer says $it", settings.contains(it))
        }
        // The change list sits between the landing check and the merge check, on web as here (ProjectSettings.kt).
        val rows = listOf("{LANDING_CHECK_COPY.LABEL}</div>", "<ProjectChangesRow projectId={projectId} changes={project.settingChanges} />",
            "{RUN_MERGE_CHECK}</div>").map { settings.indexOf(it) }
        assertTrue("Web places change history between the landing and merge checks", rows.all { it >= 0 } && rows == rows.sorted())
        listOf("if (!changes || changes.length === 0) return null;", "{changesRowLabel(changes.length)} ›",
            "change.revertible ?", ") : change.origin !== 'COORDINATOR' ? (",
            "revertedLine(ago(change.revertedAt, now))", "if (value.none) return <>{CHANGES_COPY.NO_CHECK}</>;",
            "confirmText: CHANGES_COPY.REVERT,", "cancelText: CHANGES_COPY.CANCEL,",
            "}>${LandingMeasuredCopy.openTask}</Link>", "goes back from{' '}", " to <ValueText value={change.oldValue} />.",
            "CHANGES_COPY.CONFIRM_CONSEQUENCE",
            "/projects/${'$'}{encodeURIComponent(projectId)}/setting-changes/${'$'}{encodeURIComponent(change.id)}/revert`, { method: 'POST' }")
            .forEach { assertTrue("ProjectLandingChanges.tsx no longer says $it", list.contains(it)) }
    }
}
