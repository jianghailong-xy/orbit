package io.orbitd.android.directory

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A05c on a device, over a controlled HTTP fixture (not a deployment): the drawer's rows as destinations (A05-8), the
 * Tasks list's Set assignee order (A05-2), the session page's ⋯ menu (A05-3) and the app's toasts (A05-4). Each step
 * leaves a screenshot in files/a05c.
 */
@RunWith(AndroidJUnit4::class)
class NavigationIncrementDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val evidence get() = File(app.filesDir, "a05c").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A05cWorkspaceAlpha01"; private val spare = "34A05cWorkspaceSpare02"; private val beta = "34A05cWorkspaceBeta003"
    private val task = "34A05cTaskAssignMe0001"; private val project = "34A05cProjectLaunch001"
    private val review = "34A05cSessionReview001"; private val plain = "34A05cSessionPlain0002"; private val old = "34A05cSessionTrashed03"
    @Volatile private var lifecycle = mapOf(review to "OPEN", plain to "OPEN", old to "TRASH")
    @Volatile private var refuseComplete = false

    @Test fun drawerDestinationsSessionMenuAndToasts() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a05c_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a05c@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a05c-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                // A05-8 · the drawer's rows are destinations: its workspaces in iOS's order, its open project.
                openDrawer(); await { compose.onAllNodes(row("Launch")).fetchSemanticsNodes().isNotEmpty() }
                capture("01-drawer")
                compose.onNode(row("Tasks")).performClick()
                await { exists(hasTestTag("task:$task")) }
                compose.onNodeWithTag("task:$task").performClick()
                await { exists(hasTestTag("task-assignee")) }
                capture("02-task-page")
                // The destination already showing: its row is the selected one, and pressing it only closes the drawer.
                openDrawer(); compose.onNode(row("Tasks")).assertIsSelected()
                capture("03-drawer-tasks-selected")
                compose.onNode(row("Tasks")).performClick(); settle()
                assertTrue("the task page stays", exists(hasTestTag("task-assignee")))
                compose.onNodeWithContentDescription("Back").assertExists()
                capture("04-current-row-only-closes")
                // Another destination lands on its root; back to Tasks is the list, not the task left there.
                openDrawer(); compose.onNode(row("Alpha")).performClick(); settle()
                await { exists(hasContentDescription("Options for Review navigation")) }
                compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                capture("05-workspace-root")
                openDrawer(); compose.onNode(row("Tasks")).performClick(); settle()
                await { exists(hasTestTag("task:$task")) }
                assertFalse("the Tasks list at its root", exists(hasTestTag("task-assignee")))
                capture("06-tasks-root")

                // A05-2 · Set assignee lists the workspaces with a runner first, as the drawer does.
                compose.onNodeWithTag("tasks-options").performClick()
                compose.onNodeWithText("Select Tasks").performClick()
                compose.onNodeWithTag("task:$task").performClick()
                compose.onNode(hasText("Set assignee") and hasAnyAncestor(hasTestTag("tasks-bulk-bar"))).performClick()
                await { exists(hasText("Spare") and hasAnyAncestor(isDialog())) }
                val offered = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
                    .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") }
                assertEquals(listOf("Alpha", "Beta", "Spare", "Unassigned", "Cancel"), offered)
                capture("07-set-assignee-order")
                compose.onNodeWithText("Cancel").performClick()
                compose.onNodeWithTag("tasks-select-done").performClick()

                // A05-8 · a project row: the project's page as a destination of its own, led by the drawer's button.
                openDrawer(); compose.onNode(row("Launch")).performClick(); settle()
                await { exists(hasTestTag("project-detail")) }
                compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                capture("08-project-destination")
                openDrawer(); compose.onNode(row("Launch")).assertIsSelected(); compose.onNode(row("Projects")).assertIsNotSelected()
                capture("09-drawer-project-selected")
                compose.onNode(row("Alpha")).performClick(); settle()

                // A05-3 · the session page's ⋯ in the bar, in iOS's order, with what would stop its live run.
                await { exists(hasText("Review navigation") and hasClickAction()) }
                compose.onNode(hasText("Review navigation") and hasClickAction()).performClick()
                await { exists(hasContentDescription("Session actions") and isEnabled()) }
                compose.onNodeWithContentDescription("Session actions").performClick(); settle()
                assertEquals(listOf("Share…", "Copy Link", "Rename…", "Pin", "Move…", "Tags…", "Open Task", "Complete Session", "Move to Trash"), menuItems())
                compose.onNode(hasText("Complete Session") and hasText("Stops the current run") and hasAnyAncestor(isPopup())).assertExists()
                capture("10-session-menu")
                // Copy Link: the signed-in address, and the toast that says so.
                compose.onNode(hasText("Copy Link") and hasAnyAncestor(isPopup())).performClick()
                await { exists(hasText("Link copied") and hasAnyAncestor(hasTestTag("toast"))) }
                capture("11-link-copied")
                waitForFocus()
                val clip = (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString()
                File(evidence, "copied-link.txt").writeText("$clip\n")
                assertEquals("${server.url("/").toString().trimEnd('/')}/sessions/$review", clip)
                // A05-4 · Complete Session: the page goes, and "Session completed" with Undo is a card under the bar.
                compose.mainClock.advanceTimeBy(3_500)
                awaitWritable()
                compose.onNodeWithContentDescription("Session actions").performClick(); settle()
                press(hasText("Complete Session") and hasAnyAncestor(isPopup()))
                await { exists(hasText("Session completed") and hasAnyAncestor(hasTestTag("toast"))) }
                await { !exists(hasTestTag("transcript-list")) }
                capture("12-completed-toast-undo")
                compose.onNode(hasText("Undo") and hasAnyAncestor(hasTestTag("toast"))).performClick()
                await { calls.any { it.startsWith("POST /api/sessions/$review/restore") } }
                await { exists(hasText("Moved to Open") and hasAnyAncestor(hasTestTag("toast"))) }
                capture("13-moved-to-open-pill")

                // A trashed session's menu: Move to Open, and Delete Permanently asked first.
                compose.mainClock.advanceTimeBy(3_500)
                // A link as the running Activity receives one, without pausing it; the launch intent is put back for
                // ActivityScenario's teardown.
                compose.activityRule.scenario.onActivity {
                    val launch = it.intent
                    instrumentation.callActivityOnNewIntent(it, android.content.Intent(android.content.Intent.ACTION_VIEW,
                        android.net.Uri.parse("orbit-session:$old")).setClass(it, MainActivity::class.java))
                    it.intent = launch
                }
                await { exists(hasContentDescription("Session actions") and isEnabled()) }
                awaitWritable()
                compose.onNodeWithContentDescription("Session actions").performClick(); settle()
                assertEquals(listOf("Move to Open", "Delete Permanently"), menuItems())
                capture("14-trash-menu")
                awaitWritable()
                press(hasText("Delete Permanently") and hasAnyAncestor(isPopup()))
                await { exists(hasText("Delete permanently?")) }
                capture("15-delete-permanently-asked")
                compose.onNodeWithText("Close").performClick()
                compose.onNodeWithContentDescription("Back").performClick(); settle()

                // A05-4 · a failure is a tinted card pinned with the server's words, then folds into a pill.
                refuseComplete = true
                await { exists(hasContentDescription("Options for Plain notes")) }
                awaitWritable()
                compose.onNodeWithContentDescription("Options for Plain notes").performScrollTo().performClick()
                press(hasText("Complete") and hasAnyAncestor(isDialog()))
                await { exists(hasText("Couldn't complete the session") and hasAnyAncestor(hasTestTag("toast"))) }
                assertTrue(exists(hasText("The session is busy.") and hasAnyAncestor(hasTestTag("toast"))))
                capture("16-failure-card")
                compose.mainClock.advanceTimeBy(6_500); settle()
                assertFalse("folded: the server's words are behind the pill", exists(hasText("The session is busy.") and hasAnyAncestor(hasTestTag("toast"))))
                assertTrue("still there, not on a timer", exists(hasText("Couldn't complete the session") and hasAnyAncestor(hasTestTag("toast"))))
                capture("17-failure-folded-pill")
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                app.realtime.selectSession(null)
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05c-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/')
            val id = parts.getOrNull(1)?.let { part -> listOf(review, plain, old).firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } }
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a05c-fixture-access","refreshToken":"a05c-fixture-refresh","user":{"id":"u1","email":"a05c@example.test","name":"A05c fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a05c@example.test","name":"A05c fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
                    {"id":"$spare","name":"Spare","runnerId":null,"enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"},
                    {"id":"$beta","name":"Beta","runnerId":"r1","enabled":true,"position":2,"createdAt":"2026-10-01T03:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" -> {
                    val view = request.requestUrl!!.queryParameter("view") ?: "open"
                    "[" + listOf(review, plain, old).filter { (lifecycle[it] ?: "OPEN") == view.uppercase() }.joinToString(",") { session(it) } + "]"
                }
                id != null && parts.size == 2 && request.method == "GET" -> session(id)
                id != null && parts.last() == "complete" -> {
                    if (refuseComplete) return MockResponse().setResponseCode(409).setHeader("Content-Type", "application/json").setBody("""{"message":"The session is busy."}""")
                    lifecycle = lifecycle + (id to "COMPLETED"); "{}"
                }
                id != null && parts.last() == "restore" -> { lifecycle = lifecycle + (id to "OPEN"); "{}" }
                id != null && parts.last() == "events" -> return heartbeatStream()
                id != null && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/tasks/page" -> """{"items":[${task()}],"nextCursor":null}"""
                parts.size == 2 && parts[0] == "tasks" && io.orbitd.android.navigation.ObjectId.same(parts[1], task) -> task()
                parts[0] == "tasks" -> "{}"
                path == "/api/projects" -> """[${project()}]"""
                parts.size == 2 && parts[0] == "projects" -> project()
                parts[0] == "projects" -> "{}"
                parts[0] == "wiki" -> return MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
                path.endsWith("/logout") -> "{}"
                request.method == "GET" -> "[]"
                else -> "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }

    /** Review navigation is run by a task and waits for input (a live run, as iOS counts it); Plain notes has ended. */
    private fun session(id: String): String {
        val title = when (id) { review -> "Review navigation"; plain -> "Plain notes"; else -> "Old draft" }
        val state = lifecycle[id] ?: "OPEN"
        val run = if (id == review) "AWAITING_INPUT" else "ENDED"
        val linked = if (id == review) ""","taskId":"$task","projectId":"$project"""" else ""
        return """{"id":"$id","title":"$title","status":"${if (run == "ENDED") "CANCELLED" else run}","runState":"$run","lifecycleState":"$state",
            "agent":{"id":"$alpha","name":"Alpha"},"agentId":"$alpha","createdAt":"2026-10-08T08:00:00Z","lastTurnAt":"2026-10-09T01:00:00Z",
            "capabilities":{"canComplete":${state == "OPEN"},"canRestore":${state != "OPEN"}},"tags":[],"pendingApprovals":0$linked}"""
    }
    private fun task() = """{"id":"$task","title":"Assign me","status":"OPEN","priority":0,"createdAt":"2026-10-08T00:00:00Z",
        "updatedAt":"2026-10-08T00:00:00Z","creatorType":"USER","comments":[],"dependsOn":[],"dependedOnBy":[]}"""
    private fun project() = """{"id":"$project","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}"""

    // A finite response reconnects and re-reads the lists while the journey looks at them: hold it open.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    private fun row(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    /** Writes are offered while the directory, and the session page's own read, are fresh: a refresh (one follows
     * every write) holds them back for a moment. */
    /** Presses [matcher] once it is enabled. */
    private fun press(matcher: SemanticsMatcher) {
        await { exists(matcher and isEnabled()) }
        compose.onNode(matcher and isEnabled()).performScrollTo().performClick()
    }
    private fun awaitWritable() = await {
        val live = app.realtime.state.value
        live.directoryFresh && !live.directoryRefreshing && live.session?.fresh != false
    }
    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun openDrawer() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        settle()
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    /** Android 13+ puts its clipboard overlay up after a copy; only the focused app may read the clip. */
    private fun waitForFocus() {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!compose.activity.hasWindowFocus() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(600) // the swiftshader frame lags the UI under load
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
