package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.SystemClock
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
 * A-2 on a device over a controlled HTTP fixture (not a deployment): the four ways into the project's landing session — the Landing
 * card's foot, the jobs list's row, the merge check card's head row, and the waiting card's Open landing in the coordinator's
 * conversation — each opening the landing page and coming back. The theme is the device's (the script runs it light and dark); every
 * step leaves a screenshot in files/a2/<theme>, and every request the app made is kept beside them.
 */
@RunWith(AndroidJUnit4::class)
class LandingEntriesDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a2_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a2/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A2WorkspaceAlpha001"
    private val launch = "34A2ProjectLaunch001"
    private val coord = "34A2SessionCoord0001"; private val worker = "34A2SessionWorker002"; private val done = "34A2SessionDone0003"
    private val landing = "34A2SessionLanding04"
    private val ids = listOf(alpha, launch, coord, worker, done, landing)

    /** Whether the merge check is the job in flight (the card's mode) rather than a task landing on the branch. */
    @Volatile private var merge = false

    @Test fun theFourWaysIntoALandingSession() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a2_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a2@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a2-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                await { exists(hasTestTag("workspace:$alpha")) }
                compose.onNodeWithTag("workspace:$alpha").performClick()
                await { exists(hasTestTag("project-row:$launch")) }
                capture("00a-after-workspace")
                compose.onNodeWithTag("project-row:$launch").performClick()
                capture("00b-after-project-row")

                // A · the Landing card's foot.
                await { exists(hasTestTag("landing-card:open-landing")) }
                capture("01-landing-card")
                compose.onNodeWithTag("landing-card:open-landing").performClick()
                await { exists(hasTestTag("landing-page")) }
                compose.onNodeWithTag("landing:title", useUnmergedTree = true).assertExists()
                capture("02-landing-from-card")
                back(); await { exists(hasTestTag("project-sessions")) }

                // B · a row of the jobs list.
                compose.onNodeWithTag("landing-card:body").performClick()
                await { exists(hasTestTag("landing-jobs-sheet")) && exists(hasTestTag("landing-job:j-1:open-landing")) }
                capture("03-jobs-list")
                compose.onNodeWithTag("landing-job:j-1:open-landing").performClick()
                await { exists(hasTestTag("landing-page")) }
                capture("04-landing-from-jobs")
                back(); await { exists(hasTestTag("project-sessions")) }

                // C · the merge check card's whole head row.
                merge = true
                await { exists(hasTestTag("project-merge-card:checking")) && exists(hasTestTag("project-merge-card:landing")) }
                capture("05-merge-card")
                compose.onNodeWithTag("project-merge-card:landing").performClick()
                await { exists(hasTestTag("landing-page")) }
                capture("06-landing-from-merge")
                back(); await { exists(hasTestTag("project-sessions")) }

                // D · the waiting card's Open landing, in the coordinator's conversation.
                await { exists(hasText("Coordinate launch") and hasClickAction()) }
                compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
                await { exists(hasTestTag("item:item-xe5:OPEN_LANDING")) }
                compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("item:item-xe5:OPEN_LANDING"))
                capture("07-xe5-card")
                compose.onNodeWithTag("item:item-xe5:OPEN_LANDING").performClick()
                await { exists(hasTestTag("landing-page")) }
                capture("08-landing-from-waiting-card")
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
    private fun row(id: String, title: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurnAt: String = ago(5)) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$alpha","name":"Alpha"},
            "agentId":"$alpha","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":0,"tags":[],
            "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun session(id: String) = when (id) {
        coord -> row(coord, "Coordinate launch", "AWAITING_INPUT", ""","lastAssistantText":"Planning the release","projectId":"$launch",${member("COORDINATOR")}""", lastTurnAt = ago(30))
        worker -> row(worker, "Wire tests", "RUNNING", ""","lastToolUse":"Bash",${member("TASK")}""", lastTurnAt = ago(2))
        landing -> landingDetail()
        else -> row(done, "Shipped docs", "SUCCEEDED", ""","completedAt":"${ago(2 * 24 * 60)}",${member("TASK")}""", "COMPLETED", ago(2 * 24 * 60))
    }
    private fun list(vararg sessions: String) = sessions.joinToString(",", "[", "]") { session(it) }

    private fun job(id: String, kind: String = "LAND_TASK", state: String = "RUNNING") = """{"jobId":"$id","kind":"$kind","state":"$state",
        "phase":"CHECK","taskId":"t-$id","taskTitle":"Wire the page","generation":1,"startedAt":"${ago(60)}","queuedAt":"${ago(90)}",
        "heartbeatAt":"${ago(0)}","runnerName":"wikova","timedOut":false,"limitSeconds":600,"retryable":false,
        "landingSessionId":"$landing"}"""
    private fun integration() = if (merge)
        """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":2,"queuedCount":0,
            "inFlight":{"kind":"CHECK_PROMOTION","state":"RUNNING","phase":"CHECK","startedAt":"${ago(7)}","heartbeatAt":"${ago(0)}"},
            "inFlightJobs":[${job("j-1", kind = "CHECK_PROMOTION")},${job("j-2", state = "QUEUED")}]}"""
    else """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
            "inFlight":{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"},
            "inFlightJobs":[${job("j-1")}]}"""

    private fun landingDetail() = """{"id":"$landing","title":"Land · Wire the page","status":"AWAITING_INPUT","sessionKind":"LANDING",
        "workspace":null,"assignedRunner":null,"tags":[],"landing":{"sessionId":"$landing","projectId":"$launch","subject":"TASK",
        "taskId":"t-landing","promotionId":null,"episode":1,"openedAt":"${ago(600)}","settledAt":null,"settledAs":null,"checks":[],
        "currentAttempt":{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":1,"phase":"CHECK","round":1,"step":null,"claim":1,
        "runnerName":"wikova","sourceSessionId":"$landing","targetRef":"refs/heads/project/launch","startedAt":"${ago(110)}",
        "heartbeatAt":"${ago(0)}","outputMovedAt":"${ago(6)}","progressProtocol":"v2",
        "check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"},"liveness":"LIVE",
        "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false},"todos":[],"generations":[]}}"""

    private val xe5 = """{"itemId":"item-xe5","kind":"LANDING_LEASE_EXPIRED","title":"A landing stopped reporting",
        "detailLine":"The runner stopped reporting","assignee":"OWNER","assigneeReason":"ESCALATED","waitingSince":"${ago(120)}",
        "escalatedAt":"${ago(120)}","landingSessionId":"$landing","integrationJobId":"j-1","actions":["ABANDON","OPEN_LANDING"],
        "primaryAction":"ABANDON","requiredAction":"The runner stopped reporting; abandon this landing, or wait for the runner to come back.",
        "lease":{"jobKind":"LAND_TASK","generation":2,"phase":"REBASE","claimGeneration":1,"round":1,"checkCount":3,"runner":"wikova",
        "progressProtocol":"v2","pushReported":false,"lastReportAt":"${ago(300)}"}}"""

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a2-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a2-fixture-access","refreshToken":"a2-fixture-refresh","user":{"id":"u1","email":"a2@example.test","name":"A2 fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a2@example.test","name":"A2 fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/session-folders" || path == "/api/session-tags" -> "[]"
                path == "/api/watches" -> "[]"
                path == "/api/sessions" && project != null -> if (view == "open") list(coord, worker) else if (view == "completed") list(done) else "[]"
                path == "/api/sessions" -> when (view) { "open" -> list(coord, worker); "completed" -> list(done); else -> "[]" }
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(parts[1])
                parts[0] == "sessions" && parts.last() == "landing" || parts[0] == "sessions" && parts.last() == "log" ->
                    """{"jobId":"j-1","entries":[],"nextCursor":null}"""
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":1},
                    "taskCounts":{"done":5,"failed":0,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":"2026-10-02T00:00:00Z"}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":8},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","acceptanceCriteriaItems":[]}"""
                parts == listOf("projects", launch, "integration") -> integration()
                parts == listOf("projects", launch, "open-items") -> """{"needsYou":[$xe5],"withCoordinator":[]}"""
                parts == listOf("projects", launch, "coordinator", "status") -> """{"state":"NEVER_OPENED"}"""
                parts == listOf("projects", launch, "promotions", "current") -> return MockResponse().setResponseCode(200)
                parts == listOf("projects", launch, "promotions", "merged") -> "[]"
                parts == listOf("tasks", "t-landing") -> """{"id":"t-landing","title":"Wire the page"}"""
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

    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    private fun back() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        settle()
    }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(600)
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
