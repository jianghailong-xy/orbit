package io.orbitd.android.taskprojects

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
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
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectCrossings
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.tasks.TaskListCopy
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** The A01 matrix rows A11 owns, on the isolated Orbit stack (apiserver at the fixed server SHA's trees, its own
 * PostgreSQL, the repo's Go runner with a stand-in engine), signed in through the product's own screen with the
 * stack's test accounts. Every write a journey makes is read back from the stack's API as the same account, and
 * every list is compared with what the API answers; the reads are kept beside the screenshots. No fixture.
 * Arguments (base64): a11Seed (ids from /var/tmp/a11-stack/seed.json), ownerEmail/ownerPassword, memberEmail/memberPassword.
 * Journeys run in name order: later ones see what earlier ones wrote, as on any server. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class RealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val server by lazy { seed.text("server")!! }
    private val stamp = java.lang.Long.toString(System.currentTimeMillis() % 1_000_000_000, 36)
    private fun task(key: String) = seed.obj("tasks")!!.obj(key)!!
    private fun list(key: String) = seed.obj("lists")!!.obj(key)!!
    private fun project(key: String) = seed.obj("projects")!!.obj(key)!!
    private val reads = mutableListOf<String>()
    private fun <T> record(what: String, value: T): T { reads += "$what => $value"; return value }

    // MARK: the stack's own API, as a test account

    private class Refused(val status: Int, body: String) : Exception("HTTP $status ${body.take(400)}")
    private val tokens = mutableMapOf<String, String>()
    private fun http(method: String, path: String, body: String?, bearer: String?): Pair<Int, String> =
        (URL("$server/api$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
            try { responseCode to ((if (responseCode < 400) inputStream else errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()) }
            finally { disconnect() }
        }
    private fun token(who: String) = tokens.getOrPut(who) {
        val (status, text) = http("POST", "/auth/login", buildJsonObject { put("email", arg("${who}Email")); put("password", arg("${who}Password")) }.toString(), null)
        if (status !in 200..299) throw Refused(status, "API sign-in for $who")
        Wire.json.parseToJsonElement(text).jsonObject.text("accessToken")!!
    }
    private fun api(method: String, path: String, body: JsonObject? = null, who: String = "owner"): JsonElement? {
        val (status, text) = http(method, path, body?.toString(), token(who))
        if (status >= 400) throw Refused(status, text)
        return if (text.isBlank()) null else Wire.json.parseToJsonElement(text)
    }
    private fun get(path: String, who: String = "owner") = api("GET", path, who = who)!!
    private fun status(path: String, who: String = "owner") = http("GET", path, null, token(who)).first
    private fun taskRecord(id: String) = get("/tasks/$id").jsonObject
    private fun page(query: String, who: String = "owner") = get("/tasks/page?$query&limit=200&counts=none", who).jsonObject.objects("items")
    private fun projectRecord(id: String) = get("/projects/$id").jsonObject
    /** What the unfiltered tab pins above its rows (Happening now, `/tasks/active`): shown over any search, as in iOS. */
    private fun pinned() = get("/tasks/active?projectId=none").jsonObject.objects("items").map { it.text("id")!! }.toSet()
    /** A task this run made for itself, so destructive checks never touch the seeded records. */
    private fun scratch(title: String, extra: JsonObjectBuilder.() -> Unit = {}) = record("POST /tasks \"$title\"", api("POST", "/tasks", buildJsonObject {
        put("title", title); put("description", "Made by the A11 device journey $stamp; it writes to this task and reads it back.")
        put("assigneeId", seed.obj("workspace")!!.text("id")); extra()
    })!!.jsonObject.text("id")!!)

    // MARK: the screen

    private fun awaitText(text: String, timeout: Long = 30_000) { compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() } }
    private fun awaitTag(tag: String, timeout: Long = 30_000) { compose.waitUntil(timeout) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
    private fun awaitGone(tag: String, timeout: Long = 30_000) { compose.waitUntil(timeout) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() } }
    /** Words shown inside one page (a link's page, not the one under it). */
    private fun awaitIn(page: String, text: String, timeout: Long = 30_000) {
        compose.waitUntil(timeout) { compose.onAllNodes(hasText(text, substring = true) and hasAnyAncestor(hasTestTag(page))).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun scrollTo(list: String, matcher: SemanticsMatcher) = compose.onNodeWithTag(list).performScrollToNode(matcher)
    private fun awaitScrollTo(list: String, matcher: SemanticsMatcher, timeout: Long = 30_000) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (true) {
            try { compose.onNodeWithTag(list).performScrollToNode(matcher); return }
            catch (missing: AssertionError) { if (SystemClock.uptimeMillis() > deadline) throw missing; SystemClock.sleep(300); compose.waitForIdle() }
        }
    }
    private fun tap(tag: String, list: String? = null) {
        if (list != null) awaitScrollTo(list, hasTestTag(tag))
        try { compose.onNodeWithTag(tag).performClick() }
        catch (refused: AssertionError) {
            if (refused.message?.contains("inject") != true) throw refused
            SystemClock.sleep(500); compose.waitForIdle()
            compose.onNodeWithTag(tag).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        }
    }
    /** Task rows composed now (a short list is composed whole). */
    private fun shownTasks() = compose.onAllNodes(SemanticsMatcher("a task row") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("task:") == true })
        .fetchSemanticsNodes().mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag)?.removePrefix("task:") }.toSet()
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun open(uri: String) = compose.activityRule.scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }
    private fun drawer(entry: String) {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        awaitText(entry); compose.onAllNodesWithText(entry).onFirst().performClick()
    }
    private fun back() = compose.onNodeWithContentDescription("Back").performClick()
    /** Closes the keyboard without a Back key, which would leave the page when the keyboard is already down. */
    private fun hideKeyboard() = compose.activityRule.scenario.onActivity { activity ->
        androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime())
    }
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

    /** Signs in through the product's sign-in screen, as the stack's test account [who]. */
    private fun signIn(who: String = "owner") {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed.text("sourceSha")}), test accounts ${arg("ownerEmail")} and ${arg("memberEmail")}; not production\n")
        app.getSharedPreferences("orbit.tasks", Context.MODE_PRIVATE).edit().clear().commit()
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement(arg("${who}Email"))
        compose.onNodeWithText("Password").performTextReplacement(arg("${who}Password"))
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        val account = (app.session.state.value as AuthState.SignedIn).handle.account
        assertEquals("signed in as the stack's $who", seed.obj("accounts")!!.obj(who)!!.text("id"), account.userId)
        record("signed in", "$who ${account.userId} at ${account.server}")
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) { capture("$name-failed"); trees(name); reads += "FAILED: $error"; throw error }
        finally { File(output, "$name-readback.txt").writeText(reads.joinToString("\n")); runBlocking { app.session.logout() } }
    }

    // MARK: UI-F04 · Tasks

    @Test fun s01_theTaskListIsTheServersList() = journey("stack-tasks-list") {
        signIn(); drawer("Tasks"); awaitTag("tasks-list")
        val all = record("GET /tasks/page?projectId=none", page("projectId=none").map { "${it.text("id")} ${it.text("title")} ${it.text("status")}" })
        all.forEach { row -> awaitScrollTo("tasks-list", hasTestTag("task:${row.substringBefore(' ')}")) }
        compose.onNodeWithTag("tasks-list").performScrollToIndex(0); capture("stack-tasks-list")
        // Failed: the server's failed rows and only those.
        val failed = record("GET /tasks/page?projectId=none&status=FAILED", page("projectId=none&status=FAILED").map { it.text("id")!! }.toSet())
        assertTrue("a short list, composed whole", failed.size in 1..4)
        compose.onNodeWithTag("task-filter:FAILED").performScrollTo().assert(hasText("${failed.size}", substring = true)).performClick()
        compose.waitUntil(30_000) { shownTasks() == failed }
        capture("stack-tasks-failed")
        // Search: the server's matches for the same words.
        compose.onNodeWithTag("task-filter:ALL").performScrollTo().performClick()
        compose.onNodeWithTag("task-search").performTextInput("sprint"); hideKeyboard()
        val matches = record("GET /tasks/page?projectId=none&q=sprint", page("projectId=none&q=sprint").map { it.text("id")!! }.toSet())
        assertTrue(matches.size in 1..4)
        val pins = record("GET /tasks/active?projectId=none (pinned over the rows)", pinned())
        compose.waitUntil(30_000) { shownTasks() == matches + pins }
        capture("stack-tasks-search")
        compose.onNodeWithTag("task-search").performTextClearance(); hideKeyboard()
        // A label: the server's rows carrying it.
        val labelled = record("GET /tasks/page?projectId=none&labels=android", page("projectId=none&labels=android").map { it.text("id")!! }.toSet())
        tap("tasks-options"); compose.onNodeWithText(TaskListCopy.filterByLabel).performClick()
        awaitTag("task-labels"); tap("task-label:android", "task-labels"); tap("task-labels-done")
        compose.waitUntil(30_000) { shownTasks() == labelled }
        capture("stack-tasks-label")
        // A label with a comma in it: what the server answers for the query both clients send (one `labels=` per label).
        record("GET /tasks/page?projectId=none&labels=Sprint, one", page("projectId=none&labels=Sprint,%20one").size)
    }

    @Test fun s02_taskPageWritesAreTheServersRecord() = journey("stack-task-writes") {
        val title = "A11 stack scratch $stamp"
        val id = scratch(title) { put("completionCriterion", "OWNER_CONFIRMED"); put("ownerConfirmationReason", "OWNER_TRADE_OFF") }
        val prerequisite = task("prereq").text("id")!!
        signIn(); open("orbit-task:$id"); awaitTag("task-detail"); awaitIn("task-detail", title); capture("stack-task-detail")
        // A comment.
        compose.onNodeWithTag("task-comment").performTextInput("A11 stack comment $stamp"); tap("task-post-comment")
        compose.waitUntil(30_000) { taskRecord(id).objects("comments").any { it.text("body") == "A11 stack comment $stamp" } }
        record("comments", taskRecord(id).objects("comments").map { it.text("body") })
        awaitScrollTo("task-detail", hasText("A11 stack comment $stamp"))
        // The acceptance.
        tap("task-edit-acceptance", "task-detail"); awaitTag("task-acceptance-sheet")
        compose.onNodeWithTag("task-acceptance-criteria").performTextReplacement("The stack keeps this sentence ($stamp).")
        tap("task-save-acceptance"); awaitGone("task-acceptance-sheet")
        compose.waitUntil(30_000) { taskRecord(id).text("acceptanceCriteria") == "The stack keeps this sentence ($stamp)." }
        record("acceptanceCriteria", taskRecord(id).text("acceptanceCriteria"))
        // A scheduled start, then cancelled.
        tap("task-start-at", "task-detail"); awaitTag("task-schedule-sheet"); tap("task-save-schedule"); awaitGone("task-schedule-sheet")
        compose.waitUntil(30_000) { taskRecord(id).text("runAt") != null }
        record("runAt after Save", taskRecord(id).text("runAt"))
        tap("task-start-at", "task-detail"); awaitTag("task-schedule-sheet"); tap("task-cancel-schedule"); awaitGone("task-schedule-sheet")
        compose.waitUntil(30_000) { taskRecord(id).text("runAt") == null }
        record("runAt after Cancel", taskRecord(id)["runAt"])
        // A prerequisite, picked from the server's own candidates.
        tap("task-add-prerequisite", "task-detail"); awaitTag("task-dependency-picker")
        compose.onNodeWithTag("task-dependency-search").performTextInput(task("prereq").text("title")!!)
        awaitTag("candidate:$prerequisite"); tap("candidate:$prerequisite")
        compose.waitUntil(30_000) { taskRecord(id).objects("dependsOn").any { it.obj("dependsOnTask")?.text("id") == prerequisite } }
        record("dependsOn", taskRecord(id).objects("dependsOn").map { it.obj("dependsOnTask")?.text("title") })
        awaitScrollTo("task-detail", hasTestTag("task-dependencies-section")); capture("stack-task-prerequisite")
        // Follow: a watch on this task.
        tap("task-follow", "task-detail"); awaitTag("task-follow-sheet"); capture("stack-task-follow")
        tap("task-follow-confirm"); awaitGone("task-follow-sheet")
        compose.waitUntil(30_000) { get("/watches").toString().contains(id) }
        record("GET /watches mentions the task", true)
    }

    @Test fun s03_aRunOnTheStackRunnerThenDelete() = journey("stack-task-run-delete") {
        val title = "A11 stack run $stamp"
        val id = scratch(title) {
            put("completionCriterion", "EXECUTABLE"); put("acceptanceCommand", "test -f A11_STACK_NOTES.md")
            put("acceptanceExpectedExitCode", 0); put("acceptanceTimeoutSeconds", 60)
        }
        signIn(); open("orbit-task:$id"); awaitTag("task-detail"); awaitIn("task-detail", title)
        scrollTo("task-detail", hasTestTag("task-run")); compose.onNodeWithTag("task-run").assertTextContains(TaskDetailCopy.runNow).performClick()
        compose.waitUntil(60_000) { taskRecord(id).text("status") != "OPEN" }
        record("status after Run", taskRecord(id).text("status"))
        compose.waitUntil(240_000) { taskRecord(id).text("status") in setOf("DONE", "FAILED", "CANCELLED") }
        val finished = record("status when the run ended", taskRecord(id).text("status"))
        awaitIn("task-detail", if (finished == "DONE") "Done" else "Failed"); capture("stack-task-run-finished")
        // Delete, from the page's own menu.
        tap("task-menu"); compose.onNodeWithText(TaskDetailCopy.deleteTask).performClick()
        awaitTag("task-confirm"); capture("stack-task-delete-confirm"); tap("task-confirm")
        compose.waitUntil(30_000) { status("/tasks/$id") == 404 }
        record("GET /tasks/$id after Delete", status("/tasks/$id"))
    }

    @Test fun s04_bulkDeleteLeavesNothingOnTheServer() = journey("stack-bulk-delete") {
        val word = "a11bulk$stamp"
        val ids = (1..2).map { scratch("A11 $word scratch $it") { put("completionCriterion", "OWNER_CONFIRMED"); put("ownerConfirmationReason", "OWNER_TRADE_OFF") } }
        signIn(); drawer("Tasks"); awaitTag("tasks-list")
        compose.onNodeWithTag("task-search").performTextInput(word); hideKeyboard()
        val pins = record("GET /tasks/active?projectId=none (pinned over the rows)", pinned())
        compose.waitUntil(30_000) { shownTasks() == ids.toSet() + pins }
        tap("tasks-options"); compose.onNodeWithText(TaskListCopy.selectTasks).performClick()
        // The bulk bar takes the bottom of the screen while selecting: each row is scrolled to before it is pressed.
        ids.forEach { tap("task:$it", "tasks-list") }
        compose.onNode(hasText(TaskListCopy.delete) and hasAnyAncestor(hasTestTag("tasks-bulk-bar"))).performClick()
        awaitTag("tasks-bulk-confirm"); capture("stack-bulk-delete-confirm"); tap("tasks-bulk-confirm")
        compose.waitUntil(30_000) { ids.all { status("/tasks/$it") == 404 } }
        record("GET each after bulk Delete", ids.map { status("/tasks/$it") })
        compose.waitUntil(30_000) { shownTasks() == pins }
        capture("stack-bulk-deleted")
    }

    // MARK: UI-F05 · Task lists

    @Test fun s05_taskListsDirectoryAndListLinks() = journey("stack-task-lists") {
        val sprint = list("sprint"); val paused = list("paused")
        signIn(); drawer("Tasks"); awaitTag("tasks-list")
        tap("tasks-scope"); awaitTag("task-lists-directory")
        record("GET /task-lists", (get("/task-lists") as JsonArray).map { it.jsonObject.text("title") })
        awaitTag("task-list:${sprint.text("id")}"); awaitTag("task-list:${paused.text("id")}"); capture("stack-task-lists-directory")
        tap("task-list:${sprint.text("id")}"); awaitGone("task-lists-directory")
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("tasks-scope") and hasText(sprint.text("title")!!, substring = true)).fetchSemanticsNodes().isNotEmpty() }
        val rows = record("GET /tasks/page?listId=${sprint.text("id")}", page("listId=${sprint.text("id")}").map { it.text("id")!! })
        rows.forEach { awaitScrollTo("tasks-list", hasTestTag("task:$it")) }
        compose.onNodeWithTag("tasks-list").performScrollToIndex(0); capture("stack-task-list-scope")
        // The list's link, as a conversation would carry it.
        open("orbit-list:${paused.text("id")}")
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("tasks-scope") and hasText(paused.text("title")!!, substring = true)).fetchSemanticsNodes().isNotEmpty() }
        val pausedRows = record("GET /tasks/page?listId=${paused.text("id")}", page("listId=${paused.text("id")}").map { it.text("id")!! }.toSet())
        compose.waitUntil(30_000) { shownTasks() == pausedRows }
        capture("stack-task-list-link")
    }

    // MARK: UI-F06 · Projects

    @Test fun s06_projectIndexAndPageAreTheServersRecord() = journey("stack-project-page") {
        val main = project("main"); val id = main.text("id")!!
        signIn(); drawer("Projects"); awaitTag("projects-list")
        val index = record("GET /projects", (get("/projects") as JsonArray).map { it.jsonObject.text("title")!! })
        index.forEach { awaitScrollTo("projects-list", hasText(it, substring = true)) }
        capture("stack-projects-list")
        tap("project:$id", "projects-list"); awaitTag("project-detail"); awaitIn("project-detail", main.text("title")!!)
        val doc = projectRecord(id)
        record("criteria", doc.objects("acceptanceCriteriaItems").map { it.text("text") })
        doc.objects("acceptanceCriteriaItems").forEach { awaitScrollTo("project-detail", hasText(it.text("text")!!, substring = true)) }
        val items = record("GET /projects/$id/open-items needsYou", get("/projects/$id/open-items").jsonObject.objects("needsYou").map { "${it.text("itemId")} ${it.text("kind")}" })
        items.forEach { awaitScrollTo("project-detail", hasTestTag("open-item:${it.substringBefore(' ')}")) }
        scrollTo("project-detail", hasTestTag("project-menu")); capture("stack-project-detail")
        // At most, up one and back, each read back with the revision it was fenced on.
        val limit = doc.number("maxConcurrentTasks")!!
        tap("project-at-most-plus", "project-detail")
        compose.waitUntil(30_000) { projectRecord(id).number("maxConcurrentTasks") == limit + 1 }
        record("maxConcurrentTasks after +", projectRecord(id).let { "${it.number("maxConcurrentTasks")} rev ${it.text("configRevision")}" })
        compose.waitUntil(30_000) { compose.onAllNodesWithText("${limit + 1} ${RunSettings.tasksAtATime(limit + 1)}").fetchSemanticsNodes().isNotEmpty() }
        tap("project-at-most-minus", "project-detail")
        compose.waitUntil(30_000) { projectRecord(id).number("maxConcurrentTasks") == limit }
        record("maxConcurrentTasks after −", projectRecord(id).let { "${it.number("maxConcurrentTasks")} rev ${it.text("configRevision")}" })
        // Pause, then resume.
        compose.waitUntil(30_000) { compose.onAllNodesWithText("$limit ${RunSettings.tasksAtATime(limit)}").fetchSemanticsNodes().isNotEmpty() }
        tap("project-pause", "project-detail")
        compose.waitUntil(30_000) { projectRecord(id).text("pausedAt") != null }
        record("pausedAt after Pause", projectRecord(id).text("pausedAt"))
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("project-pause") and hasText(RunSettings.resume)).fetchSemanticsNodes().isNotEmpty() }
        capture("stack-project-paused")
        tap("project-pause", "project-detail")
        compose.waitUntil(30_000) { projectRecord(id).text("pausedAt") == null }
        record("pausedAt after Resume", projectRecord(id)["pausedAt"])
    }

    @Test fun s07_theOwnerStartsAProjectNobodyAskedAbout() = journey("stack-project-start") {
        val unstarted = project("notStarted"); val id = unstarted.text("id")!!
        record("startedAt before", projectRecord(id)["startedAt"])
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", unstarted.text("title")!!)
        awaitTag("project-start-own"); capture("stack-project-not-started")
        tap("project-start-own"); awaitTag("project-start-confirm"); capture("stack-project-start-sheet")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        // The server decides what this project can start on: one with no repository is refused a project branch
        // and told how it can start. The sheet keeps the owner's choices and shows the server's own words.
        val refusal = hasText("That start was not recorded", substring = true)
        compose.waitUntil(60_000) { projectRecord(id).text("startedAt") != null || compose.onAllNodes(refusal).fetchSemanticsNodes().isNotEmpty() }
        if (projectRecord(id).text("startedAt") == null) {
            record("refused (shown in the sheet)", compose.onAllNodes(refusal).fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.Text)?.joinToString())
            record("startedAt after the refusal", projectRecord(id)["startedAt"])
            compose.onNode(refusal).performScrollTo(); capture("stack-project-start-refused")
            compose.onNodeWithTag("project-start-line").performScrollTo().performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithText(RunSettings.lineMain).fetchSemanticsNodes().isNotEmpty() }
            compose.onAllNodesWithText(RunSettings.lineMain).onFirst().performClick()
            compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        }
        compose.waitUntil(60_000) { projectRecord(id).text("startedAt") != null }
        val started = projectRecord(id)
        record("after Start", "startedAt=${started.text("startedAt")} automatic=${started["automatic"]} maxConcurrentTasks=${started.number("maxConcurrentTasks")}")
        record("integration after Start", get("/projects/$id/integration").jsonObject.let { "${it.text("line")} ${it.text("ref")} check=${it["mergeCheckCommand"]}" })
        awaitGone("project-start-own"); awaitScrollTo("project-detail", hasTestTag("project-settings")); capture("stack-project-started")
    }

    // MARK: UI-C08 · the coordinator conversation's cards

    @Test fun s08_anExceptionIsHandledOnItsCardInTheCoordinatorConversation() = journey("stack-exception-card") {
        val main = project("main"); val id = main.text("id")!!; val item = main.obj("items")!!.obj("TASK_FAILED")!!.text("id")!!
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", main.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("open-item:$item")); capture("stack-exception-item")
        compose.onNodeWithTag("open-item:$item").performClick()
        awaitTag("interaction-cards")
        val coordinator = record("coordinator session (server)", get("/projects/$id/coordinator/status").jsonObject.obj("coordination")?.text("sessionId"))
        compose.waitUntil(30_000) { io.orbitd.android.navigation.ObjectId.same(app.realtime.state.value.session?.id, coordinator) }
        record("conversation the app opened", app.realtime.state.value.session?.id)
        compose.waitUntil(30_000) { runCatching { compose.onNodeWithTag("item:$item").assertIsDisplayed() }.isSuccess }
        capture("stack-exception-card")
        val note = "Checked on the stack: the smoke run's failure is understood ($stamp)"
        compose.onNodeWithTag("item:$item:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithText("Why is it no longer open?").performScrollTo().performTextInput(note)
        hideKeyboard()
        compose.onNodeWithTag("item:$item:MARK_HANDLED").performScrollTo().performClick()
        compose.waitUntil(30_000) { get("/projects/$id/open-items").jsonObject.objects("needsYou").none { it.text("itemId") == item } }
        val settled = get("/projects/$id/open-items").jsonObject.objects("settled").firstOrNull { it.text("itemId") == item }
        record("item after Mark handled", settled ?: "not open, not in settled")
        capture("stack-exception-handled")
        back(); awaitTag("project-detail")
        compose.waitUntil(30_000) { compose.onAllNodesWithTag("open-item:$item").fetchSemanticsNodes().isEmpty() }
        capture("stack-exception-back-on-project")
    }

    @Test fun s09_theMergeToMainIsReviewedOnItsCard() = journey("stack-merge-review") {
        val main = project("main"); val id = main.text("id")!!
        val item = main.obj("items")!!.obj("PROMOTION_APPROVAL")!!; val promotion = item.text("promotionId")!!
        val before = get("/projects/$id/promotions/current").jsonObject
        record("promotion before", "${before.text("promotionId")} ${before.text("state")} ${before.text("sourceSha")}")
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", main.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("open-item:${item.text("id")}")); compose.onNodeWithTag("open-item:${item.text("id")}").performClick()
        awaitTag("interaction-cards")
        compose.waitUntil(30_000) { runCatching { compose.onNodeWithTag("promotion:$promotion").assertIsDisplayed() }.isSuccess }
        capture("stack-merge-card")
        // A11-9: the merge is one line in the conversation; Merge to main is pressed in the review it opens (iOS: no second ask).
        tap("promotion:$promotion:preview"); awaitTag("card-review")
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("promotion:$promotion:CONFIRM_MERGE") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        capture("stack-merge-review")
        compose.onNodeWithTag("promotion:$promotion:CONFIRM_MERGE").performClick()
        fun state() = runCatching { get("/projects/$id/promotions/current").jsonObject }.getOrNull()
            ?.takeIf { it.text("promotionId") == promotion }?.text("state")
            ?: if (get("/projects/$id/promotions/merged").toString().contains(promotion)) "MERGED (listed under merged)" else "not current"
        compose.waitUntil(60_000) { state() != "READY" }
        record("promotion after Merge", state())
        compose.waitUntil(240_000) { state().startsWith("MERGED") || state() in setOf("FAILED", "DECLINED", "CANCELLED") }
        record("promotion when settled", state())
        capture("stack-merge-settled")
    }

    @Test fun s10_aServerRaisedBlockerIsResolvedWithItsReason() = journey("stack-blocker") {
        val automatic = project("automatic"); val id = automatic.text("id")!!; val blocker = automatic.text("blockerId")!!
        record("blocker before", projectRecord(id).obj("blockers")?.objects("open")?.map { "${it.text("id")} ${it.text("kind")}" })
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", automatic.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("blocker:$blocker")); capture("stack-blocker")
        val reason = "The exemption's argument holds for this release ($stamp)"
        tap("blocker:$blocker:resolve", "project-detail"); awaitTag("blocker-reason")
        compose.onNodeWithTag("blocker-reason").performTextInput(reason)
        hideKeyboard(); capture("stack-blocker-review")
        compose.onNodeWithTag("blocker-resolve-confirm").performClick()
        compose.waitUntil(30_000) { projectRecord(id).obj("blockers")?.objects("open")?.none { it.text("id") == blocker } == true }
        val resolved = projectRecord(id).obj("blockers")?.objects("resolved")?.firstOrNull { it.text("id") == blocker }
        record("blocker after Resolve", resolved)
        assertTrue("the reason is the server's record of the decision", resolved.toString().contains(reason))
        compose.waitUntil(30_000) { compose.onAllNodesWithTag("blocker:$blocker:resolve").fetchSemanticsNodes().isEmpty() }
        capture("stack-blocker-resolved")
    }

    // MARK: deep links, another account, and the done door

    @Test fun s11_linksOpenTheirPages() = journey("stack-links") {
        signIn()
        val triage = taskRecord(task("triage").text("id")!!); val dependent = taskRecord(task("dependent").text("id")!!)
        open("orbit-task:${triage.text("id")}"); awaitTag("task-detail"); awaitIn("task-detail", triage.text("title")!!); capture("stack-link-orbit-task")
        open("$server/tasks/${dependent.text("id")}"); awaitIn("task-detail", dependent.text("title")!!); capture("stack-link-https-task")
        val scheduled = taskRecord(task("scheduled").text("id")!!)
        open("orbit://task/${scheduled.text("id")}"); awaitIn("task-detail", scheduled.text("title")!!); capture("stack-link-orbit-scheme-task")
        val sprint = list("sprint"); val paused = list("paused")
        fun scope(title: String) = compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("tasks-scope") and hasText(title, substring = true)).fetchSemanticsNodes().isNotEmpty() }
        open("$server/lists/${sprint.text("id")}"); scope(sprint.text("title")!!); capture("stack-link-https-list")
        open("orbit://list/${paused.text("id")}"); scope(paused.text("title")!!); capture("stack-link-orbit-scheme-list")
        // `lists/none` is not a named list: the link changes nothing.
        open("$server/lists/none"); SystemClock.sleep(1_500); scope(paused.text("title")!!)
        val main = projectRecord(project("main").text("id")!!); val unstarted = projectRecord(project("notStarted").text("id")!!)
        open("orbit-project:${main.text("id")}"); awaitTag("project-detail"); awaitIn("project-detail", main.text("title")!!); capture("stack-link-orbit-project")
        open("$server/projects/${unstarted.text("id")}"); awaitIn("project-detail", unstarted.text("title")!!); capture("stack-link-https-project")
        record("pages opened", listOf(triage.text("title"), dependent.text("title"), scheduled.text("title"), sprint.text("title"), paused.text("title"),
            main.text("title"), unstarted.text("title")))
    }

    @Test fun s12_anotherAccountSeesOnlyWhatTheServerGivesIt() = journey("stack-member") {
        val mine = record("member GET /tasks/page?projectId=none", page("projectId=none", who = "member").map { it.text("id")!! }.toSet())
        val ownersProject = project("main").text("id")!!; val ownersTask = task("triage").text("id")!!
        record("member GET /projects/$ownersProject", status("/projects/$ownersProject", "member"))
        record("member GET /tasks/$ownersTask", status("/tasks/$ownersTask", "member"))
        signIn("member"); drawer("Tasks"); awaitTag("tasks-list")
        compose.waitUntil(30_000) { shownTasks() == mine }
        capture("stack-member-tasks")
        open("orbit-project:$ownersProject"); awaitText(ProjectPage.gone); capture("stack-member-owners-project")
        open("orbit-task:$ownersTask"); awaitText("This task is no longer available."); capture("stack-member-owners-task")
    }

    // MARK: A11b · the start card on the stack's own server (seed-start.mjs; run on main's server)

    /** A real START_REQUEST, filed by the project's coordinator through the runner's door: the page's row, Review into the
     * coordinator conversation onto the start card drawn from the server's own plan (Now and You from what each graph mark
     * says), the note saying the coordinator suggested Automatic off, and Start answering the request — the record says
     * started, Automatic on, and that Automatic is not what the request suggested. */
    @Test fun s14_theCoordinatorAsksToStartAndTheOwnerStartsOnItsCard() = journey("stack-start-asked") {
        val asked = project("startAsked"); val id = asked.text("id")!!
        val item = record("GET /projects/$id/open-items → startRequest", get("/projects/$id/open-items").jsonObject.obj("startRequest")!!)
        val marks = record("GET /projects/$id/dependency-graph → marks", get("/projects/$id/dependency-graph").jsonObject.objects("marks")
            .map { "${it.text("title")} · ${it.text("completionCriterion")} · autoRunWhenReady=${it["autoRunWhenReady"]}" })
        assertTrue("the server says how each task is settled and whether it starts by itself", marks.isNotEmpty() && marks.none { "null" in it })
        val card = "start:${item.text("itemId")}"
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", asked.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("start-request")); capture("stack-start-asked-0-row")
        tap("start-request:action")
        awaitTag("interaction-cards"); awaitScrollTo("transcript-list", hasTestTag(card))
        // A08-2: the start card is a preview in the conversation, read and answered in the review it opens.
        tap("$card:preview"); awaitTag("card-review")
        compose.waitUntil(60_000) { compose.onAllNodes(hasTestTag("$card:START") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("$card-asked").assertTextContains("${StartProjectCopy.coordinatorAsked} ", substring = true)
        capture("stack-start-asked-1-top")
        compose.onNodeWithTag("$card-note").performScrollTo().assertTextEquals(StartProjectCopy.howItRunsNote(asked = true, suggestedOff = true))
        capture("stack-start-asked-2-how-it-runs")
        compose.onNodeWithTag("$card-level:1").performScrollTo().assertTextContains(StartProjectCopy.now)
        compose.onNodeWithTag("$card-level:4").performScrollTo().assertTextContains(StartProjectCopy.you)
        compose.onNodeWithTag("$card-caption").performScrollTo(); capture("stack-start-asked-3-plan-and-start")
        compose.onNodeWithTag("$card:START").performScrollTo().performClick()
        compose.waitUntil(90_000) { projectRecord(id).text("startedAt") != null }
        record("after Start", projectRecord(id).let { "startedAt=${it.text("startedAt")} coordinatorEnabled=${it["coordinatorEnabled"]} coordinatorSessionId=${it.text("coordinatorSessionId")}" })
        val startedWith = record("GET /projects/$id/acceptance/confirmation → startedWith",
            get("/projects/$id/acceptance/confirmation").jsonObject.obj("confirmation")?.obj("startedWith"))
        assertEquals(true, startedWith?.obj("settings")?.flag("automatic"))
        assertTrue("Automatic on is not what the coordinator suggested", "automatic" in startedWith?.strings("differsFromRequest").orEmpty())
        capture("stack-start-asked-4-started")
    }

    /** The owner's own Start… on a project nobody coordinates: the card says a start with Automatic on opens a coordinator, and
     * the server does — the project starts with its first coordinator. */
    @Test fun s15_theOwnersOwnStartOpensTheFirstCoordinator() = journey("stack-start-own") {
        val own = project("startOwn"); val id = own.text("id")!!
        record("before", projectRecord(id).let { "startedAt=${it["startedAt"]} coordinatorSessionId=${it["coordinatorSessionId"]}" })
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", own.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("project-start-own")); tap("project-start-own"); awaitTag("project-start-confirm")
        compose.onNodeWithTag("project-start-asked").assertTextEquals(StartProjectCopy.nobodyAskedLine(hasCoordinator = false))
        compose.onNodeWithTag("project-start-opens").performScrollTo().assertTextEquals(StartProjectCopy.opensCoordinator)
        capture("stack-start-own-1-top")
        compose.onNodeWithTag("project-start-level:4").performScrollTo().assertTextContains(StartProjectCopy.you)
        compose.onNodeWithTag("project-start-caption").performScrollTo().assertTextContains("Opens a coordinator", substring = true)
        compose.onNodeWithTag("project-start-sheet").performTouchInput { swipeUp() }; capture("stack-start-own-2-plan-and-start")
        compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        // As in s07: the server decides what the project can start on, and a refusal stays on the card in its words.
        val refusal = hasText(StartProjectCopy.notRecorded, substring = true)
        compose.waitUntil(90_000) { projectRecord(id).text("startedAt") != null || compose.onAllNodes(refusal).fetchSemanticsNodes().isNotEmpty() }
        if (projectRecord(id).text("startedAt") == null) {
            record("refused (shown on the card)", compose.onAllNodes(refusal).fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.Text)?.joinToString())
            compose.onNode(refusal).performScrollTo(); capture("stack-start-own-2b-refused")
            compose.onNodeWithTag("project-start-line").performScrollTo().performClick()
            compose.onNodeWithTag("project-start-line:MAIN").performClick()
            compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
        }
        // The start commits, then opens the coordinator before it answers: a read between the two sees only the first.
        compose.waitUntil(90_000) { projectRecord(id).let { it.text("startedAt") != null && it.text("coordinatorSessionId") != null } }
        val started = projectRecord(id)
        record("after Start", "startedAt=${started.text("startedAt")} coordinatorEnabled=${started["coordinatorEnabled"]} coordinatorSessionId=${started.text("coordinatorSessionId")}")
        assertNotNull("the start opened the project's first coordinator", started.text("coordinatorSessionId"))
        awaitGone("project-start-sheet"); capture("stack-start-own-3-started")
    }

    @Test fun s13_recordAsDoneThroughTheDoneDoorThenReopen() = journey("stack-done-door") {
        val automatic = project("automatic"); val id = automatic.text("id")!!
        record("before", projectRecord(id).let { "status=${it.text("status")} doneBy=${it["doneBy"]} derivedDone=${it.obj("derivedDone")?.obj("counts")}" })
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", automatic.text("title")!!)
        scrollTo("project-detail", hasTestTag("project-menu")); tap("project-menu")
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Record as done").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithText("Record as done").onFirst().performClick()
        awaitTag("project-done-record"); capture("stack-done-sheet")
        compose.onNodeWithTag("project-done-record").performScrollTo().performClick()
        compose.waitUntil(60_000) { projectRecord(id).text("status") == "DONE" }
        record("after Record as done", projectRecord(id).let { "status=${it.text("status")} doneBy=${it.text("doneBy")} acceptedGaps=${it.objects("acceptedGaps").size}" })
        assertEquals("OWNER", projectRecord(id).text("doneBy"))
        awaitTag("project-done-by"); capture("stack-done-recorded")
        scrollTo("project-detail", hasTestTag("project-menu")); tap("project-menu")
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Reopen project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Reopen project").performClick(); awaitTag("project-status-confirm"); tap("project-status-confirm")
        compose.waitUntil(60_000) { projectRecord(id).text("status") == "OPEN" }
        record("after Reopen", projectRecord(id).let { "status=${it.text("status")} doneBy=${it["doneBy"]}" })
        capture("stack-reopened")
    }

    // MARK: A11c · closing, crossings, the run queue, a landing that stopped reporting (seed-close.mjs, seed-stuck.mjs)

    /** A11-2, the conversation: the coordinator's "Is this project done?" drawn whole in the conversation it was asked from;
     * Record as done is the server's record (DONE, by the owner, the request answered), and Reopen project on the receipt opens
     * it again. */
    @Test fun s16_theCoordinatorAsksIfItIsDoneAndTheOwnerRecordsItInItsConversation() = journey("stack-done-asked") {
        val asked = project("closeAsked"); val id = asked.text("id")!!
        val row = record("GET /projects/$id/open-items → doneRequest", get("/projects/$id/open-items").jsonObject.obj("doneRequest")!!)
        val request = row.obj("doneRequest")!!
        signIn(); open("orbit-session:${asked.text("coordinatorSessionId")}")
        awaitScrollTo("transcript-list", hasTestTag("done:$id"), 60_000)
        compose.onNodeWithTag("done:$id-judgment").assertTextEquals(request.text("judgment")!!)
        compose.onNodeWithTag("done:$id-meta").assertTextContains("${asked.text("title")} · asked by the coordinator · waiting ", substring = true)
        compose.onNodeWithTag("done:$id-meta").performScrollTo(); capture("stack-done-asked-0-card")
        compose.onNodeWithTag("done:$id-gap:${request.objects("gaps").single().text("criterionKey")}").performScrollTo()
        capture("stack-done-asked-0b-gap")
        compose.onNodeWithTag("done:$id-record").performScrollTo().assertTextEquals(ProjectDone.recordAsDone).performClick()
        compose.waitUntil(60_000) { projectRecord(id).text("status") == "DONE" }
        val done = projectRecord(id)
        record("after Record as done", "status=${done.text("status")} doneBy=${done.text("doneBy")} acceptedGaps=${done.objects("acceptedGaps").map { it.text("criterionKey") }}")
        assertEquals("OWNER", done.text("doneBy"))
        record("GET /projects/$id/open-items → doneRequest after", get("/projects/$id/open-items").jsonObject["doneRequest"])
        awaitScrollTo("transcript-list", hasTestTag("done:$id-receipt"))
        compose.onNodeWithTag("done:$id-receipt-line").assertTextContains("You recorded this project done · ", substring = true)
        capture("stack-done-asked-1-receipt")
        compose.onNodeWithTag("done:$id-reopen").performScrollTo().performClick()
        compose.waitUntil(60_000) { projectRecord(id).text("status") == "OPEN" }
        record("after Reopen project", projectRecord(id).let { "status=${it.text("status")} doneBy=${it["doneBy"]}" })
        capture("stack-done-asked-2-reopened")
    }

    /** A11-2 and A11-4, the project page: the projects list says Ready to close, the page's Open items entry and reminder count
     * the request, its row opens the card, and Not yet… with a note ends the request on the server and hands the note to the
     * coordinator as its next message. */
    @Test fun s17_notYetSendsTheOwnersNoteToTheCoordinator() = journey("stack-done-not-yet") {
        val decline = project("closeDecline"); val id = decline.text("id")!!; val coordinator = decline.text("coordinatorSessionId")!!
        val request = record("GET /projects/$id/open-items → doneRequest", get("/projects/$id/open-items").jsonObject.obj("doneRequest")!!)
        signIn(); drawer("Projects"); awaitTag("projects-list"); awaitScrollTo("projects-list", hasTestTag("project:$id"))
        val ready = hasText(ProjectAttention.readyToCloseSays, substring = true)
        compose.waitUntil(30_000) { compose.onAllNodes((hasTestTag("project:$id") and ready) or (ready and hasAnyAncestor(hasTestTag("project:$id")))).fetchSemanticsNodes().isNotEmpty() }
        capture("stack-done-not-yet-0-list")
        tap("project:$id", "projects-list"); awaitTag("project-detail"); awaitIn("project-detail", decline.text("title")!!)
        compose.waitUntil(30_000) { compose.onAllNodesWithTag("project-open-items-count", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("project-open-items-count", useUnmergedTree = true).assertTextEquals("1")
        awaitScrollTo("project-detail", hasTestTag("open-items-attention"))
        compose.onNodeWithTag("open-items-attention").assertTextContains("1 item needs you", substring = true)
        capture("stack-done-not-yet-1-page")
        tap("open-items-attention", "project-detail"); awaitTag("project-done-request")
        compose.onNodeWithTag("project-done-request").assertTextContains("The coordinator asked · 1 gaps it couldn’t prove", substring = true)
        capture("stack-done-not-yet-2-open-items")
        tap("project-done-request:action"); awaitTag("project-done-sheet")
        compose.onNodeWithTag("project-done-judgment").assertTextEquals(request.obj("doneRequest")!!.text("judgment")!!)
        capture("stack-done-not-yet-3-card")
        compose.onNodeWithTag("project-done-not-yet").performScrollTo().performClick()
        val note = "The testers have not confirmed the notes page yet ($stamp)."
        compose.onNodeWithTag("project-done-note").performScrollTo().performTextInput(note); hideKeyboard()
        capture("stack-done-not-yet-4-note")
        compose.onNodeWithTag("project-done-send").performScrollTo().performClick()
        compose.waitUntil(60_000) { get("/projects/$id/open-items").jsonObject["doneRequest"].let { it == null || it is JsonNull } }
        record("GET /projects/$id/open-items → doneRequest after Not yet", get("/projects/$id/open-items").jsonObject["doneRequest"])
        assertEquals("OPEN", record("project status after Not yet", projectRecord(id).text("status")))
        // The note is the coordinator's next message: queued, or already in its conversation.
        fun told() = listOf("/sessions/$coordinator/turns", "/sessions/$coordinator/events/page?limit=200").firstOrNull { note in get(it).toString() }
        compose.waitUntil(60_000) { told() != null }
        record("the note, read back from", told())
        awaitGone("project-done-sheet"); capture("stack-done-not-yet-5-sent")
    }

    /** A11-3: the crossings the launch project is an end of, each answered in two presses — one approved (the task moves, read
     * back from the task), one refused (it stays where it was) — and each answer read back from the project's crossings. */
    @Test fun s18_crossingsAreAnsweredOnTheProjectPage() = journey("stack-crossings") {
        val to = project("crossTo"); val id = to.text("id")!!; val from = project("crossFrom")
        val approve = to.obj("moves")!!.obj("approve")!!; val refuse = to.obj("moves")!!.obj("refuse")!!
        fun crossings() = requireNotNull(ProjectCrossings.rows(get("/projects/$id/handoffs"))) { "unreadable crossings" }
        fun crossing(taskId: String?) = crossings().single { ProjectCrossings.subjectId(it) == taskId }
        record("GET /projects/$id/handoffs", crossings().map { "${it.text("id")} ${it.text("kind")} ${it.text("state")} subject=${ProjectCrossings.subjectId(it)}" })
        val yes = crossing(approve.text("taskId")).text("id")!!; val no = crossing(refuse.text("taskId")).text("id")!!
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", to.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("crossing:$yes"), 60_000)
        compose.onNodeWithTag("crossings-head").assert(hasAnyChild(hasText(ProjectCrossings.waiting(2))))
        capture("stack-crossings-0")
        tap("crossing:$yes:approve", "project-detail"); awaitTag("crossing:$yes:confirm")
        compose.onNodeWithText("Approve moving “${approve.text("title")}” from ${from.text("title")} to ${to.text("title")}?").assertExists()
        capture("stack-crossings-1-approve")
        tap("crossing:$yes:answer", "project-detail")
        compose.waitUntil(60_000) { crossing(approve.text("taskId")).text("state") != "PENDING" }
        record("after Approve", crossing(approve.text("taskId")).let { "state=${it.text("state")} decidedAt=${it.text("decidedAt")}" })
        assertEquals("the approved task moved", id, record("GET /tasks/${approve.text("taskId")} → projectId", taskRecord(approve.text("taskId")!!).text("projectId")))
        awaitGone("crossing:$yes:confirm"); capture("stack-crossings-2-approved")
        tap("crossing:$no:refuse", "project-detail"); awaitTag("crossing:$no:confirm")
        capture("stack-crossings-3-refuse")
        tap("crossing:$no:answer", "project-detail")
        compose.waitUntil(60_000) { crossing(refuse.text("taskId")).text("state") != "PENDING" }
        assertEquals("DENIED", record("after Refuse", crossing(refuse.text("taskId")).text("state")))
        assertEquals("the refused task stays", from.text("id"), record("GET /tasks/${refuse.text("taskId")} → projectId", taskRecord(refuse.text("taskId")!!).text("projectId")))
        awaitGone("crossing:$no:confirm"); capture("stack-crossings-4-refused")
    }

    /** A11-7: the run queue's play press runs a task set to start by hand; the run is the stack runner's, read back to its end. */
    @Test fun s19_theRunQueuePlayPressRunsTheTask() = journey("stack-run-press") {
        val queue = project("runQueue"); val id = queue.text("id")!!; val taskId = queue.text("taskId")!!
        record("GET /projects/$id/panorama/ready → items", get("/projects/$id/panorama/ready?limit=5").jsonObject.objects("items").map { "${it.text("taskId")} ${it.text("runState")}" })
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", queue.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("queue:$taskId:run"), 60_000)
        compose.onNodeWithTag("queue:$taskId:run").assertTextEquals(ProjectPage.runPress).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("queue:$taskId:run:play", useUnmergedTree = true).assertExists()
        capture("stack-run-press-0")
        tap("queue:$taskId:run")
        compose.waitUntil(60_000) { taskRecord(taskId).text("status") != "OPEN" }
        record("status after the press", taskRecord(taskId).text("status"))
        compose.waitUntil(240_000) { taskRecord(taskId).text("status") in setOf("DONE", "FAILED", "CANCELLED") }
        assertEquals("DONE", record("status when the run ended", taskRecord(taskId).text("status")))
        record("its run", taskRecord(taskId).objects("sessions").map { "${it.text("id")} ${it.text("status")} ${it.text("createdAt")}" })
        capture("stack-run-press-1-ran")
    }

    /** A11-10: the landing row opens the jobs in flight, and the landing whose runner stopped reporting is retried from its row —
     * the server ends that generation and queues the next, retried by the owner. Needs `setup.sh stuck` first (it leaves the
     * stack runner stopped until `setup.sh unstick`). */
    @Test fun s20_aLandingThatStoppedReportingIsRetriedFromItsJob() = journey("stack-landing-retry") {
        val stuck = project("landingStuck"); val id = stuck.text("id")!!; val jobId = stuck.text("jobId")!!
        fun inFlight() = get("/projects/$id/integration").jsonObject.objects("inFlightJobs")
        record("GET /projects/$id/integration → inFlightJobs", inFlight().map {
            "${it.text("jobId")} ${it.text("kind")} ${it.text("state")} ${it.text("phase")} timedOut=${it["timedOut"]} retryable=${it["retryable"]} generation=${it["generation"]} limit=${it["limitSeconds"]}s"
        })
        assertEquals(true, inFlight().single { it.text("jobId") == jobId }.flag("retryable"))
        signIn(); open("orbit-project:$id"); awaitTag("project-detail"); awaitIn("project-detail", stuck.text("title")!!)
        awaitScrollTo("project-detail", hasTestTag("landing-row"), 60_000)
        compose.onNodeWithTag("landing-timed-out", useUnmergedTree = true).assertExists()
        capture("stack-landing-0-row")
        tap("landing-row", "project-detail"); awaitTag("landing-jobs-sheet")
        compose.onNodeWithTag("landing-job:$jobId:retry").assertTextEquals(ProjectPage.landingRetry)
        capture("stack-landing-1-jobs")
        tap("landing-job:$jobId:retry")
        compose.waitUntil(60_000) { inFlight().none { it.text("jobId") == jobId } }
        val next = inFlight().single { it.text("kind") == "LAND_TASK" }
        record("after Retry", "${next.text("jobId")} ${next.text("state")} generation=${next["generation"]} retriedBy=${next.text("retriedBy")}")
        assertEquals("OWNER", next.text("retriedBy")); assertEquals(2, next.number("generation"))
        awaitText("Generation 2 · retried by you at"); capture("stack-landing-2-retried")
    }

    // MARK: A08c · a batch create's review and a merge-check change, answered on cards the stack runner's own doors filed
    // (scripts/a11-stack/seed-a08c.mjs, from the main project's coordinator session). The answer is read back from the server here;
    // finish-a08c.mjs then plays the runner's part (the batch created, the check written) and reads that back.

    private val a08c by lazy { seed.obj("a08c")!! }
    /** The card as the server holds it now, by the id the runner's door returned. */
    private fun card(id: String) = get("/sessions/${a08c.text("sessionId")}/approvals").jsonArray.map { it.jsonObject }
        .single { ObjectId.same(it.text("id"), id) }

    /** A08-7: the batch's review lists its tasks by level and opens each one's page; its yes names the count, and the server
     * records it on the card the runner filed. */
    @Test fun s21_a08cTheBatchIsReviewedByLevelAndAllowedOnItsCard() = journey("stack-a08c-batch") {
        val batch = a08c.obj("batch")!!
        val before = card(batch.text("approvalId")!!); val key = "approval:${before.text("id")}"
        record("GET approvals → the batch card", "${before.text("toolName")} ${before.text("status")} taskCount=${before.obj("input")?.obj("preview")?.number("taskCount")}")
        assertEquals("PENDING", before.text("status"))
        signIn(); open("orbit-session:${a08c.text("sessionId")}"); awaitTag("interaction-cards")
        awaitScrollTo("transcript-list", hasTestTag("$key:preview")); capture("stack-a08c-batch-0-preview")
        tap("$key:preview"); awaitTag("card-review"); awaitTag("batch-level:2")
        compose.onNodeWithTag("card-review:title").assertTextEquals(CardPreviews.batchTitle(3))
        batch.strings("titles").forEach { compose.onNodeWithText(it).performScrollTo().assertIsDisplayed() }
        capture("stack-a08c-batch-1-levels")
        compose.onNodeWithTag("batch-row:3").performScrollTo().performClick(); awaitTag("batch-task-page:3")
        capture("stack-a08c-batch-2-task-page")
        compose.onNodeWithTag("batch-task-page:back").performScrollTo().performClick(); awaitTag("batch-level:1")
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("$key:CREATE_BATCH") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("$key:CREATE_BATCH").assertTextEquals(BatchReview.createAction(3)).performClick()
        compose.waitUntil(30_000) { card(before.text("id")!!).text("status") != "PENDING" }
        val after = record("GET approvals → the batch card after Create 3 tasks", card(before.text("id")!!).let { "${it.text("status")} decidedAt=${it.text("decidedAt")}" })
        assertTrue(after, after.startsWith("ALLOWED"))
        awaitGone("card-review"); capture("stack-a08c-batch-3-recorded")
    }

    /** A08-8: the merge-check change offers no standing yes and no Deny — saying no is Chat about this — and Allow is recorded on
     * the card the runner filed. */
    @Test fun s22_a08cTheMergeCheckChangeIsAllowedWithNoStandingYes() = journey("stack-a08c-merge") {
        val merge = a08c.obj("merge")!!
        val before = card(merge.text("approvalId")!!); val key = "approval:${before.text("id")}"
        record("GET approvals → the merge-check card", "${before.text("toolName")} ${before.text("status")} input=${before.obj("input")}")
        assertEquals("PENDING", before.text("status"))
        signIn(); open("orbit-session:${a08c.text("sessionId")}"); awaitTag("interaction-cards")
        awaitScrollTo("transcript-list", hasTestTag(key))
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("$key:ALLOW") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("$key:CHAT").assertExists()
        compose.onNodeWithTag("$key:DENY").assertDoesNotExist(); compose.onNodeWithTag("$key:REMEMBER").assertDoesNotExist()
        capture("stack-a08c-merge-0-card")
        compose.onNodeWithTag("$key:ALLOW").performScrollTo().performClick()
        compose.waitUntil(30_000) { card(before.text("id")!!).text("status") != "PENDING" }
        val after = record("GET approvals → the merge-check card after Allow", card(before.text("id")!!).let { "${it.text("status")} decidedAt=${it.text("decidedAt")}" })
        assertTrue(after, after.startsWith("ALLOWED"))
        awaitText("Allowed · recorded by the server"); capture("stack-a08c-merge-1-recorded")
    }
}
