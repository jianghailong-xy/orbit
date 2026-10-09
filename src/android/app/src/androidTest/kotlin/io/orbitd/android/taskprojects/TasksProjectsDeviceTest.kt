package io.orbitd.android.taskprojects

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.projects.ProjectDone
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
    /** The page itself loaded (its list, not the loading placeholder that carries the same tag), with these words in it —
     * scrolled to, since a page returned to keeps where it was scrolled. Not the same words elsewhere (the drawer lists projects). */
    private fun awaitIn(page: String, text: String, timeout: Long = 20_000) {
        compose.waitUntil(timeout) { compose.onAllNodes(hasTestTag(page) and hasScrollAction()).fetchSemanticsNodes().isNotEmpty() }
        awaitScrollTo(page, hasText(text, substring = true), timeout)
    }
    private fun scrollTo(list: String, matcher: SemanticsMatcher) = compose.onNodeWithTag(list).performScrollToNode(matcher)
    /** Scrolls to a row that arrives with a later read (a card once its conversation is fresh). */
    private fun awaitScrollTo(list: String, matcher: SemanticsMatcher, timeout: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (true) {
            try { compose.onNodeWithTag(list).performScrollToNode(matcher); return }
            catch (missing: AssertionError) { if (SystemClock.uptimeMillis() > deadline) throw missing; SystemClock.sleep(250); compose.waitForIdle() }
        }
    }
    private fun tap(tag: String, list: String? = null) {
        if (list != null) scrollTo(list, hasTestTag(tag))
        // A loaded shared emulator sometimes refuses one injected touch; the press itself is what is tested.
        try { compose.onNodeWithTag(tag).performClick() }
        catch (refused: AssertionError) {
            if (refused.message?.contains("inject") != true) throw refused
            SystemClock.sleep(500); compose.waitForIdle()
            compose.onNodeWithTag(tag).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        }
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        SystemClock.sleep(700) // dialog windows fade in outside Compose's idling

        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    /** A warm link delivered to the running activity, as A06's TranscriptDeviceTest does: a second
     * MainActivity instance would leave the rule's own activity paused under it. */
    private fun open(uri: String) = compose.activityRule.scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }
    /** Both semantics trees as the test saw them when a journey failed. */
    private fun trees(name: String) = runCatching {
        File(output, "$name-tree.txt").writeText(buildString {
            for (unmerged in listOf(false, true)) {
                val roots = compose.onAllNodes(isRoot(), useUnmergedTree = unmerged)
                val count = roots.fetchSemanticsNodes(atLeastOneRootRequired = false).size
                appendLine("== ${if (unmerged) "unmerged" else "merged"} tree, $count root(s)")
                for (i in 0 until count) appendLine(roots[i].printToString(Int.MAX_VALUE))
            }
        })
    }
    private fun drawer(entry: String) {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        awaitText(entry)
        compose.onAllNodesWithText(entry).onFirst().performClick()
    }
    private fun back() = compose.onNodeWithContentDescription("Back").performClick()
    /** Closes the keyboard without a Back key: on API 29 an injected Back reaches the page, not the keyboard. */
    private fun hideKeyboard() = compose.activityRule.scenario.onActivity { activity ->
        androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime())
    }
    private fun login(case: String = "normal", mode: String = "") {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=controlled HTTP fixture; no real deployed account\n")
        // The Tasks filter is remembered across launches (as iOS's); each journey starts from the default one.
        app.getSharedPreferences("orbit.tasks", Context.MODE_PRIVATE).edit().clear().commit()
        http("/__control", """{"reset":true,"case":"$case","mode":"$mode"}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a08@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a08-fixture-password")
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) {
            // Kept beside the screenshot: a crash while the Activity is torn down can replace the test's own report.
            runCatching { File(output, "$name-error.txt").writeText(error.stackTraceToString()) }
            capture("$name-failed"); trees(name); throw error
        }
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
        awaitIn("task-detail", "A11 task checklist"); capture("task-from-conversation")
        compose.activityRule.scenario.recreate(); awaitIn("task-detail", "A11 task checklist")
        back(); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").assertTextContains("A11 return draft")
        scrollTo("transcript-list", hasText("Open A11 project"))
        compose.onNodeWithText("Open A11 project").performTouchInput { click() }
        awaitIn("project-detail", "A11 Android launch"); capture("project-from-conversation")
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
        tap("task:$taskId", "tasks-list"); awaitIn("task-detail", "A11 task checklist")
        back(); awaitTag("task-search")
        compose.onNodeWithTag("task-search").assertTextContains("checklist")
    }

    @Test fun taskDetailWritesGoThroughTheServersOwnRecord() = journey("task-detail-writes") {
        login()
        http("/__control", """{"task":{"id":"$taskId","runAt":"2030-01-01T00:00:00.000Z"}}""")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist"); capture("task-detail")
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
        login(); open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        compose.onNodeWithTag("task-comment").performTextInput("Typed before the outage")
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").assertIsEnabled()
        compose.onNodeWithTag("task-post-comment").assertIsEnabled()
        val writes = journal().count { it.text("method") != "GET" }
        http("/__control", """{"streamDown":true}""")
        awaitText(OFFLINE_NOTE, 60_000)
        compose.onNodeWithTag("task-run").assertIsNotEnabled()
        compose.onNodeWithTag("task-post-comment").assertIsNotEnabled()
        capture("task-offline-gated")
        http("/__control", """{"streamDown":false}""")
        compose.waitUntil(90_000) { compose.onAllNodesWithText(OFFLINE_NOTE, substring = true).fetchSemanticsNodes().isEmpty() }
        assertEquals("nothing was sent while the account stream was down", writes, journal().count { it.text("method") != "GET" })
        // The draft survived the outage and goes out once the account is back.
        compose.onNodeWithTag("task-post-comment").assertIsEnabled().performClick()
        compose.waitUntil(20_000) { journal().any { it.text("method") == "POST" && it.obj("body")?.text("body") == "Typed before the outage" } }
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
        tap("project:$projectId", "projects-list"); awaitIn("project-detail", "A11 Android launch")
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
        awaitIn("task-detail", "A11 project delivery")
        back(); awaitIn("project-detail", "A11 Android launch")
        capture("graph-return-project")
    }

    @Test fun aStaleSettingIsRefusedAndAWithdrawnProjectIsNoLongerShown() = journey("project-conflict-permission") {
        login(); open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
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
        login(case = "x1"); open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        // A11-4: the page says only that something needs the owner; the toolbar's Open items holds the items.
        awaitScrollTo("project-detail", hasTestTag("open-items-attention"))
        compose.onNodeWithTag("open-items-attention").assertTextContains("1 item needs you", substring = true); capture("project-open-items-reminder")
        compose.onAllNodesWithTag("open-item:x1").assertCountEquals(0)
        tap("project-open-items"); awaitTag("open-item:x1"); capture("project-open-items")
        compose.onNodeWithTag("project-open-items-subtitle").assertTextContains("1 item needs you", substring = true)
        tap("project-open-items-close"); awaitGone("project-open-items-sheet")
        scrollTo("project-detail", hasTestTag("project-coordinator-section")); capture("project-coordinator-entry")
        tap("open-items-attention", "project-detail"); awaitTag("open-item:x1"); compose.onNodeWithTag("open-item:x1").performClick()
        awaitTag("interaction-cards")
        awaitScrollTo("transcript-list", hasTestTag("item:x1")); capture("exception-existing-card")
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithText("Why is it no longer open?").performScrollTo().performTextInput("Checked the fixed source and current server record")
        hideKeyboard()
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.waitUntil(20_000) { journal().any { row ->
            row.text("method") == "POST" && row.text("path") == "/api/projects/$projectId/open-items/x1/resolve" &&
                row.obj("body")?.text("note") == "Checked the fixed source and current server record"
        } }
        assertFalse(http("/__stats").flag("pending")); capture("exception-recorded-after-handoff")
        assertTrue(journal().any { it.text("method") == "POST" && it.text("path") == "/api/projects/$projectId/coordinator" })
        back(); awaitIn("project-detail", "A11 Android launch")
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("open-items-attention").fetchSemanticsNodes().isEmpty() }
        capture("review-return-project")
    }

    @Test fun theOwnerStartsAProjectNobodyAskedAbout() = journey("project-owner-start") {
        login(case = "own-start"); open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitTag("project-start-own"); compose.onAllNodesWithTag("project-settings").assertCountEquals(0); capture("project-not-started")
        tap("project-start-own"); awaitTag("project-start-confirm"); capture("project-start-sheet")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().assertTextContains(StartProjectCopy.action).performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.text("startedAt") != null && http("/__stats").text("case") == "normal" }
        val start = journal().last { it.text("path") == "/api/projects/$projectId/start" }.obj("body")!!
        assertEquals("seal1", start.text("criteriaDigest")); assertEquals(JsonNull, start["requestId"])
        assertEquals("PROJECT_BRANCH", start.text("line")); assertEquals("refs/heads/project/a11", start.text("projectBranchName"))
        awaitGone("project-start-sheet"); awaitGone("project-start-own")
        awaitScrollTo("project-detail", hasTestTag("project-settings")); capture("project-started")
    }

    // MARK: the start card (A11b: main's redesigned card, both ways it is drawn; run again under dark mode)

    /** None of the card's old lines: the meta line ("asked by the coordinator"), the plan's order line ("A starts now"), the ready
     * check's line and the generic settings form the coordinator's card used to be. */
    private fun assertNoOldStartLines() {
        val old = listOf("asked by the coordinator", "starts now", "start now", "Orbit checked the plan", "Run settings", "Starting confirms the criteria")
        compose.onAllNodes(hasText("", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
            .flatMap { node -> if (SemanticsProperties.Text in node.config) node.config[SemanticsProperties.Text].map { it.text } else emptyList() }
            .forEach { text -> old.forEach { line -> assertFalse("old start line \"$line\" in \"$text\"", text.contains(line)) } }
    }

    /** The owner's own Start… on a project with no coordinator yet: nobody asked, Automatic on and the coordinator it opens, what
     * still comes to the owner, the plan by level and the line under Start; the press sends every setting and no request. */
    @Test fun startCardTheOwnersOwn() = journey("start-card-own") {
        login(case = "own-start"); http("/__control", """{"plan":true,"project":{"coordinatorSessionId":null}}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch"); awaitScrollTo("project-detail", hasTestTag("project-start-own"))
        tap("project-start-own"); awaitTag("project-start-confirm")
        compose.onNodeWithTag("project-start-asked").assertTextEquals(StartProjectCopy.nobodyAskedLine(hasCoordinator = false))
        capture("start-own-1-top")
        compose.onNodeWithTag("project-start-opens").performScrollTo().assertTextEquals(StartProjectCopy.opensCoordinator)
        compose.onNodeWithTag("project-start-comes-to-you").performScrollTo()
        compose.onNodeWithText("E · 上线 · you confirm it").assertIsDisplayed(); compose.onNodeWithText("Problems it can’t resolve within 1 h").assertIsDisplayed()
        compose.onNodeWithTag("project-start-note").performScrollTo().assertTextEquals(StartProjectCopy.howItRunsNote(asked = false, suggestedOff = false))
        capture("start-own-2-how-it-runs")
        compose.onNodeWithTag("project-start-level:1").performScrollTo().assertTextContains("A").assertTextContains(StartProjectCopy.now)
        compose.onNodeWithTag("project-start-level:2").assertTextContains("B · C").assertTextContains(StartProjectCopy.inParallel(2))
        compose.onNodeWithTag("project-start-level:4").assertTextContains("E").assertTextContains(StartProjectCopy.you)
        compose.onNodeWithTag("project-start-caption").performScrollTo().assertTextEquals("Opens a coordinator · starts A now · confirms this criterion")
        compose.onNodeWithTag("project-start-sheet").performTouchInput { swipeUp() }
        capture("start-own-3-plan-and-start")
        assertNoOldStartLines()
        // The journal outlives each journey's reset: only a start sent from here on is this press.
        val before = journal().size
        compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        compose.waitUntil(20_000) { journal().drop(before).any { it.text("path") == "/api/projects/$projectId/start" } && http("/__stats").text("case") == "normal" }
        assertEquals(buildJsonObject {
            put("criteriaDigest", "seal1"); put("line", "PROJECT_BRANCH"); put("projectBranchName", "refs/heads/project/a11"); put("automatic", true)
            put("maxConcurrentTasks", 2); put("mergeCheckCommand", "true"); put("requestId", JsonNull)
        }, journal().drop(before).last { it.text("path") == "/api/projects/$projectId/start" }.obj("body"))
        awaitGone("project-start-sheet")
    }

    /** The coordinator's request: its row on the project page, Review into the conversation onto the start card — who asked and
     * in their words, Automatic on whatever was suggested, what still comes to the owner, the plan by level — and Start answering
     * the request through the card actions with every setting the card shows. */
    @Test fun startCardTheCoordinatorAsked() = journey("start-card-asked") {
        login(case = "start"); http("/__control", """{"plan":true}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        tap("open-items-attention", "project-detail"); awaitTag("start-request")
        compose.onNodeWithTag("start-request").assertTextContains("The coordinator asked · a project branch · Automatic on · at most 2 at a time")
        capture("start-asked-0-project-row")
        tap("start-request:action")
        awaitTag("interaction-cards"); awaitScrollTo("transcript-list", hasTestTag("start:start1"))
        // A08-2: the start card is a preview in the conversation, read and answered in the review it opens.
        tap("start:start1:preview"); awaitTag("card-review")
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("start:start1:START") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("start:start1-asked").assertTextContains("${StartProjectCopy.coordinatorAsked} ", substring = true)
        compose.onNodeWithText("The plan is ready.").assertExists(); compose.onNodeWithTag("start:start1-why").assertTextEquals(StartProjectCopy.more)
        capture("start-asked-1-top")
        compose.onNodeWithTag("start:start1-comes-to-you").performScrollTo()
        compose.onNodeWithText("E · 上线 · you confirm it").assertIsDisplayed(); compose.onNodeWithText("Problems it can’t resolve within 1 h").assertIsDisplayed()
        compose.onNodeWithTag("start:start1-automatic-says").assertTextEquals(RunSettings.automaticOnChecked)
        capture("start-asked-2-how-it-runs")
        compose.onNodeWithTag("start:start1-note").performScrollTo().assertTextEquals(StartProjectCopy.howItRunsNote(asked = true, suggestedOff = false))
        capture("start-asked-2b-settings")
        compose.onNodeWithTag("start:start1-level:2").performScrollTo().assertTextContains("B · C").assertTextContains(StartProjectCopy.inParallel(2))
        compose.onNodeWithTag("start:start1-caption").performScrollTo().assertTextEquals("Starts A now · confirms this criterion · seal seal1")
        capture("start-asked-3-plan-and-start")
        assertNoOldStartLines()
        // The journal outlives each journey's reset: only a start sent from here on is this press.
        val before = journal().size
        compose.onNodeWithTag("start:start1:START").performScrollTo().performClick()
        compose.waitUntil(20_000) { journal().drop(before).any { it.text("method") == "POST" && it.text("path") == "/api/projects/$projectId/start" } }
        assertEquals(buildJsonObject {
            put("criteriaDigest", "seal1"); put("requestId", "start1"); put("line", "PROJECT_BRANCH"); put("automatic", true); put("maxConcurrentTasks", 2)
            put("mergeCheckCommand", "./verify"); put("projectBranchName", "refs/heads/project/cards")
        }, journal().drop(before).last { it.text("path") == "/api/projects/$projectId/start" }.obj("body"))
        // The review says the decision was recorded, then closes itself.
        awaitGone("card-review"); capture("start-asked-4-accepted")
    }

    @Test fun aDeliveryBlockerIsReviewedWithItsReasonRecorded() = journey("project-blocker") {
        login()
        http("/__control", """{"project":{"blockers":{"open":[{"id":"blk1","kind":"DELIVERY_REVIEW","owner":"USER","severity":"WARNING",
            "requiredAction":"Review the files this delivery changed outside its declared scope.","subjectTitle":"A11 project delivery","subjectTaskId":"$projectTaskId",
            "firstSeenAt":"2026-10-04T22:00:00.000Z","detail":{"reason":"OUTSIDE_DECLARED_SCOPE","paths":["src/android/app/build.gradle.kts","src/android/app/src/main/AndroidManifest.xml"]}},
            {"id":"blk2","kind":"WHO_NOT_IN_TEAM","owner":"USER","severity":"CRITICAL","requiredAction":"Add the assigned agent to this project team, or reassign the task.",
            "subjectTitle":"A11 project prerequisite","firstSeenAt":"2026-10-03T12:00:00.000Z"}],"resolved":[],"resolvedCount":0}}}""".replace("\n", ""))
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitScrollTo("project-detail", hasTestTag("blocker:blk1")); awaitText("Changed files it didn’t declare"); capture("project-blocker")
        tap("blocker:blk1:resolve", "project-detail"); awaitTag("blocker-reason")
        compose.onNodeWithTag("blocker-reason").performTextInput("Both files belong to the declared Android shell change")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); capture("project-blocker-review")
        compose.onNodeWithTag("blocker-resolve-confirm").assertTextContains("Accept these files").performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.obj("blockers")?.number("resolvedCount") == 1 }
        val resolve = journal().last { it.text("path") == "/api/projects/$projectId/blockers/blk1/resolve" }
        assertEquals("Both files belong to the declared Android shell change", resolve.obj("body")?.text("reason"))
        // The other blocker keeps the section up, with the resolved one folded under it as iOS draws it.
        awaitGone("blocker:blk1"); scrollTo("project-detail", hasTestTag("blocker:blk2"))
        awaitText("1 resolved · latest: Resolved by you — Both files belong to the declared Android shell change")
        capture("project-blocker-resolved")
    }

    // MARK: regressions from the coordinator's review of v1 (decision 5dshHuxUn20vj22RYT968k)
    // Each journey uses only tags and words both the reviewed build (d621e29aa) and its fix carry, so the
    // same test is run against each: red on the reviewed build, green on the fix.

    /** P2-1: a write that lands after the filter changed must not refill the new filter with the old one's rows. */
    @Test fun regressionP21_aWriteFinishedUnderAnEarlierFilterDoesNotRefillTheNewOne() = journey("p2-1-filter-race") {
        login()
        http("/__control", """{"task":{"id":"$prerequisiteId","status":"FAILED","runnable":false},"delays":{"POST /api/tasks/$taskId/execute":3000}}""")
        drawer("Tasks"); awaitTag("tasks-list"); awaitText("A11 task checklist"); awaitTag("task-filter:FAILED")
        compose.onNodeWithTag("task:$taskId").performTouchInput { longClick() }
        compose.onAllNodesWithText("Run").filterToOne(hasClickAction()).performClick()
        compose.onNodeWithTag("task-filter:FAILED").performScrollTo().performClick()
        awaitTag("task:$prerequisiteId")
        compose.waitUntil(20_000) { journal().any { it.text("path") == "/api/tasks/$taskId/execute" && it["status"]?.toString() == "200" } }
        SystemClock.sleep(3_000) // the refresh the write started
        capture("p2-1-failed-filter-after-write")
        compose.onAllNodesWithTag("task:$taskId").assertCountEquals(0)
    }

    /** P2-2: a draft abandoned with its dialog must not prefill the next dialog. */
    @Test fun regressionP22_anAbandonedDialogDraftDoesNotPrefillTheNextDialog() = journey("p2-2-dialog-draft") {
        login()
        http("/__control", """{"project":{"blockers":{"open":[{"id":"blk1","kind":"DELIVERY_REVIEW","owner":"USER","severity":"WARNING",
            "requiredAction":"Review the files this delivery changed outside its declared scope.","subjectTitle":"A11 project delivery",
            "firstSeenAt":"2026-10-04T22:00:00.000Z","detail":{"reason":"OUTSIDE_DECLARED_SCOPE","paths":["src/android/app/build.gradle.kts"]}},
            {"id":"blk2","kind":"WHO_NOT_IN_TEAM","owner":"USER","severity":"CRITICAL","requiredAction":"Add the assigned agent to this project team, or reassign the task.",
            "subjectTitle":"A11 project prerequisite","firstSeenAt":"2026-10-03T12:00:00.000Z"}],"resolved":[],"resolvedCount":0}}}""".replace("\n", ""))
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        tap("blocker:blk1:resolve", "project-detail"); awaitTag("blocker-reason")
        compose.onNodeWithTag("blocker-reason").performTextInput("Meant for the scope blocker only")
        compose.activityRule.scenario.recreate()
        awaitIn("project-detail", "A11 Android launch")
        tap("blocker:blk2:resolve", "project-detail"); awaitTag("blocker-reason")
        capture("p2-2-second-dialog")
        compose.onNodeWithTag("blocker-reason").assert(hasText("Meant for the scope blocker only", substring = true).not())
    }

    /** P2-3: an edit the server refuses keeps its sheet and what was typed. */
    @Test fun regressionP23_aRefusedAcceptanceEditKeepsItsSheetAndDraft() = journey("p2-3-acceptance-refused") {
        login(); http("/__control", """{"mode":"refuse-acceptance"}""")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet")
        compose.onNodeWithTag("task-acceptance-criteria").performTextReplacement("A criterion the server refuses to take as is")
        tap("task-save-acceptance")
        compose.waitUntil(20_000) { journal().any { it.text("method") == "PATCH" && it["status"]?.toString() == "400" } }
        SystemClock.sleep(1_000)
        capture("p2-3-after-refusal")
        compose.onAllNodesWithTag("task-acceptance-sheet").assertCountEquals(1)
        compose.onNodeWithTag("task-acceptance-criteria").assertTextContains("A criterion the server refuses to take as is")
    }

    /** P2-4: a setting pressed just before leaving the page is still written. */
    @Test fun regressionP24_aSettingPressedJustBeforeLeavingIsStillWritten() = journey("p2-4-at-most-leave") {
        login(); open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        tap("project-at-most-plus", "project-detail")
        back()
        compose.waitUntil(10_000) { http("/__stats").obj("project")?.number("maxConcurrentTasks") == 3 }
    }

    /** P2-4: a Run pressed just before leaving still reaches the server under its one name. */
    @Test fun regressionP24_aRunPressedJustBeforeLeavingStillStarts() = journey("p2-4-run-leave") {
        login(); http("/__control", """{"dropNext":{"POST /api/tasks/$taskId/execute":2}}""")
        val mark = journal().size
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").performClick()
        back()
        compose.waitUntil(15_000) { http("/__stats").obj("tasks")?.obj(taskId)?.flag("running") == true }
        val presses = journal().drop(mark).filter { it.text("path") == "/api/tasks/$taskId/execute" }.mapNotNull { it.obj("body")?.text("triggerId") }.distinct()
        assertEquals("every delivery carries the press's one name", 1, presses.size)
    }

    /** P2-4: the owner's start cannot be cancelled while it is being sent. */
    @Test fun regressionP24_theOwnersStartCannotBeCancelledWhileItIsSent() = journey("p2-4-start-in-flight") {
        login(case = "own-start")
        http("/__control", """{"delays":{"POST /api/projects/$projectId/start":4000}}""")
        open("orbit-project:$projectId"); awaitTag("project-detail"); awaitTag("project-start-own")
        tap("project-start-own"); awaitTag("project-start-confirm")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        capture("p2-4-start-in-flight")
        compose.onNodeWithTag("project-start-cancel").assertIsNotEnabled()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.text("startedAt") != null && http("/__stats").text("case") == "normal" }
    }

    /** P2-5: a steady stream of events still lets the list read what changed. */
    @Test fun regressionP25_aStreamOfEventsStillRefreshesTheList() = journey("p2-5-event-storm") {
        login(); drawer("Tasks"); awaitTag("tasks-list"); awaitText("A11 task checklist")
        http("/__control", """{"eventStorm":true}""")
        http("/__control", """{"task":{"id":"$taskId","title":"A11 task checklist, renamed elsewhere"}}""")
        try { awaitText("A11 task checklist, renamed elsewhere", 10_000) }
        finally { capture("p2-5-list-during-storm"); http("/__control", """{"eventStorm":false}""") }
    }

    /** P2-6: Record as done is the owner's done door, bound to the seal the owner read. */
    @Test fun regressionP26_recordAsDoneIsTheOwnersDoneDoor() = journey("p2-6-record-done") {
        login(); val mark = journal().size
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitTag("project-menu"); tap("project-menu"); compose.onNodeWithText("Record as done").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("project-done-record").fetchSemanticsNodes().isNotEmpty() ||
            compose.onAllNodesWithTag("project-status-confirm").fetchSemanticsNodes().isNotEmpty() }
        capture("p2-6-record-done-confirmation")
        if (compose.onAllNodesWithTag("project-done-record").fetchSemanticsNodes().isNotEmpty())
            compose.onNodeWithTag("project-done-record").performScrollTo().performClick()
        else compose.onNodeWithTag("project-status-confirm").performClick()
        compose.waitUntil(10_000) { journal().drop(mark).any { it.text("method") != "GET" && it.text("path")?.startsWith("/api/projects/$projectId") == true } }
        SystemClock.sleep(1_000)
        val writes = journal().drop(mark).filter { it.text("method") != "GET" && it.text("path")?.startsWith("/api/projects/$projectId") == true }
        assertTrue("no status PATCH stands in for the done door: $writes", writes.none { it.text("method") == "PATCH" && it.obj("body")?.text("status") == "DONE" })
        val done = writes.single { it.text("path") == "/api/projects/$projectId/done" }.obj("body")!!
        assertEquals("seal1", done.text("criteriaDigest")); assertEquals(JsonNull, done["requestId"])
        assertTrue(done["acceptedGaps"] is JsonArray)
        assertEquals("OWNER", http("/__stats").obj("project")?.text("doneBy"))
    }

    /** Point 5: the coordinator conversation opens onto the open item's card, even when that card starts off screen. */
    @Test fun regressionFocus_theCoordinatorConversationOpensOntoTheItemsCard() = journey("focus-item-card") {
        login(case = "x1"); http("/__control", """{"manyJobs":true}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        tap("open-items-attention", "project-detail"); awaitTag("open-item:x1"); tap("open-item:x1")
        awaitTag("interaction-cards")
        try { compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("item:x1").assertIsDisplayed() }.isSuccess } }
        finally { capture("focus-item-card") }
    }

    /** Point 5: a created task's row in the conversation opens the task, and Back returns to the conversation. Since A08-6 the row
     * is the Tasks card's, above the composer (iOS `CreatedTasksCard`), rather than a fold of fields in the transcript. */
    @Test fun regressionCreatedTaskRow_opensTheTask() = journey("created-task-row") {
        login(); http("/__control", """{"createdTasks":true}""")
        open("orbit-session:$sessionId"); awaitTag("composer-input")
        awaitTag("session-tasks"); tap("session-tasks:line")
        awaitTag("created-task:$taskId"); capture("created-task-row")
        tap("created-task:$taskId")
        awaitIn("task-detail", "A11 task checklist")
        back(); awaitTag("composer-input")
    }

    // MARK: regressions from the coordinator's review of v2 (decision 1EWmKFuYkFgqyK5hzUzNoA)
    // As before, only tags and words both the reviewed build (65bb8884f) and its fix carry: red there, green on the fix.

    /** N2: a Delete answered after its page was left does not pop the page shown now (a page that has one under it). */
    @Test fun regressionN2_aDeleteAnsweredAfterLeavingPopsNothing() = journey("n2-delete-after-leaving") {
        login(); http("/__control", """{"delays":{"DELETE /api/tasks/$taskId":4000}}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        val mark = journal().size
        tap("task-menu"); compose.onNodeWithText(TaskDetailCopy.deleteTask).performClick()
        awaitTag("task-confirm"); tap("task-confirm")
        back(); awaitIn("project-detail", "A11 Android launch")
        compose.waitUntil(20_000) { journal().drop(mark).any { it.text("method") == "DELETE" && it.text("path") == "/api/tasks/$taskId" && it["status"]?.toString() == "200" } }
        SystemClock.sleep(1_500)
        capture("n2-project-after-late-delete")
        compose.onAllNodesWithTag("project-detail").assertCountEquals(1)
    }

    /** N2: while the owner's start is out, View tasks cannot take the sheet away and lose the server's answer. */
    @Test fun regressionN2_viewTasksWaitsForTheStartThatIsOut() = journey("n2-view-tasks-in-flight") {
        login(case = "own-start"); http("/__control", """{"delays":{"POST /api/projects/$projectId/start":4000}}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch"); awaitScrollTo("project-detail", hasTestTag("project-start-own"))
        tap("project-start-own"); awaitTag("project-start-confirm")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        compose.onNodeWithTag("project-start-view-tasks").performScrollTo(); capture("n2-view-tasks-while-starting")
        compose.onNodeWithTag("project-start-view-tasks").assertIsNotEnabled()
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.text("startedAt") != null }
    }

    /** P2-5: the project index keeps up through a steady stream of events, its read taking longer than they come. */
    @Test fun regressionP25_theProjectIndexKeepsUpThroughAStreamOfEvents() = journey("p2-5-project-index-storm") {
        login(); drawer("Projects"); awaitTag("projects-list"); awaitText("A11 Android launch")
        http("/__control", """{"eventStorm":true,"delays":{"GET /api/projects":1500}}""")
        http("/__control", """{"project":{"title":"A11 Android launch, renamed elsewhere"}}""")
        val renamed = hasText("A11 Android launch, renamed elsewhere", substring = true) and hasAnyAncestor(hasTestTag("projects-list"))
        try { compose.waitUntil(12_000) { compose.onAllNodes(renamed).fetchSemanticsNodes().isNotEmpty() } }
        finally { capture("p2-5-project-index-during-storm"); http("/__control", """{"eventStorm":false,"delays":{}}""") }
    }

    /** P2-5: a list read slower than the coalescing still lands through a steady stream of events. */
    @Test fun regressionP25_aSlowListReadStillLandsThroughAStreamOfEvents() = journey("p2-5-slow-read-storm") {
        login(); drawer("Tasks"); awaitTag("tasks-list"); awaitText("A11 task checklist")
        http("/__control", """{"delays":{"GET /api/tasks/page":3000},"eventStorm":true}""")
        http("/__control", """{"task":{"id":"$taskId","title":"A11 task checklist, renamed elsewhere"}}""")
        try { awaitText("A11 task checklist, renamed elsewhere", 20_000) }
        finally { capture("p2-5-slow-read-during-storm"); http("/__control", """{"eventStorm":false,"delays":{}}""") }
    }

    /** N1: Load more ends even when the list is read again while it is out, and what lies past the first page is reachable. */
    @Test fun regressionN1_loadMoreEndsWhenTheListIsReadAgain() = journey("n1-load-more") {
        login(); http("/__control", """{"pageLimit":1}""")
        drawer("Tasks"); awaitTag("tasks-list"); awaitScrollTo("tasks-list", hasTestTag("tasks-load-more"))
        http("/__control", """{"delays":{"GET /api/tasks/page?cursor":4000}}""")
        tap("tasks-load-more", "tasks-list")
        // The list is read again while the next page is out (the options menu's Refresh; a write's re-read is the same read).
        tap("tasks-options"); compose.onNodeWithText("Refresh").performClick()
        val stuck = hasTestTag("tasks-load-more") and hasText(TaskListCopy.loading)
        try { compose.waitUntil(20_000) { compose.onAllNodes(stuck).fetchSemanticsNodes().isEmpty() } }
        finally { capture("n1-load-more-after-refresh") }
        http("/__control", """{"delays":{}}""")
        if (compose.onAllNodesWithTag("tasks-load-more").fetchSemanticsNodes().isNotEmpty()) tap("tasks-load-more", "tasks-list")
        awaitScrollTo("tasks-list", hasTestTag("task:$taskId")); awaitScrollTo("tasks-list", hasTestTag("task:$prerequisiteId"))
    }

    /** N3: a sheet cannot be put away while what it sent is out; the refusal is shown under it, with what was typed. */
    @Test fun regressionN3_aSheetStaysUntilItsWriteIsAnswered() = journey("n3-sheet-in-flight") {
        login(); http("/__control", """{"mode":"refuse-acceptance","delays":{"PATCH /api/tasks/$taskId":4000}}""")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet")
        compose.onNodeWithTag("task-acceptance-criteria").performTextReplacement("A criterion the server will refuse")
        tap("task-save-acceptance"); capture("n3-sheet-while-sending")
        compose.onNode(hasText(TaskDetailCopy.cancel) and hasAnyAncestor(hasTestTag("task-acceptance-sheet"))).assertIsNotEnabled()
        compose.waitUntil(20_000) { journal().any { it.text("method") == "PATCH" && it["status"]?.toString() == "400" } }
        awaitTag("task-sheet-error"); capture("n3-sheet-after-refusal")
        compose.onNodeWithTag("task-acceptance-criteria").assertTextContains("A criterion the server will refuse")
    }

    /** N3: Share is not offered while a write is out. */
    @Test fun regressionN3_shareWaitsForAWriteThatIsOut() = journey("n3-share-while-busy") {
        login(); http("/__control", """{"delays":{"POST /api/tasks/$taskId/execute":4000}}""")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").performClick()
        scrollTo("task-detail", hasTestTag("task-menu")); tap("task-menu")
        val share = hasText(SharePanelCopy.share) and hasAnyAncestor(isPopup())
        compose.waitUntil(10_000) { compose.onAllNodes(share).fetchSemanticsNodes().isNotEmpty() }
        capture("n3-menu-while-running")
        compose.onNode(share).assertIsNotEnabled()
    }

    /** A task's and a project's ⋯ → Share… open the one share panel every Share uses (A13's): turning the link on and
     * off are the server's own writes, and the menu then says what the server answered. */
    @Test fun aTaskAndAProjectShareThroughTheOneSharePanel() = journey("share-entry") {
        login()
        for ((name, link, page, words) in listOf(listOf("task", "orbit-task:$taskId", "task-detail", "A11 task checklist"),
            listOf("project", "orbit-project:$projectId", "project-detail", "A11 Android launch"))) {
            val path = if (name == "task") "/api/tasks/$taskId/share" else "/api/projects/$projectId/share"
            fun shares() = http("/__stats").obj("shares") ?: JsonObject(emptyMap())
            fun openShare(status: String) {
                scrollTo(page, hasTestTag("$name-menu")); tap("$name-menu")
                val item = hasText(SharePanelCopy.share) and hasAnyAncestor(isPopup())
                compose.waitUntil(10_000) { compose.onAllNodes(item and hasText(status)).fetchSemanticsNodes().isNotEmpty() }
                compose.onNode(item).performClick(); awaitTag("share-sheet")
            }
            fun choose(access: String) {
                val row = hasText(access) and isSelectable() and isEnabled() and hasAnyAncestor(hasTestTag("share-sheet"))
                compose.waitUntil(20_000) { compose.onAllNodes(row).fetchSemanticsNodes().isNotEmpty() }
                compose.onNode(row).performClick()
            }
            fun done() { compose.onNode(hasText(SharePanelCopy.done) and hasAnyAncestor(hasTestTag("share-sheet"))).performClick(); awaitGone("share-sheet") }
            open(link); awaitIn(page, words)
            openShare(SharePanelCopy.onlyYou); awaitText("Only you can open it, signed in."); capture("share-entry-$name-private")
            val mark = journal().size
            choose("Anyone with the link"); awaitText("/s/a11-controlled-public-token"); capture("share-entry-$name-public")
            assertTrue("$path PUT", journal().drop(mark).any { it.text("method") == "PUT" && it.text("path") == path && it["status"]?.toString() == "200" })
            assertNotNull("$path stored", shares()[path])
            done(); openShare(SharePanelCopy.liveLink); awaitText("/s/a11-controlled-public-token")
            choose("Only you"); awaitText("Turn off this link?")
            compose.onNode(hasText("Turn off") and hasClickAction()).performClick()
            awaitText("Only you can open it, signed in."); capture("share-entry-$name-turned-off")
            assertTrue("$path DELETE", journal().drop(mark).any { it.text("method") == "DELETE" && it.text("path") == path && it["status"]?.toString() == "200" })
            assertNull("$path removed", shares()[path])
            done(); openShare(SharePanelCopy.onlyYou); capture("share-entry-$name-menu-after"); done()
        }
    }

    /** P3: a comment the server took is not offered again by its page's saved state (the page was left — here the
     * Activity recreated, as P2-2 — while the comment was out). */
    @Test fun regressionP3_aSentCommentIsNotOfferedAgain() = journey("p3-comment-sent-after-leaving") {
        login(); http("/__control", """{"delays":{"POST /api/tasks/$taskId/comments":3000}}""")
        open("orbit-task:$taskId"); awaitIn("task-detail", "A11 task checklist")
        val mark = journal().size
        compose.onNodeWithTag("task-comment").performTextInput("Sent once only")
        tap("task-post-comment")
        compose.activityRule.scenario.recreate(); awaitIn("task-detail", "A11 task checklist")
        compose.waitUntil(20_000) { journal().drop(mark).any { it.text("path") == "/api/tasks/$taskId/comments" && it["status"]?.toString() == "200" } }
        SystemClock.sleep(1_000); capture("p3-comment-box-after-it-was-taken")
        compose.onNodeWithTag("task-comment").assert(hasText("Sent once only", substring = true).not())
    }

    /** P3: a bulk action leaves no selection behind in its page's saved state (the Activity recreated while it was out). */
    @Test fun regressionP3_aBulkActionLeavesNoSelectionBehind() = journey("p3-bulk-selection") {
        login(); http("/__control", """{"delays":{"POST /api/tasks/batch-delete":3000}}""")
        drawer("Tasks"); awaitTag("tasks-list"); awaitText("A11 task checklist")
        val mark = journal().size
        tap("tasks-options"); compose.onNodeWithText(TaskListCopy.selectTasks).performClick()
        tap("task:$taskId", "tasks-list")
        compose.onNode(hasText(TaskListCopy.delete) and hasAnyAncestor(hasTestTag("tasks-bulk-bar"))).performClick()
        awaitTag("tasks-bulk-confirm"); tap("tasks-bulk-confirm")
        compose.activityRule.scenario.recreate(); awaitTag("tasks-list")
        compose.waitUntil(20_000) { journal().drop(mark).any { it.text("path") == "/api/tasks/batch-delete" && it["status"]?.toString() == "200" } }
        SystemClock.sleep(1_000); capture("p3-tasks-after-bulk")
        compose.onAllNodesWithTag("tasks-bulk-bar").assertCountEquals(0)
    }

    // MARK: screens for the owner (run again under dark mode and a large font)

    @Test fun screensTour() = journey("screens") {
        login(case = "x1"); drawer("Tasks")
        awaitTag("tasks-list"); awaitText("A11 task checklist"); capture("tour-1-tasks-list")
        open("orbit-task:$projectTaskId"); awaitIn("task-detail", "A11 project delivery"); capture("tour-2-task-detail")
        // At any font size Run now scrolls clear of the comment box under the page (decision 5dshHuxUn20vj22RYT968k, point 4).
        scrollTo("task-detail", hasTestTag("task-run"))
        val run = compose.onNodeWithTag("task-run").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val comment = compose.onNodeWithTag("task-comment").fetchSemanticsNode().boundsInRoot
        assertTrue("Run now ($run) ends above the comment box ($comment)", run.bottom <= comment.top)
        capture("tour-2b-task-run-clear-of-comment")
        scrollTo("task-detail", hasTestTag("task-dependencies-section")); capture("tour-3-task-dependencies")
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet"); capture("tour-4-task-edit")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); awaitGone("task-acceptance-sheet")
        drawer("Projects"); awaitTag("projects-list"); awaitText("A11 Android launch"); capture("tour-5-projects-list")
        tap("project:$projectId", "projects-list"); awaitIn("project-detail", "A11 Android launch")
        awaitScrollTo("project-detail", hasTestTag("open-items-attention")); capture("tour-6-project-detail")
        scrollTo("project-detail", hasTestTag("project-overview")); capture("tour-7-project-progress")
        scrollTo("project-detail", hasTestTag("project-coordinator-section")); capture("tour-8-coordinator-entry")
        tap("open-items-attention", "project-detail"); awaitTag("open-item:x1"); capture("tour-8b-open-items")
        compose.onNodeWithTag("open-item:x1").performClick()
        awaitTag("interaction-cards"); awaitScrollTo("transcript-list", hasTestTag("item:x1")); capture("tour-9-review-card")
    }

    // MARK: A11c — the increments of 4f695a286 (A11-1/2/3/4/5/7/10), each write read back from the fixture's journal and state

    /** A11-7: Run is the play mark and the word on a light tint, 48dp to press, and still starts the task under one name. */
    @Test fun a11cRunQueueRunPress() = journey("a11c-run-press") {
        login(); open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitScrollTo("project-detail", hasTestTag("queue:$projectTaskId:run"))
        compose.onNodeWithTag("queue:$projectTaskId:run").assertTextEquals(ProjectPage.runPress).assertHeightIsAtLeast(48.dp)
            .assertContentDescriptionEquals("Run A11 project delivery")
        compose.onNodeWithTag("queue:$projectTaskId:run:play", useUnmergedTree = true).assertExists()
        capture("a11c-run-press")
        val mark = journal().size
        tap("queue:$projectTaskId:run")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(projectTaskId)?.flag("running") == true }
        assertEquals(1, journal().drop(mark).filter { it.text("path") == "/api/tasks/$projectTaskId/execute" }.mapNotNull { it.obj("body")?.text("triggerId") }.distinct().size)
        capture("a11c-run-press-started")
    }

    /** A11-10: a timed-out landing reads as one on the row; the row opens the jobs in flight, and Retry ends the silent generation. */
    @Test fun a11cLandingJobsAndRetry() = journey("a11c-landing-jobs") {
        login(); http("/__control", """{"landingJobs":true}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitScrollTo("project-detail", hasTestTag("landing-row"))
        compose.onNodeWithTag("landing-row").assertTextContains("2 jobs · 1 timed out", substring = true).assertTextContains("Timed out", substring = true)
            .assertTextContains("limit 10m", substring = true)
        compose.onNodeWithTag("landing-timed-out", useUnmergedTree = true).assertExists()
        capture("a11c-landing-row-timed-out")
        tap("landing-row", "project-detail"); awaitTag("landing-jobs-sheet")
        compose.onNodeWithTag("landing-jobs-title").assertTextEquals("2 jobs in flight")
        compose.onNodeWithTag("landing-job:34cJobStuck:detail", useUnmergedTree = true)
            .assertTextContains("Runner workstation-gpu took it at ", substring = true).assertTextContains(" · stopped at fetching · no push recorded", substring = true)
        compose.onAllNodesWithTag("landing-job:34cJobMerge:retry").assertCountEquals(0)
        capture("a11c-landing-jobs-sheet")
        val mark = journal().size
        tap("landing-job:34cJobStuck:retry")
        compose.waitUntil(20_000) { journal().drop(mark).any { it.text("path") == "/api/projects/$projectId/integration/jobs/34cJobStuck/retry" && it["status"]?.toString() == "200" } }
        awaitText("Generation 2 · retried by you at")
        val retried = http("/__stats").obj("integration")!!.objects("inFlightJobs").first()
        assertEquals("OWNER", retried.text("retriedBy")); assertEquals(2, retried.number("generation"))
        capture("a11c-landing-jobs-retried")
    }

    /** A11-3: the crossings this project is an end of, answered in two presses; a refusal stays on its row with the door's code. */
    @Test fun a11cCrossingsAnswered() = journey("a11c-crossings") {
        login(); http("/__control", """{"crossings":true,"mode":"landing-in-flight"}""")
        open("orbit-project:$projectId"); awaitIn("project-detail", "A11 Android launch")
        awaitScrollTo("project-detail", hasTestTag("crossing:34cHandoffMove1"))
        compose.onNodeWithTag("crossings-head").assert(hasAnyChild(hasText("1 waiting")))
        compose.onNodeWithTag("crossing:34cHandoffMove1:meaning").assertTextEquals("the task stays in its project until you answer, and confirming moves it")
        compose.onNodeWithTag("crossing:34cHandoffMove1:subject").assertTextContains("Task to move: A11 task checklist", substring = true)
        capture("a11c-crossings")
        tap("crossing:34cHandoffMove1:approve", "project-detail"); awaitTag("crossing:34cHandoffMove1:confirm")
        compose.onNodeWithText("Approve moving “A11 task checklist” from A11 runner hardening to A11 Android launch?").assertExists()
        capture("a11c-crossing-second-press")
        val mark = journal().size
        tap("crossing:34cHandoffMove1:answer", "project-detail")
        awaitTag("crossing:34cHandoffMove1:refusal")
        compose.onNodeWithTag("crossing:34cHandoffMove1:refusal").assert(hasAnyChild(hasText("MOVE_TASK_LANDING_IN_FLIGHT", substring = true)))
        compose.onNodeWithTag("crossing:34cHandoffMove1:confirm").assertExists()
        capture("a11c-crossing-refused")
        http("/__control", """{"mode":""}""")
        tap("crossing:34cHandoffMove1:answer", "project-detail")
        compose.waitUntil(20_000) { http("/__stats").objects("crossings").firstOrNull()?.text("state") == "APPLIED" }
        val answers = journal().drop(mark).filter { it.text("path") == "/api/projects/$projectId/handoffs/34cHandoffMove1/decision" }
        assertEquals(listOf(409, 200), answers.map { it["status"]?.toString()?.toInt() })
        answers.forEach { assertEquals(buildJsonObject { put("decision", "APPROVE"); put("acknowledgedCrossingKey", "k".repeat(64)) }, it.obj("body")) }
        assertEquals(projectId, http("/__stats").obj("tasks")?.obj(taskId)?.text("projectId"))
        awaitGone("crossing:34cHandoffMove1:confirm")
        compose.onNodeWithTag("crossing:34cHandoffMove1:meaning").assertTextEquals("the task was moved when this request was confirmed")
        capture("a11c-crossing-applied")
    }

    /** A11-2, the project page: the projects list says Ready to close; the request's row opens the card; Not yet… sends the note. */
    @Test fun a11cDoneRequestOnTheProjectPage() = journey("a11c-done-page") {
        login(case = "done-request"); http("/__control", """{"closeOut":true}""")
        drawer("Projects"); awaitTag("projects-list")
        compose.waitUntil(20_000) { compose.onAllNodesWithText("Needs you · Ready to close · ", substring = true).fetchSemanticsNodes().isNotEmpty() }
        capture("a11c-projects-ready-to-close")
        tap("project:$projectId", "projects-list"); awaitIn("project-detail", "A11 Android launch")
        awaitTag("project-ready-to-close"); compose.onNodeWithTag("open-items-attention").assertTextContains("1 item needs you", substring = true)
        tap("open-items-attention", "project-detail"); awaitTag("project-done-request")
        compose.onNodeWithTag("project-done-request").assertTextContains("The coordinator asked · 1 gaps it couldn’t prove", substring = true)
        capture("a11c-done-request-row")
        tap("project-done-request:action"); awaitTag("project-done-sheet")
        compose.onNodeWithTag("project-done-meta").assertTextContains("A11 Android launch · asked by the coordinator · waiting ", substring = true)
        compose.onNodeWithTag("project-done-judgment").assertTextEquals("The goal is met: every criterion is on main. I checked the release evidence below.")
        compose.onNodeWithTag("project-done-orbit-checked").assertTextContains("Orbit checked: every criterion is met by its work", substring = true)
        capture("a11c-done-sheet")
        compose.onNodeWithTag("project-done-not-yet").performScrollTo().performClick()
        compose.onNodeWithTag("project-done-note").performScrollTo().performTextInput("  The release notes are not published yet. ")
        hideKeyboard(); capture("a11c-done-not-yet")
        val mark = journal().size
        compose.onNodeWithTag("project-done-send").performScrollTo().performClick()
        compose.waitUntil(20_000) { http("/__stats").obj("declined") != null }
        assertEquals("The release notes are not published yet.", http("/__stats").obj("declined")?.text("note"))
        assertEquals(buildJsonObject { put("note", "The release notes are not published yet.") },
            journal().drop(mark).single { it.text("path") == "/api/projects/$projectId/done-requests/done1/decline" }.obj("body"))
        awaitGone("project-done-sheet"); compose.waitUntil(20_000) { compose.onAllNodesWithTag("project-ready-to-close").fetchSemanticsNodes().isEmpty() }
        capture("a11c-done-not-yet-sent")
    }

    /** A11-2, the conversation: "Is this project done?" drawn whole where it arrived, and Record as done turns it into its receipt. */
    @Test fun a11cDoneRequestInTheCoordinatorConversation() = journey("a11c-done-conversation") {
        login(case = "done-request"); http("/__control", """{"closeOut":true}""")
        // The conversation's cards follow its messages, below the fold of a fresh open: scrolled to, not awaited in view.
        open("orbit-session:$sessionId"); awaitScrollTo("transcript-list", hasTestTag("done:$projectId"))
        compose.onNodeWithTag("done:$projectId-meta").assertTextContains("A11 Android launch · asked by the coordinator · waiting ", substring = true)
        compose.onNodeWithTag("done:$projectId-record").assertTextEquals(ProjectDone.recordAsDone)
        compose.onNodeWithTag("done:$projectId-not-yet").assertTextEquals(ProjectDone.notYet)
        capture("a11c-conversation-done-card")
        val mark = journal().size
        compose.onNodeWithTag("done:$projectId-record").performScrollTo().performClick()
        awaitScrollTo("transcript-list", hasTestTag("done:$projectId-receipt"))
        compose.onNodeWithTag("done:$projectId-receipt-line").assertTextContains("You recorded this project done · ", substring = true)
        val done = journal().drop(mark).single { it.text("path") == "/api/projects/$projectId/done" }.obj("body")!!
        assertEquals("done1", done.text("requestId")); assertEquals("seal1", done.text("criteriaDigest")); assertEquals(1, done.objects("acceptedGaps").size)
        val project = http("/__stats").obj("project")!!
        assertEquals("DONE", project.text("status")); assertEquals("OWNER", project.text("doneBy"))
        capture("a11c-conversation-done-receipt")
    }

    /** A11-5: a confirmed merge says where its own job is; Cancel goes dead once the job is pushing. */
    @Test fun a11cMergeCardSaysWhereItsJobIs() = journey("a11c-merge-card") {
        login(case = "promotion"); http("/__control", """{"promotionExecution":{"state":"RUNNING","phase":"PUSH","startedAt":"2026-10-05T00:00:00.000Z"}}""")
        open("orbit-session:$sessionId"); awaitTag("interaction-cards")
        awaitScrollTo("transcript-list", hasTestTag("promotion:promotion1"))
        // A08-2: the merge is a preview in the conversation titled by where its job is, and its review keeps that title and the
        // job's own status line (iOS `PromotionCards.previewTitle`, `PromotionReviewSheet`).
        awaitText("Merging… · main"); tap("promotion:promotion1:preview"); awaitTag("card-review")
        compose.onNodeWithTag("card-review:title").assertTextEquals("Merging… · main")
        awaitText("confirmed — publishing the tested tree to main")
        compose.onNodeWithTag("promotion:promotion1:merging").assertTextEquals("Merging…").assertIsNotEnabled()
        compose.onNodeWithTag("promotion:promotion1:CANCEL_MERGE").assertIsNotEnabled()
        capture("a11c-merge-pushing")
        http("/__control", """{"promotionExecution":{"state":"QUEUED","startedAt":"2026-10-05T00:00:00.000Z"}}""")
        tap("card-review:close"); awaitGone("card-review")
        compose.onNodeWithText("Check status").performScrollTo().performClick()
        awaitText("Queued · main")
        awaitScrollTo("transcript-list", hasTestTag("promotion:promotion1:preview")); tap("promotion:promotion1:preview"); awaitTag("card-review")
        awaitText("confirmed — queued to merge into main")
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("promotion:promotion1:CANCEL_MERGE") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        capture("a11c-merge-queued")
    }

    /** A11-1: a task run on smart selection's pick marks the model chip ✦, its menu opens on why, and Open task › lands over the run. */
    @Test fun a11cComposerChipPickedBySmartSelection() = journey("a11c-composer-chip") {
        login(); http("/__control", """{"modelRouting":true,"route":{"level":"L","model":"claude-opus-5-5","effort":"high","applied":true,
            "reasons":["Touches the dispatch path across two modules"]}}""".replace("\n", ""))
        open("orbit-session:$sessionId"); awaitTag("composer-input")
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("composer-model-smart", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-model").assertContentDescriptionEquals("Model claude-opus-5-5, effort High, picked by smart selection")
        capture("a11c-composer-chip")
        tap("composer-model"); awaitText("✦ Picked by smart selection · tier L")
        compose.onNodeWithText("Touches the dispatch path across two modules").assertExists()
        compose.onNodeWithText("Changing the model here applies to this run only.").assertExists()
        compose.onNodeWithText("To fix the model for every run, set it on the task.").assertExists()
        compose.onNodeWithTag("composer-open-task").performScrollTo(); capture("a11c-composer-chip-menu")
        compose.onNodeWithTag("composer-open-task").assertTextEquals("Open task ›").performClick()
        awaitIn("task-detail", "A11 project delivery"); capture("a11c-open-task-over-run")
        back(); awaitTag("composer-input")
        // The account's switch off: the same run's chip is the model alone.
        http("/__control", """{"modelRouting":false}""")
        val reads = journal().size
        compose.activityRule.scenario.recreate(); awaitTag("composer-input")
        compose.waitUntil(20_000) { journal().drop(reads).any { it.text("path") == "/api/users/me" } }
        // The recreated reader reads its session again: the chip is the bare "Model" until then.
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("composer-model") and hasContentDescription("Model claude-opus-5-5, effort High")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithTag("composer-model-smart", useUnmergedTree = true).assertCountEquals(0)
        capture("a11c-composer-chip-switch-off")
    }
}
