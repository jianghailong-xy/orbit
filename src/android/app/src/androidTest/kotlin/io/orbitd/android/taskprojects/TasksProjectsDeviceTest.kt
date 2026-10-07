package io.orbitd.android.taskprojects

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.tasks.OFFLINE_NOTE
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.tasks.TaskListCopy
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Product MainActivity and real AuthSession HTTP; authority is a controlled, explicitly named fixture
 * (scripts/tasks-projects-fixture.py), never a deployed account. Every journey asserts the server's own
 * record (`/__stats`), not only what the screen shows. */
@RunWith(AndroidJUnit4::class)
class TasksProjectsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server = "http://127.0.0.1:18771"
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private val taskId = "34ZaIKb2sLBtndX7DqxHH"          // "A11 task checklist", filed under no project
    private val prerequisiteId = "34ZaIKb2sLBtndX7DqxHI"  // "A11 prerequisite", done
    private val projectTaskId = "34ZaIKb2sLBtndX7DqxHG"   // "A11 project delivery"
    private val projectId = "34ZZn8fmemArxvl2CsCFp"
    private val sessionId = "34ZaIKKTQq8IdW0pn90xH"

    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun journal() = http("/__stats").objects("journal")
    private fun awaitText(text: String, timeout: Long = 20_000) {
        compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun awaitTag(tag: String, timeout: Long = 20_000) { compose.waitUntil(timeout) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
    private fun awaitGone(tag: String, timeout: Long = 20_000) { compose.waitUntil(timeout) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() } }
    private fun scrollTo(list: String, matcher: SemanticsMatcher) = compose.onNodeWithTag(list).performScrollToNode(matcher)
    private fun tap(tag: String, list: String? = null) {
        if (list != null) scrollTo(list, hasTestTag(tag))
        compose.onNodeWithTag(tag).performClick()
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun open(uri: String) { compose.runOnUiThread { compose.activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(compose.activity, MainActivity::class.java)) } }
    private fun drawer(entry: String) {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        awaitText(entry)
        compose.onAllNodesWithText(entry).onFirst().performClick()
    }
    private fun back() = compose.onNodeWithContentDescription("Back").performClick()
    private fun login(case: String = "normal", mode: String = "") {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=controlled HTTP fixture; no real deployed account\n")
        http("/__control", """{"reset":true,"case":"$case","mode":"$mode"}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Instance address")
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextReplacement("a08@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a08-fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) { capture("$name-failed"); throw error }
        finally {
            runCatching { http("/__control", """{"streamDown":false}""") }
            File(output, "$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() }
        }
    }

    // MARK: session → object → back

    @Test fun sourceConversationTaskAndProjectReturnKeepDraft() = journey("source-return") {
        login(); open("orbit-session:$sessionId"); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").performTextInput("A11 return draft")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        scrollTo("transcript-list", hasText("Open A11 task"))
        compose.onNodeWithText("Open A11 task").performTouchInput { click() }
        awaitTag("task-detail"); awaitText("A11 task checklist"); capture("task-from-conversation")
        compose.activityRule.scenario.recreate(); awaitTag("task-detail"); awaitText("A11 task checklist")
        back(); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").assertTextContains("A11 return draft")
        scrollTo("transcript-list", hasText("Open A11 project"))
        compose.onNodeWithText("Open A11 project").performTouchInput { click() }
        awaitTag("project-detail"); awaitText("A11 Android launch"); capture("project-from-conversation")
        back(); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").assertTextContains("A11 return draft")
        capture("original-conversation-and-draft")
    }

    // MARK: Tasks

    @Test fun taskSearchAndLabelsKeepScopeThroughRecreation() = journey("tasks-search-labels") {
        login(); drawer("Tasks")
        awaitTag("tasks-list"); awaitText("A11 task checklist"); capture("tasks-list")
        compose.onNodeWithTag("task-search").performTextInput("checklist")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        tap("tasks-options"); compose.onNodeWithText(TaskListCopy.filterByLabel).performClick()
        awaitTag("task-labels"); tap("task-label:Sprint, one", "task-labels"); tap("task-labels-done")
        compose.activityRule.scenario.recreate(); awaitTag("task-search")
        compose.onNodeWithTag("task-search").assertTextContains("checklist")
        awaitText("A11 task checklist"); capture("tasks-filter-restored")
        compose.waitUntil(20_000) { journal().any { row ->
            val query = row.obj("query")
            row.text("method") == "GET" && row.text("path") == "/api/tasks/page" && query != null &&
                query.strings("q") == listOf("checklist") && query.strings("projectId") == listOf("none") && query.strings("labels") == listOf("Sprint, one")
        } }
        tap("task:$taskId", "tasks-list"); awaitTag("task-detail"); awaitText("A11 task checklist")
        back(); awaitTag("task-search")
        compose.onNodeWithTag("task-search").assertTextContains("checklist")
    }

    @Test fun taskDetailWritesGoThroughTheServersOwnRecord() = journey("task-detail-writes") {
        login()
        http("/__control", """{"task":{"id":"$taskId","runAt":"2030-01-01T00:00:00.000Z"}}""")
        open("orbit-task:$taskId"); awaitTag("task-detail"); awaitText("A11 task checklist"); capture("task-detail")
        // A prerequisite, picked from the server's own candidates.
        tap("task-add-prerequisite", "task-detail"); awaitTag("task-dependency-picker")
        compose.onNodeWithTag("task-dependency-search").performTextInput("A11 prerequisite")
        awaitTag("candidate:$prerequisiteId"); tap("candidate:$prerequisiteId")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.objects("dependsOn")?.size == 1 }
        assertTrue(journal().any { it.text("path") == "/api/tasks/$taskId/dependencies" && it.obj("body")?.text("dependsOnTaskId") == prerequisiteId })
        scrollTo("task-detail", hasTestTag("task-dependencies-section")); awaitText("A11 prerequisite"); capture("task-dependencies")
        // The scheduled start, cancelled.
        tap("task-start-at", "task-detail"); awaitTag("task-schedule-sheet"); capture("task-edit-schedule"); tap("task-cancel-schedule")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.get("runAt") == JsonNull }
        // The acceptance, edited.
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet")
        compose.onNodeWithTag("task-acceptance-criteria").performTextReplacement("The controlled contract is checked twice.")
        capture("task-edit-acceptance"); tap("task-save-acceptance")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.text("acceptanceCriteria") == "The controlled contract is checked twice." }
        // A comment, then the run, named once.
        compose.onNodeWithTag("task-comment").performTextInput("A11 controlled comment")
        tap("task-post-comment")
        compose.waitUntil(20_000) { journal().any {
            it.text("method") == "POST" && it.text("path")?.endsWith("/comments") == true && it.obj("body")?.text("body") == "A11 controlled comment"
        } }
        scrollTo("task-detail", hasText("A11 controlled comment"))
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").assertTextContains(TaskDetailCopy.runNow).performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.flag("running") == true }
        val runs = journal().filter { it.text("path") == "/api/tasks/$taskId/execute" }
        assertEquals(1, runs.mapNotNull { it.obj("body")?.text("triggerId") }.distinct().size)
        scrollTo("task-detail", hasTestTag("task-run")); capture("task-running")
    }

    @Test fun anOfflineAccountWritesNothingAndAWithdrawnTaskIsNoLongerShown() = journey("task-offline-revocation") {
        login(); open("orbit-task:$taskId"); awaitTag("task-detail"); awaitText("A11 task checklist")
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").assertIsEnabled()
        http("/__control", """{"streamDown":true}""")
        awaitText(OFFLINE_NOTE, 60_000)
        compose.onNodeWithTag("task-run").assertIsNotEnabled()
        compose.onNodeWithTag("task-post-comment").assertIsNotEnabled()
        capture("task-offline-gated")
        val writes = journal().count { it.text("method") != "GET" }
        http("/__control", """{"streamDown":false}""")
        compose.waitUntil(90_000) { compose.onAllNodesWithText(OFFLINE_NOTE, substring = true).fetchSemanticsNodes().isEmpty() }
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").assertIsEnabled()
        assertEquals("nothing was sent while the account stream was down", writes, journal().count { it.text("method") != "GET" })
        http("/__control", """{"denyTasks":true}""")
        awaitText(TaskDetailCopy.loadFailed); awaitText("Permission denied")
        compose.onAllNodesWithTag("task-comment").assertCountEquals(0)
        compose.onAllNodesWithTag("task-run").assertCountEquals(0)
        capture("task-permission-withdrawn")
    }

    // MARK: Projects

    @Test fun projectIndexProgressHowItRunsAndGraph() = journey("project-page") {
        login(); drawer("Projects")
        awaitTag("projects-list"); awaitText("A11 Android launch"); capture("projects-list")
        tap("project:$projectId", "projects-list"); awaitTag("project-detail"); awaitText("A11 Android launch")
        awaitTag("project-overview"); capture("project-detail")
        scrollTo("project-detail", hasTestTag("project-settings")); capture("project-how-it-runs")
        // At most: the presses move the number now; one write carries where they stopped, fenced on the revision read.
        tap("project-at-most-plus", "project-detail")
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.number("maxConcurrentTasks") == 3 }
        val limit = journal().last { it.text("method") == "PATCH" && it.text("path") == "/api/projects/$projectId" }
        assertEquals("1", limit.obj("body")?.text("expectedConfigRevision")); assertEquals(3, limit.obj("body")?.number("maxConcurrentTasks"))
        // Automatic writes `automatic`, never `coordinatorEnabled`.
        compose.waitUntil(20_000) { compose.onAllNodesWithText("3 ${RunSettings.tasksAtATime(3)}").fetchSemanticsNodes().isNotEmpty() }
        tap("project-automatic", "project-detail")
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.flag("coordinatorEnabled") == false }
        val automatic = journal().last { it.text("method") == "PATCH" && it.text("path") == "/api/projects/$projectId" }.obj("body")!!
        assertEquals(setOf("automatic", "expectedConfigRevision"), automatic.keys); assertEquals("2", automatic.text("expectedConfigRevision"))
        // The graph, full screen, opens the task a mark names; Back returns to the page.
        scrollTo("project-detail", hasText("Expand graph")); compose.onNodeWithText("Expand graph").performClick()
        awaitTag("project-graph-fullscreen"); compose.onNodeWithText("Zoom in").performClick(); capture("project-graph")
        compose.onNode(hasTestTag("graph-mark:$projectTaskId") and hasAnyAncestor(hasTestTag("project-graph-fullscreen"))).performClick()
        awaitTag("task-detail"); awaitText("A11 project delivery")
        back(); awaitTag("project-detail"); awaitText("A11 Android launch")
        capture("graph-return-project")
    }

    @Test fun aStaleSettingIsRefusedAndAWithdrawnProjectIsNoLongerShown() = journey("project-conflict-permission") {
        login(); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        http("/__control", """{"mode":"conflict"}""")
        tap("project-at-most-plus", "project-detail")
        awaitText("${RunSettings.notSaved} — The resource changed on another client"); capture("project-stale-settings-refusal")
        assertEquals(2, http("/__stats").obj("project")?.number("maxConcurrentTasks"))
        compose.onNodeWithTag("project-notice-ok").performClick()
        http("/__control", """{"mode":"","denyProjects":true}""")
        awaitText(ProjectPage.gone); awaitText(ProjectPage.goneDetail)
        compose.onAllNodesWithTag("project-coordinator").assertCountEquals(0)
        compose.onAllNodesWithTag("project-settings").assertCountEquals(0); capture("project-permission-withdrawn")
    }

    @Test fun anExceptionIsReviewedOnTheCoordinatorsCardAndThePageIsReturnedTo() = journey("project-review-handoff") {
        login(case = "x1"); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        awaitTag("open-item:x1"); capture("project-open-items")
        scrollTo("project-detail", hasTestTag("project-coordinator-section")); capture("project-coordinator-entry")
        scrollTo("project-detail", hasTestTag("open-item:x1")); compose.onNodeWithTag("open-item:x1").performClick()
        awaitTag("interaction-cards")
        scrollTo("transcript-list", hasTestTag("item:x1")); capture("exception-existing-card")
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithText("Why is it no longer open?").performScrollTo().performTextInput("Checked the fixed source and current server record")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.waitUntil(20_000) { journal().any { row ->
            row.text("method") == "POST" && row.text("path") == "/api/projects/$projectId/open-items/x1/resolve" &&
                row.obj("body")?.text("note") == "Checked the fixed source and current server record"
        } }
        assertFalse(http("/__stats").flag("pending")); capture("exception-recorded-after-handoff")
        assertTrue(journal().any { it.text("method") == "POST" && it.text("path") == "/api/projects/$projectId/coordinator" })
        back(); awaitTag("project-detail"); awaitText("A11 Android launch")
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("open-item:x1").fetchSemanticsNodes().isEmpty() }
        capture("review-return-project")
    }

    @Test fun theOwnerStartsAProjectNobodyAskedAbout() = journey("project-owner-start") {
        login(case = "own-start"); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        awaitTag("project-start-own"); compose.onAllNodesWithTag("project-settings").assertCountEquals(0); capture("project-not-started")
        tap("project-start-own"); awaitTag("project-start-confirm"); capture("project-start-sheet")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().assertTextContains(StartProjectCopy.action).performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.text("startedAt") != null && http("/__stats").text("case") == "normal" }
        val start = journal().last { it.text("path") == "/api/projects/$projectId/start" }.obj("body")!!
        assertEquals("seal1", start.text("criteriaDigest")); assertEquals(JsonNull, start["requestId"])
        assertEquals("PROJECT_BRANCH", start.text("line")); assertEquals("refs/heads/project/a11", start.text("projectBranchName"))
        awaitGone("project-start-sheet"); awaitTag("project-settings"); compose.onAllNodesWithTag("project-start-own").assertCountEquals(0)
        capture("project-started")
    }

    @Test fun aDeliveryBlockerIsReviewedWithItsReasonRecorded() = journey("project-blocker") {
        login()
        http("/__control", """{"project":{"blockers":{"open":[{"id":"blk1","kind":"DELIVERY_REVIEW","owner":"USER","severity":"WARNING",
            "requiredAction":"Review the files this delivery changed outside its declared scope.","subjectTitle":"A11 project delivery","subjectTaskId":"$projectTaskId",
            "firstSeenAt":"2026-10-04T22:00:00.000Z","detail":{"reason":"OUTSIDE_DECLARED_SCOPE","paths":["src/android/app/build.gradle.kts","src/android/app/src/main/AndroidManifest.xml"]}}],
            "resolved":[],"resolvedCount":0}}}""".replace("\n", ""))
        open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        scrollTo("project-detail", hasTestTag("blocker:blk1")); awaitText("Changed files it didn’t declare"); capture("project-blocker")
        tap("blocker:blk1:resolve", "project-detail"); awaitTag("blocker-reason")
        compose.onNodeWithTag("blocker-reason").performTextInput("Both files belong to the declared Android shell change")
        capture("project-blocker-review")
        compose.onNodeWithTag("blocker-resolve-confirm").assertTextContains("Accept these files").performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.obj("blockers")?.number("resolvedCount") == 1 }
        val resolve = journal().last { it.text("path") == "/api/projects/$projectId/blockers/blk1/resolve" }
        assertEquals("Both files belong to the declared Android shell change", resolve.obj("body")?.text("reason"))
        awaitText("1 resolved · latest: Resolved by you — Both files belong to the declared Android shell change")
        capture("project-blocker-resolved")
    }

    // MARK: screens for the owner (run again under dark mode and a large font)

    @Test fun screensTour() = journey("screens") {
        login(case = "x1"); drawer("Tasks")
        awaitTag("tasks-list"); awaitText("A11 task checklist"); capture("tour-1-tasks-list")
        open("orbit-task:$projectTaskId"); awaitTag("task-detail"); awaitText("A11 project delivery"); capture("tour-2-task-detail")
        scrollTo("task-detail", hasTestTag("task-dependencies-section")); capture("tour-3-task-dependencies")
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet"); capture("tour-4-task-edit")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); awaitGone("task-acceptance-sheet")
        drawer("Projects"); awaitTag("projects-list"); awaitText("A11 Android launch"); capture("tour-5-projects-list")
        tap("project:$projectId", "projects-list"); awaitTag("project-detail"); awaitTag("open-item:x1"); capture("tour-6-project-detail")
        scrollTo("project-detail", hasTestTag("project-overview")); capture("tour-7-project-progress")
        scrollTo("project-detail", hasTestTag("project-coordinator-section")); capture("tour-8-coordinator-entry")
        scrollTo("project-detail", hasTestTag("open-item:x1")); compose.onNodeWithTag("open-item:x1").performClick()
        awaitTag("interaction-cards"); scrollTo("transcript-list", hasTestTag("item:x1")); capture("tour-9-review-card")
    }
}
