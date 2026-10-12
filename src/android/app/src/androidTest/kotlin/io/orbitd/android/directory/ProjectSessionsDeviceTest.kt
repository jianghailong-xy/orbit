package io.orbitd.android.directory

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
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A05d on a device, over a controlled HTTP fixture (not a deployment): a workspace's list draws project Launch's sessions as one row
 * in its coordinator's place (A05-6), the row opens the project's sessions page over the list and Back returns to it, and the
 * drawer's project row opens that page as its destination's root (A05-7). The theme is the device's (the script runs it light and
 * dark); every step leaves a screenshot in files/a05d/<theme>.
 */
@RunWith(AndroidJUnit4::class)
class ProjectSessionsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a05d_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a05d/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A05dWorkspaceAlpha01"; private val beta = "34A05dWorkspaceBeta002"
    private val launch = "34A05dProjectLaunch001"
    private val coord = "34A05dSessionCoord0001"; private val worker = "34A05dSessionWorker002"; private val waiting = "34A05dSessionWaiting03"
    private val plain = "34A05dSessionPlain0004"; private val done = "34A05dSessionDone00005"
    private val ids = listOf(alpha, beta, launch, coord, worker, waiting, plain, done)
    @Volatile private var started = true

    @Test fun projectRowsAndTheProjectSessionsPage() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a05d_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a05d@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a05d-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                // A05-6 · Alpha's list: the project's sessions as one row in its coordinator's place, in their words.
                await { exists(hasTestTag("workspace:$alpha")) }
                compose.onNodeWithTag("workspace:$alpha").performClick()
                await { exists(hasTestTag("project-row:$launch")) && exists(hasTestTag("project-row-line") and hasText("Waiting for your confirmation · Quota retry"), unmerged = true) }
                assertFalse("the coordinator is the row", exists(hasContentDescription("Options for Coordinate launch")))
                assertFalse("so is the member running here", exists(hasContentDescription("Options for Wire tests")))
                assertTrue(exists(hasContentDescription("Options for Plain notes")))
                assertTrue(exists(hasText("3/8") and hasAnyAncestor(hasTestTag("project-progress-chip")), unmerged = true))
                assertTrue(exists(hasTestTag("project-row-running"), unmerged = true))
                capture("01-list-project-row")
                compose.onNodeWithContentDescription("Options for Launch").performClick()
                await { exists(hasText("Open Session") and hasAnyAncestor(isDialog())) }
                assertEquals(listOf("Open Session", "Sessions", "Open Project", "Pin", "Move…", "Close"), dialogButtons())
                capture("02-project-row-menu")
                compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick(); settle()

                // A05-7 · the row opens the project's sessions over the list.
                compose.onNodeWithTag("project-row:$launch").performClick()
                await { exists(hasTestTag("project-sessions")) && exists(hasText("Shipped docs")) && exists(hasTestTag("landing-row")) }
                await { exists(hasText("Launch") and hasText("Project · 4 sessions")) }
                compose.onNodeWithContentDescription("Back").assertExists()
                compose.onNodeWithContentDescription("Open Project").assertExists()
                assertTrue(exists(hasTestTag("project-sessions-progress-line") and hasText("3/8 done · 1 running")))
                assertEquals(listOf("Coordinator", "Coordinate launch", "Today", "Wire tests", "Quota retry", "2–7 days ago", "Shipped docs"), pageLines())
                capture("03-project-sessions")
                compose.onNodeWithContentDescription("Back").performClick(); settle()
                await { exists(hasTestTag("project-row:$launch")) }
                assertFalse(exists(hasTestTag("project-sessions")))
                capture("04-back-to-list")

                // A05-7 · the drawer's project row: the same page as its destination's root, led by the drawer's button.
                openDrawer(); await { exists(drawerRow("Launch")) }
                capture("05-drawer")
                compose.onNode(drawerRow("Launch")).performClick(); settle()
                await { exists(hasTestTag("project-sessions")) && exists(hasText("Shipped docs")) }
                compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                capture("06-drawer-root")
                compose.onNodeWithContentDescription("Open Project").performClick(); settle()
                await { exists(hasTestTag("project-detail")) }
                compose.onNodeWithContentDescription("Back").performClick(); settle()
                await { exists(hasTestTag("project-sessions")) }

                // A project nobody has started: "Not started", and the coordinator's request with the press that opens its card.
                started = false
                openDrawer(); compose.onNode(drawerRow("Alpha")).performClick(); settle()
                await { exists(hasTestTag("project-row:$launch")) }
                compose.onNodeWithTag("project-row:$launch").performClick()
                await { exists(hasTestTag("project-sessions-review-start")) && exists(hasText("Not started · 8 tasks")) }
                capture("07-not-started-asked")
                compose.onNodeWithTag("project-sessions-review-start").performClick()
                await { exists(hasTestTag("project-start-request-sheet")) && exists(hasTestTag("project-start-request")) }
                capture("08-start-card")
                compose.onNodeWithTag("project-start-request-cancel").performClick(); settle()
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

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun member(role: String) = """"projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, workspace: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurnAt: String = ago(5),
        approvals: Int = 0) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$workspace","name":"${if (workspace == alpha) "Alpha" else "Beta"}"},
            "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":$approvals,"tags":[],
            "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun session(id: String) = when (id) {
        coord -> row(coord, "Coordinate launch", alpha, "AWAITING_INPUT", ""","lastAssistantText":"Planning the release",${member("COORDINATOR")}""", lastTurnAt = ago(30))
        worker -> row(worker, "Wire tests", alpha, "RUNNING", ""","lastToolUse":"Bash",${member("TASK")}""", lastTurnAt = ago(2))
        waiting -> row(waiting, "Quota retry", beta, "AWAITING_INPUT", ""","waitingKind":"OWNER_CONFIRMATION",${member("TASK")}""", lastTurnAt = ago(10), approvals = 1)
        plain -> row(plain, "Plain notes", alpha, "AWAITING_INPUT", ""","lastAssistantText":"Notes kept"""")
        else -> row(done, "Shipped docs", alpha, "SUCCEEDED", ""","completedAt":"${ago(2 * 24 * 60)}",${member("TASK")}""", "COMPLETED", ago(2 * 24 * 60))
    }
    private fun list(vararg sessions: String) = sessions.joinToString(",", "[", "]") { session(it) }
    private fun startedAt() = if (started) "\"2026-10-02T00:00:00Z\"" else "null"

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05d-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a05d-fixture-access","refreshToken":"a05d-fixture-refresh","user":{"id":"u1","email":"a05d@example.test","name":"A05d fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a05d@example.test","name":"A05d fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
                    {"id":"$beta","name":"Beta","runnerId":"r1","enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" && project != null -> if (view == "open") list(coord, worker, waiting) else if (view == "completed") list(done) else "[]"
                path == "/api/sessions" -> when (view) { "open" -> list(coord, worker, waiting, plain); "completed" -> list(done); else -> "[]" }
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(parts[1])
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":2},
                    "taskCounts":{"done":3,"failed":1,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":${startedAt()}}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":8},"startedAt":${startedAt()},"coordinatorSessionId":"$coord","integration":{"escalationSeconds":7200},
                    "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"The session list groups a project's sessions."},
                    {"id":"c2","ordinal":2,"text":"The project's sessions page opens and returns."}]}"""
                parts == listOf("projects", launch, "integration") -> """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
                    "inFlight":{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"}}"""
                parts == listOf("projects", launch, "open-items") -> if (started) """{"needsYou":[],"withCoordinator":[]}""" else """{"needsYou":[],"withCoordinator":[],
                    "startRequest":{"itemId":"start-1","waitingSince":"${ago(130)}","startRequest":{"criteriaDigest":"digest-1","why":"Every task is filed and the plan is set.",
                    "settings":{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null,"projectBranchName":"project/launch"}}}}"""
                parts == listOf("projects", launch, "acceptance", "confirmation") -> """{"currentVersion":{"digest":"digest-1"}}"""
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

    // A finite response reconnects and re-reads the lists while the journey looks at them: hold it open.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    private fun pageLines(): List<String> = compose.onAllNodes(hasAnyAncestor(hasTestTag("project-sessions"))).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
        .filter { it in setOf("Coordinator", "Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older", "Coordinate launch", "Wire tests", "Quota retry", "Shipped docs") }
    private fun dialogButtons(): List<String> = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    private fun openDrawer() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        settle()
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
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
