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
 * A11-9 on a device, over a controlled HTTP fixture (not a deployment): project Launch's merge into main on its sessions page — the card
 * under the progress card asking, merging, blocked and while the merge check runs; its review; a press the server takes and one it
 * refuses; the merge already made on the timeline and its receipt — and the coordinator conversation's one line per moment, opening the
 * same review and receipt. The theme is the device's (the script runs it light and dark); every step leaves a screenshot in
 * files/a11d/<theme>, and every request the app made is kept beside them.
 */
@RunWith(AndroidJUnit4::class)
class ProjectMergeDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a11d_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a11d/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val bodies = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val alpha = "34A11dWorkspaceAlpha01"
    private val launch = "34A11dProjectLaunch001"
    private val coord = "34A11dSessionCoord0001"; private val worker = "34A11dSessionWorker002"; private val done = "34A11dSessionDone00003"
    private val ids = listOf(alpha, launch, coord, worker, done)

    // What the fixture's server says about Launch's merge, moved by the journey.
    @Volatile private var promotion: String? = null
    @Volatile private var merged = "[]"
    @Volatile private var job = "LAND_TASK"
    @Volatile private var holder: String? = null
    @Volatile private var refuse = false

    @Test fun theMergeIntoMainOnTheProjectSessionsPage() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a11d_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a11d@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a11d-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                promotion = candidate("READY")
                await { exists(hasTestTag("workspace:$alpha")) }
                compose.onNodeWithTag("workspace:$alpha").performClick()
                await { exists(hasTestTag("project-row:$launch")) }
                compose.onNodeWithTag("project-row:$launch").performClick()

                // A · asking: what would land, the proof it was checked, the presses, Details.
                await { exists(hasTestTag("project-merge-card:asking")) && inCard("2 of 3 met on this branch — merging does not close the project") }
                assertTrue(inCard("Merge into main?")); assertTrue(inCard("Needs you")); assertTrue(inCard("project/launch · 7 commits ahead of main"))
                assertTrue(inCard("4 tasks · 10 files")); assertTrue(inCard("+1 more")); assertTrue(inCard("✓ Checks passed · no conflicts"))
                capture("01-asking")
                compose.onNodeWithTag("project-merge-card:details").performClick()
                await { exists(hasTestTag("project-merge-review")) && exists(hasText("P7 rehearsal") and hasAnyAncestor(hasTestTag("project-merge-review"))) }
                capture("02-review")
                compose.onNodeWithTag("project-merge-review:close").performClick(); settle()
                await { !exists(hasTestTag("project-merge-review")) }

                // B · Merge to main, pressed on the card with the candidate's SHA; the card follows its job.
                compose.onNodeWithTag("project-merge-card:confirm").performClick()
                await { exists(hasTestTag("project-merge-card:merging")) && inCard("confirmed — fetching the branches") }
                assertEquals("""{"sourceSha":"5e5bfca23aa1"}""", bodies["POST /api/projects/$launch/promotions/pr-1/confirm"])
                await { exists(hasText("Merge to main", substring = true) and hasAnyAncestor(hasTestTag("landing-row")), unmerged = true) }
                capture("03-merging")

                // D · blocked: why, who has it, the coordinator one press away.
                promotion = candidate("BLOCKED", conflicts = """["src/runner-go/session_pool.go","src/apiserver/prisma/schema.prisma"]""")
                holder = """{"itemId":"item-1","kind":"INTEGRATION_CONFLICT","title":"Merge conflict","waitingSince":"${ago(125)}","assignee":"COORDINATOR","promotionId":"pr-1"}"""
                job = "LAND_TASK"
                await { exists(hasTestTag("project-merge-card:blocked")) && exists(hasTestTag("project-merge-card:resolving"), unmerged = true) }
                capture("04-blocked")

                // The merge check running before anything is asked: the grey card with its live line.
                promotion = null; holder = null; job = "CHECK_PROMOTION"
                await { exists(hasTestTag("project-merge-card:checking")) }
                capture("05-checking")

                // C · merged: the candidate became the merge, as the server records one — no card; a row on the timeline at its own
                // instant, opening its receipt. (The page reads the merges again when the candidate moves, else once a minute.)
                job = "LAND_TASK"
                val made = """{"sha":"8d5a868e90df","at":"${ago(7)}","automatic":false,"revert":null}"""
                merged = "[${candidate("MERGED", merged = made)}]"
                promotion = candidate("MERGED", merged = made)
                await { !exists(hasTestTag("project-merge-card:checking")) && exists(hasTestTag("project-merge-row:pr-1")) }
                capture("06-timeline")
                compose.onNodeWithTag("project-merge-row:pr-1").performClick()
                await { exists(hasTestTag("promotion-receipt")) && exists(hasText("Fix D1") and hasAnyAncestor(hasTestTag("promotion-receipt"))) }
                capture("07-receipt")
                compose.onNodeWithTag("promotion-receipt:close").performClick(); settle()
                await { !exists(hasTestTag("promotion-receipt")) }

                // A press the server refuses says why under the card.
                promotion = candidate("READY", id = "pr-2"); refuse = true
                await { exists(hasTestTag("project-merge-card:asking")) }
                compose.onNodeWithTag("project-merge-card:confirm").performClick()
                await { exists(hasTestTag("project-merge-card:error")) }
                compose.onNodeWithTag("project-merge-card:error").assert(hasText("That merge was not confirmed — The candidate moved on."))
                capture("08-refused")
                refuse = false

                // The coordinator conversation: one line for the candidate and one for the merge made, each opening its sheet.
                compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
                await { exists(hasTestTag("promotion:pr-2:preview")) && exists(hasTestTag("merge:pr-1:line")) }
                compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("merge:pr-1:line"))
                capture("09-conversation-lines")
                compose.onNodeWithTag("promotion:pr-2:preview").performClick()
                await { exists(hasTestTag("card-review")) && exists(hasTestTag("promotion:pr-2:CONFIRM_MERGE")) }
                capture("10-conversation-review")
                compose.onNodeWithTag("card-review:close").performClick(); settle()
                await { !exists(hasTestTag("card-review")) }
                compose.onNodeWithTag("merge:pr-1:line").performClick()
                await { exists(hasTestTag("promotion-receipt")) }
                capture("11-conversation-receipt")
                compose.onNodeWithTag("promotion-receipt:close").performClick(); settle()
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                app.realtime.selectSession(null)
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                File(evidence, "bodies.txt").writeText(bodies.entries.joinToString("\n") { "${it.key} ${it.value}" })
            }
        }
    }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun candidate(state: String, id: String = "pr-1", conflicts: String = "[]", merged: String = "null") = """{"promotionId":"$id","state":"$state",
        "sourceRef":"refs/heads/project/launch","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":7,"filesChanged":10,
        "taskIds":["t1","t2","t3","t4"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs off by default"},
        {"taskId":"t3","title":"P6 end to end"},{"taskId":"t4","title":"P7 rehearsal"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],
        "conflicts":$conflicts,"landsAs":"MERGE_COMMIT","askedAt":"${ago(130)}","merged":$merged${
            if (state == "CONFIRMED") ""","execution":{"state":"RUNNING","phase":"FETCH","startedAt":"${ago(1)}"}""" else ""}}"""
    private fun member(role: String) = """"projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurnAt: String = ago(5)) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$alpha","name":"Alpha"},
            "agentId":"$alpha","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":0,"tags":[],
            "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun session(id: String) = when (id) {
        coord -> row(coord, "Coordinate launch", "AWAITING_INPUT", ""","lastAssistantText":"Planning the release","projectId":"$launch",${member("COORDINATOR")}""", lastTurnAt = ago(30))
        worker -> row(worker, "Wire tests", "RUNNING", ""","lastToolUse":"Bash",${member("TASK")}""", lastTurnAt = ago(2))
        else -> row(done, "Shipped docs", "SUCCEEDED", ""","completedAt":"${ago(2 * 24 * 60)}",${member("TASK")}""", "COMPLETED", ago(2 * 24 * 60))
    }
    private fun list(vararg sessions: String) = sessions.joinToString(",", "[", "]") { session(it) }
    private fun inFlight() = when (job) {
        "LAND_TASK" -> """{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"}"""
        "CHECK_PROMOTION" -> """{"kind":"CHECK_PROMOTION","state":"RUNNING","phase":"CHECK","startedAt":"${ago(7)}","heartbeatAt":"${ago(0)}"}"""
        else -> """{"kind":"LAND_PROMOTION","state":"RUNNING","phase":"FETCH","startedAt":"${ago(1)}","heartbeatAt":"${ago(0)}"}"""
    }

    /** A press on the candidate: its next state, or the server's refusal. */
    private fun press(door: String): MockResponse {
        if (refuse) return MockResponse().setResponseCode(409).setHeader("Content-Type", "application/json")
            .setBody("""{"message":"The candidate moved on","code":"PROMOTION_MOVED_ON"}""")
        val now = promotion ?: return MockResponse().setResponseCode(404)
        val next = when (door) { "confirm" -> "CONFIRMED"; "decline" -> "DECLINED"; else -> "CANCELLED" }
        promotion = candidate(next, id = Regex("\"promotionId\":\"([^\"]+)\"").find(now)!!.groupValues[1])
        if (next == "CONFIRMED") job = "LAND_PROMOTION"
        return MockResponse().setHeader("Content-Type", "application/json").setBody(promotion!!)
    }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (request.method == "POST") bodies["POST $path"] = request.body.readUtf8()
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a11d-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a11d-fixture-access","refreshToken":"a11d-fixture-refresh","user":{"id":"u1","email":"a11d@example.test","name":"A11d fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a11d@example.test","name":"A11d fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" && project != null -> if (view == "open") list(coord, worker) else if (view == "completed") list(done) else "[]"
                path == "/api/sessions" -> when (view) { "open" -> list(coord, worker); "completed" -> list(done); else -> "[]" }
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(parts[1])
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":1},
                    "taskCounts":{"done":5,"failed":0,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":"2026-10-02T00:00:00Z"}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":8},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","integration":{"escalationSeconds":7200},
                    "acceptanceCriteriaItems":[{"id":"c1","key":"c1","ordinal":1,"text":"Notes exist","satisfied":true},
                    {"id":"c2","key":"c2","ordinal":2,"text":"Contract written","satisfied":true},{"id":"c3","key":"c3","ordinal":3,"text":"Smoke passes","satisfied":false}]}"""
                parts == listOf("projects", launch, "integration") -> """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,"inFlight":${inFlight()}}"""
                parts == listOf("projects", launch, "open-items") -> """{"needsYou":[],"withCoordinator":[${holder.orEmpty()}]}"""
                parts == listOf("projects", launch, "promotions", "current") -> promotion ?: return MockResponse().setResponseCode(200)
                parts == listOf("projects", launch, "promotions", "merged") -> merged
                request.method == "POST" && parts.take(3) == listOf("projects", launch, "promotions") -> return press(parts.last())
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

    private fun inCard(text: String) = exists(hasText(text) and hasAnyAncestor(SemanticsMatcher("the merge card") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("project-merge-card:") == true }), unmerged = true)
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
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
