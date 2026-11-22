package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.reader.LandingEntry
import io.orbitd.android.reader.LandingSteps
import io.orbitd.android.reader.landingMark
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Contract revision 42 part two as the owner ruled it on the board (docs/mocks/landing-measured): what Android reads off the server's
 * new fields — and that a server without them still reads — the start with no line, the page with no line, and a task's exempt
 * landing check skipped rather than failed. */
class LandingMeasuredTest {
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    // MARK: an older server

    /** The reads as a server from before revision 42 part two sends them: no `landingCheck`, no `settingChanges`, no exemption fields. */
    private val oldIntegration = j("""{"line":"PROJECT_BRANCH","ref":"project/p1","locked":true,"landingCheckCommand":"npm run check:landing",
        "landingCheckTimeoutSeconds":null,"mergeCheckCommand":"npm test","mergeCheckTimeoutSeconds":null,"escalationSeconds":7200}""")
    private val oldDocument = j("""{"id":"p1","title":"Rotate staging credentials","status":"OPEN","startedAt":"2026-11-17T09:00:00Z",
        "integration":{"line":"PROJECT_BRANCH"}}""")
    private val oldTask = j("""{"id":"t1","title":"Move cron jobs off the old VM","status":"DONE","projectId":"p1"}""")

    @Test fun aServerWithoutTheNewFieldsStillDecodes() {
        val read = ProjectLandingCheck.of(oldIntegration)!!
        assertEquals(ProjectLandingCheck.Mode.COMMAND, read.mode)
        assertEquals("npm run check:landing", read.command)
        assertNull("nobody is named when the server does not say", read.setBy)
        assertNull(read.setAt)
        assertEquals(ProjectLandingCheck.Mode.MERGE_CHECK, ProjectLandingCheck.of(j("""{"line":"PROJECT_BRANCH","landingCheckCommand":null}"""))!!.mode)
        assertEquals(ProjectLandingCheck.Mode.NONE, ProjectLandingCheck.of(j("""{"line":"PROJECT_BRANCH","landingCheckCommand":null,
            "landingCheckCommandAbsentReason":"NONE"}"""))!!.mode)
        assertNull("no list from a server that keeps none: Settings draws no row", ProjectSettingChanges.of(oldDocument))
        assertNull("a task the server says nothing about is not exempt", TaskLandingExemption.of(oldTask))
        assertNull(ProjectLandingCheck.of(null))
    }

    // MARK: the new fields

    @Test fun theLandingCheckSaysItsValueAndWhoSetIt() {
        fun of(check: String) = ProjectLandingCheck.of(JsonObject(oldIntegration + ("landingCheck" to j(check))))!!
        val coordinator = of("""{"command":"npm run check:landing","setBy":"COORDINATOR","setBySessionId":"s1","setAt":"2026-11-20T11:30:00Z"}""")
        assertEquals(ProjectLandingCheck.Read(ProjectLandingCheck.Mode.COMMAND, "npm run check:landing", "COORDINATOR", "2026-11-20T11:30:00Z"), coordinator)
        assertEquals(ProjectLandingCheck.Mode.NONE, of("""{"command":"NONE","setBy":"OWNER","setBySessionId":null,"setAt":"2026-11-20T11:39:00Z"}""").mode)
        assertNull(of("""{"command":"NONE","setBy":"OWNER","setBySessionId":null,"setAt":null}""").command)
        assertEquals(ProjectLandingCheck.Mode.MERGE_CHECK, of("""{"command":null,"setBy":null,"setBySessionId":null,"setAt":null}""").mode)
        assertEquals("START", of("""{"command":"x","setBy":"START","setBySessionId":null,"setAt":null}""").setBy)
        assertNull("a writer this build does not know names nobody", of("""{"command":"x","setBy":"ROBOT","setBySessionId":null,"setAt":null}""").setBy)

        assertEquals("You", LandingMeasuredCopy.who("OWNER")); assertEquals("Coordinator", LandingMeasuredCopy.who("COORDINATOR"))
        assertEquals("Approved on a card", LandingMeasuredCopy.who("CARD")); assertEquals("Set at start", LandingMeasuredCopy.who("START"))
        assertEquals("set 12m ago", LandingMeasuredCopy.setAgo("COORDINATOR", "12m ago"))
        assertEquals("confirmed 5d ago", LandingMeasuredCopy.setAgo("CARD", "5d ago"))
        assertEquals("3d ago", LandingMeasuredCopy.setAgo("START", "3d ago"))
    }

    @Test fun theSwitchWritesTheMergeCheckAndNoCheckAtThePress() {
        val command = JsonObject(oldIntegration + ("landingCheck" to j("""{"command":"npm run check:landing","setBy":"OWNER","setBySessionId":null,"setAt":null}""")))
        assertEquals(j("""{"landingCheckCommand":null}"""), landingCheckModeWrite(command, ProjectLandingCheck.Mode.MERGE_CHECK))
        assertEquals(j("""{"landingCheck":"NONE"}"""), landingCheckModeWrite(command, ProjectLandingCheck.Mode.NONE))
        assertNull("Command opens the editor: nothing is written at the press", landingCheckModeWrite(command, ProjectLandingCheck.Mode.COMMAND))
        val none = JsonObject(oldIntegration + ("landingCheckCommand" to JsonNull) + ("landingCheck" to j("""{"command":"NONE","setBy":"OWNER","setBySessionId":null,"setAt":null}""")))
        assertNull("the value it already holds writes nothing", landingCheckModeWrite(none, ProjectLandingCheck.Mode.NONE))
    }

    private val changes = j("""{"settingChanges":[
        {"id":"c3","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
         "oldValue":{"command":"npm run check:landing","timeoutSeconds":null,"none":false},"newValue":{"command":null,"timeoutSeconds":null,"none":true},
         "reason":"This project only changes infrastructure; the command has nothing to build.","writtenBySessionId":"s1","revertsChangeId":null,
         "revertedAt":null,"revertible":true,"createdAt":"2026-11-20T11:30:00Z"},
        {"id":"c2","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
         "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Only moves cron entries."},
         "reason":"Only moves cron entries.","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,"revertible":true,"createdAt":"2026-11-20T11:22:00Z"},
        {"id":"c1","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"OWNER",
         "oldValue":{"command":null,"timeoutSeconds":null,"none":false},"newValue":{"command":"npm run check:landing","timeoutSeconds":null,"none":false},
         "reason":null,"writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,"revertible":false,"createdAt":"2026-11-18T11:42:00Z"},
        {"id":"c0","projectId":"p1","field":"SOMETHING_NEW","createdAt":"2026-11-18T11:00:00Z"}]}""")

    @Test fun theChangesListReadsWhatWasChangedFromWhatToWhatAndWhetherItCanGoBack() {
        val list = ProjectSettingChanges.of(changes)!!
        assertEquals("a field this build cannot name is left out, not guessed", listOf("c3", "c2", "c1"), list.map { it.id })
        val none = list[0]
        assertEquals(ProjectSettingChanges.Value.LandingCheck("npm run check:landing", null, false), none.old)
        assertEquals("No check", changeValue(none.new))
        assertEquals("npm run check:landing", changeValue(none.old))
        assertTrue(none.revertible)
        assertEquals("Landing check", changeField(none) { null })
        assertEquals("Check exempt · Move cron jobs off the old VM", changeField(list[1]) { if (it == "t1") "Move cron jobs off the old VM" else null })
        assertEquals("exempt", changeValue(list[1].new)); assertEquals("not exempt", changeValue(list[1].old))
        assertEquals("Uses merge check", changeValue(list[2].old))
        assertEquals("OWNER", list[2].origin)
        assertEquals(list[1], ProjectSettingChanges.latestExemption(list, "t1"))
        assertNull(ProjectSettingChanges.latestExemption(list, "t9"))
        // The first records carried no origin: they were the coordinator's.
        assertEquals("COORDINATOR", ProjectSettingChanges.of(j("""{"settingChanges":[{"id":"x","field":"LANDING_CHECK","createdAt":"2026-11-20T00:00:00Z",
            "oldValue":{"command":null,"timeoutSeconds":null,"none":false},"newValue":{"command":null,"timeoutSeconds":null,"none":true}}]}"""))!!.single().origin)
        // The owner's revert is said on the row it put back, not listed as a row of its own.
        val revert = list[0].copy(id = "c4", origin = "OWNER", revertsChangeId = "c3")
        assertEquals(listOf("c3", "c2", "c1"), ProjectSettingChanges.listed(listOf(revert) + list).map { it.id })
        assertEquals("3 changes", LandingMeasuredCopy.changesCount(3)); assertEquals("1 change", LandingMeasuredCopy.changesCount(1))
    }

    @Test fun aTaskSaysItIsExemptAndWho() {
        val coordinator = TaskLandingExemption.of(JsonObject(oldTask + mapOf("landingCheckExempt" to JsonPrimitive(true),
            "landingCheckExemptReason" to JsonPrimitive("Only moves cron entries."), "landingCheckExemptBySessionId" to JsonPrimitive("s1"))))!!
        assertEquals(TaskLandingExemption("Only moves cron entries.", "s1"), coordinator)
        assertNull(TaskLandingExemption.of(JsonObject(oldTask + ("landingCheckExempt" to JsonPrimitive(false)))))
    }

    // MARK: the start with no line (P-M2, D1, D8)

    private fun requestRow(settings: String) = j("""{"itemId":"item-1","kind":"START_REQUEST","waitingSince":"2026-11-20T11:29:00Z",
        "startRequest":{"settings":$settings,"why":"","criteriaDigest":"seal1","planDigest":"pp","repository":null,"warnings":[]}}""")

    @Test fun aRequestWithNoLineIsACardWhoseStartSendsNoLine() {
        val request = StartProjectCopy.request(requestRow("""{"automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null}"""))!!
        assertNull(request.settings.line)
        // And an explicit null is the same request.
        assertNull(StartProjectCopy.request(requestRow("""{"line":null,"automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null}"""))!!.settings.line)
        val view = j("""{"line":null,"repository":"acme/infra","upstreamRef":"main","deliveryMode":"PLATFORM"}""")
        val draft = StartProjectCopy.Draft.of(request.settings, view)
        assertNull(draft.line)
        assertNull("no main branch is offered on a card with no line", draft.upstream)
        assertTrue(draft.complete)
        val body = StartProjectCopy.body(request, draft.copy(mergeCheckCommand = "npm test"), "item-1")
        assertFalse(body.containsKey("line"))
        assertFalse(body.containsKey("projectBranchName")); assertFalse(body.containsKey("upstreamRef"))
        assertFalse(body.containsKey("landingCheckCommand")); assertFalse(body.containsKey("deliveryMode"))
        assertEquals("npm test", body.text("mergeCheckCommand"))
        assertEquals(3, body.number("maxConcurrentTasks"))
        assertEquals("Lands on the project’s branch when a task commits", LandingMeasuredCopy.landsWhenATaskCommits)
        assertTrue(StartProjectCopy.settingsLine(draft, "project/p1").contains(LandingMeasuredCopy.landsWhenATaskCommits))
        // Nothing about the line is decided, so no sentence on the card names main or a merge (web 4e487f20ec).
        assertEquals("The coordinator decides when each task is done.", RunSettings.automaticSays(true, null, false))
        assertEquals("You decide when each task is done.", RunSettings.automaticSays(false, null, true))
        for (automatic in listOf(true, false)) assertFalse(StartProjectCopy.comesToYou(automatic, null, emptyList(), 0, 7_200)
            .joinToString(" ") { it.text }.contains(Regex("\\bmain\\b|merg", RegexOption.IGNORE_CASE)))
        assertTrue(RunSettings.automaticSays(true, "PROJECT_BRANCH", false).contains("merges into main by itself"))
        // A line this build does not know is still a request it cannot read.
        assertNull(StartProjectCopy.request(requestRow("""{"line":"SIDEWAYS","automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null}""")))
    }

    // MARK: the page with no line (§12.16, D2)

    @Test fun aStartedProjectWithNoLineDrawsNoLanding() {
        val noLine = j("""{"line":null,"locked":false,"startedAt":null,"integratingCount":0,"queuedCount":0}""")
        assertTrue(ProjectLine.none(noLine, started = true))
        assertFalse("before the start there is nothing to hide", ProjectLine.none(noLine, started = false))
        assertFalse("a read that has not answered hides nothing", ProjectLine.none(null, started = true))
        assertFalse(ProjectLine.none(oldIntegration, started = true))

        val landed = j("""{"id":"t1","title":"Rotate","status":"DONE","workState":"DONE","integration":{"state":"ON_INTEGRATION_LINE"}}""")
        assertEquals(listOf("On project/p1"), ProjectPage.rowTags(landed, "Done", "project/p1", null).map { it.text })
        assertTrue("no landing segment on a row of a project with no line",
            ProjectPage.rowTags(landed, "Done", "project/p1", null, noLine = true).isEmpty())

        val buckets = j("""{"running":1,"ready":0,"blocked":2,"integrating":0,"onIntegrationLine":0,"onUpstream":0,"doneNotIntegrated":3,
            "waitingForLanding":0,"awaitingVerification":0,"failed":0,"cancelled":0,"done":3}""")
        val lanes = ProjectPage.overviewCells(buckets, 6, null, true).map { it.key }
        assertTrue(lanes.contains("integrating"))
        val without = ProjectPage.overviewCells(buckets, 6, null, true, noLine = true).map { it.key }
        assertFalse(without.contains("integrating")); assertFalse(without.contains("onIntegrationLine")); assertFalse(without.contains("onUpstream"))
    }

    /** Who marked a task exempt (web `TaskLandingExempt`): the newest record of its exemption that set it and was not reverted, and
     *  its origin as the pill reads it. Ported from main's second Android port (22189bf97a). */
    @Test fun whoMarkedAnExemptionIsTheNewestUnrevertedRecordThatSetIt() {
        fun change(id: String, taskId: String = "t1", exempt: Boolean = true, revertedAt: String? = null, origin: String = "COORDINATOR",
            field: String = "TASK_LANDING_CHECK_EXEMPT", value: String = """"oldValue":{"exempt":${!exempt},"reason":null},"newValue":{"exempt":$exempt,"reason":"r"}""") =
            """{"id":"$id","projectId":"p1","taskId":"$taskId","field":"$field","origin":"$origin",$value,"reason":"r","revertsChangeId":null,
            "revertedAt":${revertedAt?.let { "\"$it\"" } ?: "null"},"revertible":true,"createdAt":"2026-11-21T11:40:00Z"}"""
        val list = ProjectSettingChanges.of(j("""{"settingChanges":[
            ${change("c0", field = "LANDING_CHECK", value = """"oldValue":{"command":null,"timeoutSeconds":null,"none":false},"newValue":{"command":"make","timeoutSeconds":null,"none":false}""")},
            ${change("c1", taskId = "t2")},
            ${change("c2", exempt = false)},
            ${change("c3", revertedAt = "2026-11-21T11:50:00Z")},
            ${change("c4", origin = "CARD")},
            ${change("c5")}]}"""))!!
        val marked = ProjectSettingChanges.latestExemption(list, "t1")!!
        assertEquals("c4", marked.id)
        assertEquals("Approved on a card", LandingMeasuredCopy.who(marked.origin))
        assertEquals("marked 20m ago", LandingMeasuredCopy.markedAgo(ProjectTime.ago(marked.createdAt, java.time.Instant.parse("2026-11-21T12:00:00Z"))!!))
        assertNull(ProjectSettingChanges.latestExemption(list, "t3"))
        assertNull(ProjectSettingChanges.latestExemption(emptyList(), "t1"))
        assertNull(ProjectSettingChanges.latestExemption(null, "t1"))
    }

    // MARK: the landing's check list (P-C2, D5)

    @Test fun aLandingCheckItsTaskIsExemptFromIsSkippedNotFailed() {
        val exempt = LandingEntry("CHECK_FINISHED", "2026-11-20T11:47:00.000Z", 1, 1, "LANDING_CHECK", 2, null, null,
            "Landing check skipped · this task is exempt: Only moves cron entries.", buildJsonObject {
                put("name", "LANDING_CHECK"); put("skipped", "TASK_EXEMPT"); put("reason", "Only moves cron entries.")
                put("exitCode", JsonNull); put("expectedExitCode", 0); put("timedOut", false); put("durationMs", 0)
            })
        val acceptance = LandingEntry("CHECK_FINISHED", "2026-11-20T11:46:00.000Z", 1, 1, "TASK_ACCEPTANCE", 1, null, null,
            "Task acceptance passed · 14s", buildJsonObject { put("exitCode", 0); put("expectedExitCode", 0); put("timedOut", false) })
        val steps = LandingSteps.steps(listOf(acceptance, exempt), "LAND_TASK")
        val check = steps.single { it.key == "check:LANDING_CHECK" }
        assertFalse("an exempt landing check is not a failed one", LandingSteps.failed(check, "LAND_TASK"))
        assertEquals(exempt, LandingSteps.taskExempt(check))
        assertEquals("Only moves cron entries.", LandingSteps.exemptReason(exempt))
        assertEquals("Landing check · Skipped", LandingMeasuredCopy.skippedCheck(check.name))
        assertEquals("Exempt: Only moves cron entries.", LandingMeasuredCopy.exemptBecause(LandingSteps.exemptReason(exempt)))
        assertEquals("→", landingMark(exempt, "LAND_TASK", listOf(acceptance, exempt), 1).first)
        assertNull(LandingSteps.taskExempt(steps.single { it.key == "check:TASK_ACCEPTANCE" }))
        // The same line with no skip is the failure it always was.
        val failed = exempt.copy(data = buildJsonObject { put("exitCode", 1); put("expectedExitCode", 0); put("timedOut", false) })
        assertTrue(LandingSteps.failed(LandingSteps.steps(listOf(failed), "LAND_TASK").single(), "LAND_TASK"))
        assertEquals("✗", landingMark(failed, "LAND_TASK", listOf(failed), 0).first)
    }
}
