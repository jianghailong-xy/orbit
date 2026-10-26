package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
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
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A05e on a device, over a controlled HTTP fixture (not a deployment). Move to Trash answers the press itself (A05-9, iOS
 * 62b7009ca): with the server's answer held back, the row leaves the list, a member leaves the project's sessions page, and the
 * session page goes; the toast follows the server's answer, and a refusal brings the row back at once. The drawer's project row
 * counts what waits on you as iOS does (A11-2). The theme is the device's (the script runs it light and dark); every step leaves a
 * screenshot in files/a05e/<theme>.
 */
@RunWith(AndroidJUnit4::class)
class TrashDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a05e_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a05e/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A05eWorkspaceAlpha01"; private val beta = "34A05eWorkspaceBeta002"
    private val launch = "34A05eProjectLaunch001"
    private val coord = "34A05eSessionCoord0001"; private val worker = "34A05eSessionWorker002"; private val waiting = "34A05eSessionWaiting03"
    private val plain = "34A05eSessionPlain0004"; private val done = "34A05eSessionDone00005"
    private val ids = listOf(alpha, beta, launch, coord, worker, waiting, plain, done)
    /** What each move to Trash is answered with, in order; the DELETE waits for its answer. */
    private val answers = LinkedBlockingQueue<Int>()
    @Volatile private var trashed = setOf<String>()

    @Test fun moveToTrashAnswersThePressAndTheDrawerCountsWhatWaits() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a05e_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a05e@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a05e-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                // A11-2 · the drawer's project row: a question, two escalations, a start and a close asked for — five things.
                openDrawer(); await { exists(drawerRow("Launch")) && exists(hasTestTag("drawer-project-needs-you:$launch"), unmerged = true) }
                assertTrue(exists(drawerRow("Launch") and hasContentDescription("5 waiting for you")))
                capture("01-drawer-count")
                compose.onNode(drawerRow("Alpha")).performClick(); settle()

                // A05-9 · the list: the row goes on the press, while the server's answer is held back.
                await { exists(hasContentDescription("Options for Plain notes")) }
                capture("02-list")
                rowAction("Plain notes")
                await { calls.any { it == "DELETE /api/sessions/$plain" } }
                assertFalse(exists(hasContentDescription("Options for Plain notes")))
                assertFalse(toastShows("Moved to Trash"))
                capture("03-pressed-answer-held")
                answers.put(200)
                await { toastShows("Moved to Trash") }
                capture("04-taken-toast")
                await { app.trashing.ids.value.isEmpty() }
                assertFalse(exists(hasContentDescription("Options for Plain notes")))
                // The card goes by itself; nothing the next press aims at is under it then.
                await { !toastShows("Moved to Trash") }

                // The project's sessions page: a member goes on the press too; refused, it is back at once and the toast says why. The
                // page's list is scrolled to its rows: on a 360×640 dp phone the ones below the fold are not composed until then.
                compose.onNodeWithTag("project-row:$launch").performClick(); settle()
                await { exists(hasTestTag("project-sessions")) }
                compose.awaitListed(hasContentDescription("Options for Shipped docs"))
                rowAction("Shipped docs")
                await { calls.any { it == "DELETE /api/sessions/$done" } }
                assertFalse(compose.listed(hasContentDescription("Options for Shipped docs")))
                capture("05-member-pressed")
                answers.put(409)
                await { toastShows("Couldn't move to Trash") }
                compose.awaitListed(hasContentDescription("Options for Shipped docs"))
                capture("06-refused-back")
                // A failure stays pinned until it is dealt with: dismiss it.
                dismissPinned("Couldn't move to Trash")

                // The session page: Move to Trash takes the page away on the press.
                compose.awaitListed(hasText("Wire tests") and hasClickAction())
                compose.onNode(hasText("Wire tests") and hasClickAction()).performClick(); settle()
                await { exists(hasContentDescription("Session actions") and isEnabled()) && app.realtime.state.value.session?.fresh == true }
                compose.onNodeWithContentDescription("Session actions").performClick(); settle()
                val trash = hasText("Move to Trash") and hasAnyAncestor(isPopup()) and hasClickAction()
                await { exists(trash and isEnabled()) }
                capture("07-session-menu")
                compose.onNode(trash).performClick()
                await { calls.any { it == "DELETE /api/sessions/$worker" } }
                await { exists(hasTestTag("project-sessions")) && !exists(hasTestTag("transcript-list")) }
                assertFalse(compose.listed(hasContentDescription("Options for Wire tests")))
                assertFalse(toastShows("Moved to Trash"))
                capture("08-page-left-on-press")
                answers.put(200)
                await { toastShows("Moved to Trash") }
                await { app.trashing.ids.value.isEmpty() }
                assertFalse(compose.listed(hasContentDescription("Options for Wire tests")))
                capture("09-member-taken")
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                repeat(3) { answers.put(504) }
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
    private fun list(vararg sessions: String) = sessions.filter { it !in trashed }.joinToString(",", "[", "]") { session(it) }
    private val since get() = ago(90)
    private val attention get() = """{"ownerItems":[{"kind":"COORDINATOR_QUESTION","count":1,"oldestWaitingSince":"$since"},
        {"kind":"ESCALATED","count":2,"oldestWaitingSince":"$since"}],"startRequest":{"waitingSince":"$since"},"doneRequest":{"waitingSince":"$since"}}"""

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05e-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a05e-fixture-access","refreshToken":"a05e-fixture-refresh","user":{"id":"u1","email":"a05e@example.test","name":"A05e fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a05e@example.test","name":"A05e fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
                    {"id":"$beta","name":"Beta","runnerId":"r1","enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" && project != null -> if (view == "open") list(coord, worker, waiting) else if (view == "completed") list(done) else "[]"
                path == "/api/sessions" -> when (view) { "open" -> list(coord, worker, waiting, plain); "completed" -> list(done); else -> "[]" }
                parts[0] == "sessions" && parts.size == 2 && request.method == "DELETE" -> {
                    // The server's answer to a move to Trash waits until the journey says what it is.
                    val status = answers.poll(60, TimeUnit.SECONDS) ?: 504
                    if (status != 200) return MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json")
                        .setBody("""{"message":"The session is busy."}""")
                    trashed = trashed + parts[1]
                    "{}"
                }
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(parts[1])
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":2},
                    "taskCounts":{"done":3,"failed":1,"total":8},"attention":$attention,"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":"2026-10-02T00:00:00Z"}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z","attention":$attention}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":8},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","integration":{"escalationSeconds":7200}}"""
                parts == listOf("projects", launch, "integration") -> """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
                    "inFlight":{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"}}"""
                parts == listOf("projects", launch, "open-items") -> """{"needsYou":[],"withCoordinator":[]}"""
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

    private fun rowAction(session: String) {
        compose.onNodeWithContentDescription("Options for $session").performScrollTo().performClick(); settle()
        await { exists(hasText("Move to Trash") and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText("Move to Trash") and hasAnyAncestor(isDialog())).performScrollTo().performClick()
    }
    private fun toastShows(text: String) = exists(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    /** The open card's own Dismiss; folded into its pill after six seconds, a tap on the pill shows it whole first (a tap on an open
     * card's words would open its session instead). */
    private fun dismissPinned(text: String) {
        val dismiss = hasContentDescription("Dismiss") and hasAnyAncestor(hasTestTag("toast"))
        if (!exists(dismiss)) { compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("toast"))).performClick(); settle() }
        await { exists(dismiss) }
        compose.onNode(dismiss).performClick(); settle()
        await { !toastShows(text) }
    }
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
