package io.orbitd.android.projects

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Contract revision 42 part two on a device, as the owner ruled it on the board (docs/mocks/landing-measured, D1–D9; Android follows
 * the iPhone frames), over the test's own controlled HTTP fixture — not a deployment. Three projects: ① one whose coordinator asks to
 * start with no line, ② one started with no line, and ③④⑤ one on a project branch whose coordinator set its landing check to No check,
 * exempted a task from it and so left two changes the owner may revert. Every frame leaves a screenshot in
 * files/landing-measured/<theme>; every write is checked against what the fixture received.
 */
@RunWith(AndroidJUnit4::class)
class LandingMeasuredDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("landing_measured_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "landing-measured/$theme").also { it.mkdirs() }
    private val writes = CopyOnWriteArrayList<Pair<String, JsonObject>>()
    private val calls = CopyOnWriteArrayList<String>()
    private val workspace = "34LandMeasuredWksp0001"
    private val asked = "34LandMeasuredProj0001"; private val noLine = "34LandMeasuredProj0002"; private val branch = "34LandMeasuredProj0003"
    private val projects = listOf(asked, noLine, branch)
    private val task = "34LandMeasuredTask0001"; private val landing = "34LandMeasuredLand0001"
    private val coordinators = mapOf(asked to "34LandMeasuredCoor0001", noLine to "34LandMeasuredCoor0002", branch to "34LandMeasuredCoor0003")
    private val workers = listOf("34LandMeasuredWork0001", "34LandMeasuredWork0002", "34LandMeasuredWork0003")
    private val ids = projects + task + landing + workspace + coordinators.values + workers
    private val titles = mapOf(asked to "Rotate staging credentials", noLine to "Retire the old staging VM", branch to "Staging database rotation")
    private val check = "npm run check:landing"
    private val reason = "Only moves cron entries; the landing check needs a database this task cannot reach."

    /** The branch project's landing check as the fixture's writes leave it: its value, who set it, and when. */
    @Volatile private var landingCommand: String? = null
    @Volatile private var landingNone = true
    @Volatile private var setBy = "COORDINATOR"
    @Volatile private var setAt = ago(12)
    @Volatile private var revertedAt: String? = null
    @Volatile private var exempt = true

    @Test fun theFiveScreensTheOwnerRuled() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("landing_measured_pid", android.os.Process.myPid().toString()) })
        runBlocking { app.session.restore() }
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        File(evidence, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\ntheme=$theme\n" +
            "scope=controlled HTTP fixture (MockWebServer in this test); not a deployed account\n")
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "measured@example.test", "measured-fixture-password") }
                scenario = ActivityScenario.launch(MainActivity::class.java)
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                // ① The coordinator's request with no line: one line where the line and the landing check were, Merge check kept (D1, D8).
                openDrawer(); await { exists(drawerRow(titles.getValue(asked))) }
                compose.onNode(drawerRow(titles.getValue(asked))).performClick(); settle()
                tap("project-sessions-review-start")
                await { exists(hasTestTag("project-start-request-no-line")) }
                compose.onNodeWithTag("project-start-request-no-line", useUnmergedTree = true).assertTextEquals(LandingMeasuredCopy.landsWhenATaskCommits)
                once("project-start-request-no-line")
                assertFalse(exists(hasTestTag("project-start-request-line")))
                assertFalse(exists(hasTestTag("project-start-request-main-branch")))
                assertFalse(exists(hasText(io.orbitd.android.core.cards.LandingCheckCopy.label)))
                compose.onNodeWithTag("project-start-request-at-most").performScrollTo()
                capture("01-start-card-no-line")
                compose.onNodeWithTag("project-start-request-confirm").performScrollTo().performClick()
                await { writes.any { it.first == "POST /api/projects/$asked/start" } }
                writes.last { it.first == "POST /api/projects/$asked/start" }.second.let { body ->
                    assertFalse("the start names no line", body.containsKey("line"))
                    assertFalse(body.containsKey("upstreamRef")); assertFalse(body.containsKey("landingCheckCommand"))
                    assertEquals("item-1", body["requestId"]?.jsonPrimitive?.content)
                    assertEquals("npm test", body["mergeCheckCommand"]?.jsonPrimitive?.content)
                }
                awaitGone("project-start-request-sheet")

                // ② A project started with no line: no landing card, no Landings row, nothing in their place (D2).
                openDrawer(); await { exists(drawerRow(titles.getValue(noLine))) }
                compose.onNode(drawerRow(titles.getValue(noLine))).performClick(); settle()
                await { exists(hasText(io.orbitd.android.directory.SessionProjectCopy.coordinatorSection)) }
                assertFalse(exists(hasTestTag("landings-row:line"), unmerged = true))
                assertFalse(exists(hasText("Landings")))
                capture("02a-sessions-page-no-line")
                open("orbit-project:$noLine"); awaitScrollTo("project-detail", hasTestTag("project-task:$noLine-t2"))
                assertFalse(exists(hasText("Pending landing")))
                assertFalse(exists(hasText("On project branch")))
                capture("02b-project-page-no-line")

                // ③ The landing check: the switch on No check, who set it and when, and the row to the coordinator's changes (D3, D4, D6).
                open("orbit-project:$branch"); awaitScrollTo("project-detail", hasTestTag("project-landing-check"))
                awaitScrollTo("project-detail", hasTestTag("project-coordinator-changes"))
                awaitScrollTo("project-detail", hasTestTag("project-landing-check"))
                compose.onNodeWithTag("project-landing-check-by:who", useUnmergedTree = true).assertTextEquals("Coordinator")
                assertTrue(exists(hasTestTag("project-landing-check-none"), unmerged = true))
                once("project-landing-check"); once("project-coordinator-changes")
                // Who can set it, under No check (web's LANDING_CHECK_ORIGIN_NOTES): the four pills and what each means.
                awaitScrollTo("project-detail", hasTestTag("project-landing-check-who-can-set"))
                for ((by, note) in LandingMeasuredCopy.originNotes) {
                    compose.onNodeWithTag("project-landing-check-who-can-set:$by:who", useUnmergedTree = true).assertTextEquals(LandingMeasuredCopy.who(by))
                    assertTrue(exists(hasText(note), unmerged = true))
                }
                awaitScrollTo("project-detail", hasTestTag("project-landing-check"))
                capture("03a-no-check-by-coordinator")

                // ⑤ The coordinator's changes, Revert asked first, and the row it leaves (D6, D7).
                tap("project-coordinator-changes"); await { exists(hasTestTag("coordinator-changes")) }
                once("coordinator-changes")
                await { exists(hasTestTag("change:c3:revert"), unmerged = true) }
                assertTrue(exists(hasTestTag("change:c1:note") and hasText(LandingMeasuredCopy.yourChange), unmerged = true))
                capture("05a-changes")
                tap("change:c3:revert"); await { exists(hasTestTag("revert-sheet-confirm")) }
                capture("05b-revert-confirm")
                tap("revert-sheet-confirm")
                await { writes.any { it.first == "POST /api/projects/$branch/setting-changes/c3/revert" } }
                await { exists(hasTestTag("change:c3:note"), unmerged = true) }
                assertFalse("the revert is said on the row it put back", exists(hasTestTag("change:c4"), unmerged = true))
                capture("05c-reverted")
                tap("coordinator-changes-back"); awaitGone("coordinator-changes")

                // ③ again, as the owner's own values: the command the revert put back, then No check pressed.
                awaitScrollTo("project-detail", hasTestTag("project-landing-check-command"))
                compose.onNodeWithTag("project-landing-check-by:who", useUnmergedTree = true).assertTextEquals("You")
                capture("03b-command-by-you")
                tap("project-landing-check-mode:NONE")
                await { writes.any { it.first == "PATCH /api/projects/$branch/integration" } }
                assertEquals(buildJsonObject { put("landingCheck", "NONE") }, writes.last { it.first == "PATCH /api/projects/$branch/integration" }.second)
                awaitScrollTo("project-detail", hasTestTag("project-landing-check-none"))
                // The page reads the project again after the write; the frame is the page once it is live again, not mid-read.
                await { compose.onAllNodesWithTag("project-landing-check-mode:MERGE_CHECK", useUnmergedTree = true).onFirst()
                    .fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
                capture("03c-no-check-by-you")

                // ④ A task exempt from the landing check: on its page, with the reason, who and when, and Remove exemption (D5).
                open("orbit-task:$task"); await { exists(hasTestTag("task-landing-exempt")) }
                compose.onNode(hasScrollAction() and hasAnyDescendant(hasTestTag("task-landing-exempt"))).performScrollToNode(hasTestTag("task-landing-exempt"))
                await { exists(hasTestTag("task-landing-exempt-by") and hasAnyDescendant(hasText("marked", substring = true)), unmerged = true) }
                capture("04a-task-exempt")
                // …and in the landing's check list: Skipped, with the reason, not failed.
                open("orbit-session:$landing"); await { exists(hasTestTag("landing:step-row:check:LANDING_CHECK")) }
                assertTrue(exists(hasTestTag("landing:step-name") and hasText("Landing check · Skipped"), unmerged = true))
                assertTrue(exists(hasTestTag("landing:step-summary") and hasText("Exempt: $reason"), unmerged = true))
                assertFalse(exists(hasTestTag("landing:step-status") and hasText("Failed"), unmerged = true))
                capture("04b-landing-check-skipped")
                open("orbit-task:$task"); await { exists(hasTestTag("task-landing-exempt-remove")) }
                compose.onNode(hasScrollAction() and hasAnyDescendant(hasTestTag("task-landing-exempt"))).performScrollToNode(hasTestTag("task-landing-exempt-remove"))
                tap("task-landing-exempt-remove")
                await { writes.any { it.first == "PATCH /api/tasks/$task" } }
                assertEquals(buildJsonObject { put("landingCheckExempt", false) }, writes.last { it.first == "PATCH /api/tasks/$task" }.second)
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                if (::scenario.isInitialized) scenario.close()
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                File(evidence, "writes.txt").writeText(writes.joinToString("\n") { "${it.first} ${it.second}" })
            }
        }
    }

    // MARK: the fixture

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun started(project: String) = project != asked

    private fun landingCheck() = """{"command":${if (landingNone) "\"NONE\"" else landingCommand?.let { "\"$it\"" } ?: "null"},"setBy":"$setBy",
        "setBySessionId":${if (setBy == "COORDINATOR") "\"${coordinators.getValue(branch)}\"" else "null"},"setAt":"$setAt"}"""

    private fun integration(project: String): String = when (project) {
        branch -> """{"line":"PROJECT_BRANCH","lineAbsentReason":null,"ref":"project/35Qa7mXk","upstreamRef":"main","upstreamChosenAt":null,"lastMainBranch":null,
            "source":"EXPLICIT","locked":true,"startedAt":"${ago(3 * 24 * 60)}","landingCheckCommand":${landingCommand?.let { "\"$it\"" } ?: "null"},
            "landingCheckTimeoutSeconds":null,"landingCheckCommandAbsentReason":${if (landingNone) "\"NONE\"" else if (landingCommand == null) "\"FALLS_BACK_TO_MERGE_CHECK\"" else "null"},
            "landingCheck":${landingCheck()},"mergeCheckCommand":"npm test","mergeCheckCommandAbsentReason":null,"mergeCheckTimeoutSeconds":null,"escalationSeconds":7200,
            "repository":"acme/infra","branches":null,"commitsAheadOfUpstream":2,"commitsAheadOfUpstreamAbsentReason":null,"lastUpstreamSyncAt":"${ago(60)}",
            "lastUpstreamSyncAbsentReason":null,"integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"PASSING","inFlight":null}"""
        // No codebase row: the read a project with no line gets (§12.16), with no landing check and no new field.
        else -> """{"line":null,"lineAbsentReason":"NOT_DECIDED","ref":null,"upstreamRef":null,"upstreamChosenAt":null,"lastMainBranch":null,"source":null,
            "locked":false,"startedAt":null,"landingCheckCommand":null,"landingCheckTimeoutSeconds":null,"mergeCheckCommand":null,
            "mergeCheckCommandAbsentReason":"NOT_CONFIGURED","mergeCheckTimeoutSeconds":null,"escalationSeconds":7200,"repository":null,"branches":null,
            "commitsAheadOfUpstream":null,"commitsAheadOfUpstreamAbsentReason":"NO_LANDING_YET","lastUpstreamSyncAt":null,"lastUpstreamSyncAbsentReason":"NEVER_SYNCED",
            "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"UNKNOWN","inFlight":null}"""
    }

    private fun changes(): String {
        val coord = coordinators.getValue(branch)
        val c3 = """{"id":"c3","projectId":"$branch","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
            "oldValue":{"command":"$check","timeoutSeconds":null,"none":false},"newValue":{"command":null,"timeoutSeconds":null,"none":true},
            "reason":"This project only changes infrastructure; the command has nothing to build.","writtenBySessionId":"$coord","revertsChangeId":null,
            "revertedAt":${revertedAt?.let { "\"$it\"" } ?: "null"},"revertible":${revertedAt == null && landingNone && setBy == "COORDINATOR"},"createdAt":"${ago(12)}"}"""
        val c2 = """{"id":"c2","projectId":"$branch","taskId":"$task","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
            "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"$reason"},"reason":"$reason","writtenBySessionId":"$coord",
            "revertsChangeId":null,"revertedAt":null,"revertible":$exempt,"createdAt":"${ago(20)}"}"""
        val c1 = """{"id":"c1","projectId":"$branch","taskId":null,"field":"LANDING_CHECK","origin":"OWNER",
            "oldValue":{"command":null,"timeoutSeconds":null,"none":false},"newValue":{"command":"$check","timeoutSeconds":null,"none":false},"reason":null,
            "writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,"revertible":false,"createdAt":"${ago(2 * 24 * 60)}"}"""
        // The owner's revert leaves a row of its own, which the list says on the row it put back.
        val c4 = revertedAt?.let { """{"id":"c4","projectId":"$branch","taskId":null,"field":"LANDING_CHECK","origin":"OWNER",
            "oldValue":{"command":null,"timeoutSeconds":null,"none":true},"newValue":{"command":"$check","timeoutSeconds":null,"none":false},"reason":null,
            "writtenBySessionId":null,"revertsChangeId":"c3","revertedAt":null,"revertible":false,"createdAt":"$it"}""" }
        return listOfNotNull(c4, c3, c2, c1).joinToString(",", "[", "]")
    }

    private fun document(project: String) = """{"id":"$project","title":"${titles.getValue(project)}","status":"OPEN","goal":"Rotate every staging credential.",
        "createdAt":"${ago(3 * 24 * 60)}","_count":{"tasks":6},"startedAt":${if (started(project)) "\"${ago(3 * 24 * 60)}\"" else "null"},
        "coordinatorSessionId":"${coordinators.getValue(project)}","coordinatorEnabled":true,"configRevision":"7","maxConcurrentTasks":3,
        "exceptionEscalationSeconds":7200,"pausedAt":null,"integration":${if (project == branch) """{"line":"PROJECT_BRANCH","ref":"project/35Qa7mXk","upstreamRef":"main",
        "escalationSeconds":7200}""" else """{"line":null,"upstreamRef":null,"escalationSeconds":7200}"""},
        "acceptanceCriteriaItems":[{"id":"$project-c1","key":"k1","ordinal":1,"text":"Staging DB password is rotated and every service reads the new one.","satisfied":false,"landing":null,"unmet":[]},
        {"id":"$project-c2","key":"k2","ordinal":2,"text":"No cron job runs on the old VM.","satisfied":false,"landing":null,"unmet":[]},
        {"id":"$project-c3","key":"k3","ordinal":3,"text":"Unused staging buckets are gone.","satisfied":false,"landing":null,"unmet":[]}]
        ${if (project == branch) ""","settingChanges":${changes()}""" else ""}}"""

    private val taskTitles = listOf("Rotate the staging database password", "Move cron jobs off the old VM", "Delete unused staging buckets",
        "Write the handover notes", "Restart the staging services", "Check the new password everywhere")
    private fun graph(project: String): String {
        val marks = taskTitles.mapIndexed { at, title -> """{"kind":"TASK","id":"$project-t${at + 1}","taskId":"$project-t${at + 1}","title":"$title",
            "status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true}""" }
        val edges = listOf(1 to 2, 1 to 3, 2 to 4, 3 to 5, 5 to 6).map { (from, to) -> """{"sourceMarkId":"$project-t$from","targetMarkId":"$project-t$to"}""" }
        return """{"marks":${marks.joinToString(",", "[", "]")},"edges":${edges.joinToString(",", "[", "]")},"taskCount":6,"folded":false,"truncated":false}"""
    }
    private fun taskPage(project: String): String {
        val rows = taskTitles.mapIndexed { at, title ->
            val status = when (at) { 0, 1, 2 -> "DONE"; 3 -> "IN_PROGRESS"; else -> "OPEN" }
            val id = if (project == branch && at == 1) task else "$project-t${at + 1}"
            """{"id":"$id","title":"$title","status":"$status","workState":"${if (status == "IN_PROGRESS") "RUNNING" else if (status == "DONE") "DONE" else "BLOCKED"}",
                "dependencyState":"${if (status == "OPEN") "WAITING" else "READY"}","landingWaitCount":0,"topoLevel":${at / 2},"autoRunWhenReady":true,
                "integration":${if (status == "DONE") (if (project == branch) """{"state":"ON_INTEGRATION_LINE"}""" else """{"state":"NOT_APPLICABLE"}""") else "null"}}"""
        }
        return """{"items":${rows.joinToString(",", "[", "]")},"nextCursor":null}"""
    }

    private fun openItems(project: String) = if (project != asked) """{"needsYou":[],"withCoordinator":[]}""" else """{"needsYou":[],"withCoordinator":[],
        "startRequest":{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"${ago(12)}","actions":[],
        "startRequest":{"settings":{"automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":"npm test"},"why":"",
        "criteriaDigest":"seal-$project","planDigest":"plan-1","repository":null,"warnings":[]}}}"""

    private fun sidebar() = projects.joinToString(",", "[", "]") { project -> """{"id":"$project","title":"${titles.getValue(project)}","status":"OPEN",
        "createdAt":"${ago(3 * 24 * 60)}","buckets":{"running":1},"taskCounts":{"done":3,"failed":0,"total":6},"attention":{},
        "startedAt":${if (started(project)) "\"${ago(3 * 24 * 60)}\"" else "null"},
        "integration":${if (project == branch) """{"line":"PROJECT_BRANCH","ref":"project/35Qa7mXk","activeJobCount":0}""" else """{"line":null,"activeJobCount":0}"""}}""" }

    private fun member(project: String, role: String) = """"projectMembership":{"projectId":"$project","projectTitle":"${titles.getValue(project)}","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, run: String, extra: String, minutes: Long) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"OPEN","agent":{"id":"$workspace","name":"infra"},
            "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"${ago(minutes)}","pendingApprovals":0,"tags":[],
            "capabilities":{"canComplete":true,"canRestore":false}$extra}"""
    private fun members(project: String) = listOf(
        row(coordinators.getValue(project), titles.getValue(project), "AWAITING_INPUT",
            ""","lastAssistantText":"Two tasks running; the third waits on the first.",${member(project, "COORDINATOR")}""", 0),
        row(workers[0], taskTitles[1], "RUNNING", ""","lastAssistantText":"Moved 4 of 6 cron jobs…",${member(project, "TASK")}""", 0),
        row(workers[1], taskTitles[0], "AWAITING_INPUT", ""","lastAssistantText":"Rotated; services restarted.",${member(project, "TASK")}""", 9),
        row(workers[2], taskTitles[2], "AWAITING_INPUT", ""","lastAssistantText":"Deleted 3 buckets; listed the rest.",${member(project, "TASK")}""", 31),
    ).joinToString(",", "[", "]")

    private fun taskDetail() = buildJsonObject {
        put("id", task); put("title", "Move cron jobs off the old VM"); put("status", "DONE"); put("projectId", branch)
        put("project", buildJsonObject { put("id", branch); put("title", titles.getValue(branch)) })
        put("createdAt", ago(7_200)); put("updatedAt", ago(if (exempt) 20 else 0)); put("creatorName", "coordinator"); put("autoRunWhenReady", true)
        put("attachments", JsonArray(emptyList())); put("sessions", JsonArray(emptyList())); put("comments", JsonArray(emptyList()))
        put("dependsOn", JsonArray(emptyList()))
        put("landingCheckExempt", exempt)
        put("landingCheckExemptReason", if (exempt) JsonPrimitive(reason) else JsonNull)
        put("landingCheckExemptBySessionId", if (exempt) JsonPrimitive(coordinators.getValue(branch)) else JsonNull)
        put("integration", Json.parseToJsonElement("""{"state":"ON_INTEGRATION_LINE","landTask":{"state":"LANDED","jobId":"j-1","generation":"1",
            "targetRef":"refs/heads/project/35Qa7mXk","waitMs":4000,"queuedAt":"${ago(5)}","startedAt":"${ago(5)}","heartbeatAt":"${ago(3)}",
            "finishedAt":"${ago(3)}","landingSessionId":"$landing"}}"""))
    }.toString()

    private fun landingView(): String {
        val attempt = """{"jobId":"j-1","kind":"LAND_TASK","state":"LANDED","generation":1,"phase":null,"round":1,"step":null,"claim":1,
            "runnerName":"infra","sourceSessionId":"$landing","targetRef":"refs/heads/project/35Qa7mXk","startedAt":"${ago(5)}",
            "heartbeatAt":"${ago(3)}","outputMovedAt":"${ago(3)}","progressProtocol":"v2","check":null,"liveness":null,
            "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":true}"""
        val timeline = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,"state":"LANDED","entries":[
            {"kind":"ENQUEUED","at":"${ago(5)}","claim":0,"text":"Task marked done · queued to land"},
            {"kind":"CLAIMED","at":"${ago(5)}","claim":1,"text":"Claimed by runner infra · claim 1"},
            {"kind":"CHECK_STARTED","at":"${ago(5)}","claim":1,"round":1,"check":{"name":"TASK_ACCEPTANCE","index":1},"text":"Task acceptance started · claim 1 · infra"},
            {"kind":"CHECK_FINISHED","at":"${ago(4)}","claim":1,"round":1,"check":{"name":"TASK_ACCEPTANCE","index":1},
             "data":{"exitCode":0,"expectedExitCode":0,"timedOut":false,"durationMs":14000},"text":"Task acceptance passed · 0m 14s"},
            {"kind":"CHECK_FINISHED","at":"${ago(4)}","claim":1,"round":1,"check":{"name":"LANDING_CHECK","index":2},
             "data":{"exitCode":null,"expectedExitCode":0,"timedOut":false,"durationMs":0,"skipped":"TASK_EXEMPT","reason":"$reason"},
             "text":"Landing check skipped · this task is exempt: $reason"},
            {"kind":"RESULT","at":"${ago(3)}","claim":1,"round":1,"data":{"state":"LANDED"},"text":"Landed on project/35Qa7mXk"}]}],"facts":[]}"""
        return """{"sessionId":"$landing","projectId":"$branch","subject":"TASK","taskId":"$task","promotionId":null,"episode":1,
            "openedAt":"${ago(5)}","settledAt":"${ago(3)}","settledAs":"LANDED","checks":[{"name":"TASK_ACCEPTANCE","expectedExitCode":0,"exitCode":0,"timedOut":false,
            "durationMs":14000},{"name":"LANDING_CHECK","expectedExitCode":0,"exitCode":null,"timedOut":false,"durationMs":0,"skipped":"TASK_EXEMPT","reason":"$reason"}],
            "currentAttempt":$attempt,"todos":[],"generations":[],"timeline":$timeline}"""
    }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer measured-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
            if (request.method != "GET" && path !in listOf("/api/auth/login", "/api/auth/logout")) {
                val body = request.body.readUtf8().takeIf { it.isNotBlank() }?.let { Json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
                writes += "${request.method} /api/${parts.joinToString("/")}" to body
                when {
                    parts == listOf("projects", branch, "setting-changes", "c3", "revert") -> {
                        landingNone = false; landingCommand = check; setBy = "OWNER"; setAt = ago(0); revertedAt = ago(0)
                    }
                    parts == listOf("projects", branch, "integration") -> {
                        if (body["landingCheck"]?.jsonPrimitive?.content == "NONE") { landingNone = true; landingCommand = null }
                        else if (body.containsKey("landingCheckCommand")) { landingNone = false; landingCommand = body["landingCheckCommand"]?.jsonPrimitive?.contentOrNull }
                        setBy = "OWNER"; setAt = ago(0)
                    }
                    parts == listOf("tasks", task) -> body["landingCheckExempt"]?.jsonPrimitive?.booleanOrNull?.let { exempt = it }
                }
                val answer = when {
                    parts.size == 3 && parts[2] == "integration" -> integration(parts[1])
                    parts == listOf("tasks", task) -> taskDetail()
                    else -> "{}"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(answer)
            }
            val project = request.requestUrl!!.queryParameter("projectId")?.let { id -> projects.firstOrNull { ObjectId.same(it, id) } }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"measured-fixture-access","refreshToken":"measured-fixture-refresh","user":{"id":"u1","email":"measured@example.test","name":"Measured fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"measured@example.test","name":"Measured fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$workspace","name":"infra","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/sessions" && project != null -> if (view == "open") members(project) else "[]"
                path == "/api/sessions" -> "[]"
                parts[0] == "sessions" && parts.size == 2 && parts[1] == landing -> """{"id":"$landing","title":"Land · Move cron jobs off the old VM",
                    "status":"SUCCEEDED","sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":${landingView()}}"""
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                parts == listOf("tasks", task) -> taskDetail()
                path == "/api/projects/sidebar" || path == "/api/projects" -> sidebar()
                parts[0] == "projects" && parts.size >= 2 && parts[1] in projects -> {
                    val p = parts[1]
                    when (parts.drop(2).joinToString("/")) {
                        "" -> document(p)
                        "integration" -> integration(p)
                        "open-items" -> openItems(p)
                        "acceptance/confirmation" -> """{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"seal-$p","material":[]}}"""
                        "dependency-graph" -> graph(p)
                        "panorama" -> """{"buckets":{"running":1,"ready":0,"blocked":2,"done":3,"integrating":0,"onIntegrationLine":${if (p == branch) 3 else 0},
                            "onUpstream":0,"doneNotIntegrated":${if (p == branch) 0 else 3},"waitingForLanding":0,"awaitingVerification":0,"failed":0,"cancelled":0},
                            "shape":{"taskCount":6,"edgeCount":5}}"""
                        "tasks/page" -> taskPage(p)
                        "promotions/current" -> return MockResponse().setResponseCode(200)
                        "promotions/merged", "handoffs" -> "[]"
                        "coordinator/status" -> """{"projectId":"$p","readAt":"${ago(0)}","state":"NEVER_OPENED","coordination":null}"""
                        else -> "{}"
                    }
                }
                parts[0] == "wiki" -> return MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
                path.endsWith("/logout") -> "{}"
                request.method == "GET" -> "[]"
                else -> "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }

    // A finite response reconnects and re-reads the lists while the journey looks at them: hold it open.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    // MARK: driving the app

    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    /** One implementation draws each of these, once: a merge that kept a second port would draw two (gate task 3518Clf5xuFjeOHF28kFq). */
    private fun once(tag: String) = assertEquals("$tag drawn once", 1, compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size)
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    private fun awaitGone(tag: String) = await { !exists(hasTestTag(tag)) }
    private fun openDrawer() { compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick(); settle() }
    /** Scrolls a list to a row that arrives with a later read. */
    private fun awaitScrollTo(list: String, matcher: SemanticsMatcher) {
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (true) {
            try { compose.onNode(hasTestTag(list) and hasScrollAction()).performScrollToNode(matcher); return }
            catch (missing: AssertionError) { if (SystemClock.uptimeMillis() > deadline) throw missing; SystemClock.sleep(250); compose.waitForIdle() }
        }
    }
    /** Taps a node once it is there and enabled, through its click action: a dialog still settling refuses injected touches. */
    private fun tap(tag: String) {
        await { exists(hasTestTag(tag), unmerged = true) }
        await { compose.onAllNodesWithTag(tag, useUnmergedTree = true).onFirst().fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).onFirst().performSemanticsAction(SemanticsActions.OnClick)
        settle()
    }
    /** A warm link delivered to the running activity, as the other journeys open theirs. */
    private fun open(uri: String) = scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }.also { settle() }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(700) // dialog windows fade in outside Compose's idling
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
