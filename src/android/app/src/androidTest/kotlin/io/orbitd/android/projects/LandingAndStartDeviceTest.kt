package io.orbitd.android.projects

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
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
 * A11f on a device, over the test's own controlled HTTP fixture — not a deployment. Project Launch's landing in flight as a card of its
 * own on its sessions page (iOS 749d995c5, 3b23aa163): running, queued, two jobs, timed out with Retry, and an older server's silent
 * runner; then its blocked merge naming the landing it is behind (iOS befc9694c) on the card, in the review Details opens and in the
 * coordinator conversation's review. Then project Aurora, which nobody has started, and its coordinator's start card (iOS d91a0dd48):
 * More only while three lines cut the coordinator's words, Read all only while two lines cut a criterion — each read back off the
 * drawn text's own layout and written to measurements.txt — and the plan as levels with Task graph when it is too wide for the phone,
 * or as the task graph when it fits at 0.7. Every step leaves a screenshot in files/a11f/<theme>.
 */
@RunWith(AndroidJUnit4::class)
class LandingAndStartDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a11f_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a11f/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val measurements = StringBuilder()
    private val alpha = "34A11fWorkspaceAlpha01"
    private val launch = "34A11fProjectLaunch001"
    private val aurora = "34A11fProjectAurora002"
    private val coord = "34A11fSessionCoord0001"; private val worker = "34A11fSessionWorker002"
    private val ids = listOf(alpha, launch, aurora, coord, worker)

    // What the fixture's server says, moved by the journey.
    /** Launch's `integration` read, built by [line]. */
    @Volatile private var integration = ""
    @Volatile private var promotion: String? = null
    @Volatile private var why = LONG_WHY
    @Volatile private var criteria = listOf("Reminders follow one rule on every client.", "The go-live is confirmed by the owner.")
    @Volatile private var plan = WIDE_PLAN

    @Test fun theLandingCardTheBlockedMergeAndTheStartCard() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a11f_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        // The installed app's own build, read off its class loader — this test's BuildConfig constants are the test APK's.
        fun appBuild(field: String) = Class.forName("io.orbitd.android.BuildConfig", true, app.javaClass.classLoader).getField(field).get(null)
        File(evidence, "identity.txt").writeText("app_sha=${appBuild("SOURCE_SHA")}\napp_dirty=${appBuild("SOURCE_DIRTY")}\n" +
            "test_sha=${BuildConfig.SOURCE_SHA}\ntest_dirty=${BuildConfig.SOURCE_DIRTY}\ntheme=$theme\n" +
            "scope=controlled HTTP fixture (MockWebServer in this test); not a deployed account\n")
        integration = line(listOf(job("j-1")))
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a11f@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a11f-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                await { exists(hasTestTag("workspace:$alpha")) }
                compose.onNodeWithTag("workspace:$alpha").performClick()
                await { exists(hasTestTag("project-row:$launch")) }
                compose.onNodeWithTag("project-row:$launch").performClick()

                // ① In flight: its own card under the progress card — the ring turning, the clock, the wait, the branch.
                await { exists(hasTestTag("landing-card")) && exists(hasTestTag("landing-ring:running"), unmerged = true) }
                val progress = compose.onNodeWithTag("project-sessions-progress").fetchSemanticsNode().boundsInRoot
                val card = compose.onNodeWithTag("landing-card").fetchSemanticsNode().boundsInRoot
                assertTrue("the card is under the progress card", card.top >= progress.bottom)
                assertEquals(0, compose.onAllNodes(hasTestTag("landing-card") and hasAnyAncestor(hasTestTag("project-sessions-progress"))).fetchSemanticsNodes().size)
                assertEquals("Landing", text("landing-head:title"))
                assertTrue(text("landing-head:detail")!!, text("landing-head:detail")!!.startsWith("checking · waited 0m 34s · updated"))
                assertEquals("onto project/launch", text("landing-card:onto"))
                assertTrue(exists(hasText(ProjectPage.landingNothingToDo) and hasAnyAncestor(hasTestTag("landing-card")), unmerged = true))
                record("landing running", "head=${text("landing-head:right")} | ${text("landing-head:detail")}")
                capture("01-landing-running")

                // ② Queued: the same card standing still.
                integration = line(listOf(job("j-1", state = "QUEUED")))
                await { exists(hasTestTag("landing-ring:still"), unmerged = true) }
                assertTrue(text("landing-head:detail")!!.startsWith("queued · updated"))
                capture("02-landing-queued")

                // ③ Two jobs: the head counts them, and each is a row in its own state.
                integration = line(listOf(job("j-1"), job("j-2", state = "QUEUED", title = "Docs: the landing card")))
                await { text("landing-head:title") == "Landing 2 jobs" }
                assertTrue(exists(hasText("queued") and hasAnyAncestor(hasTestTag("landing-card:job:j-2")), unmerged = true))
                capture("03-landing-two-jobs")

                // ④ Timed out: the whole card amber, a triangle where the ring was, where the runner stopped, and Retry — the server's door.
                integration = line(listOf(job("j-1", timedOut = true)))
                await { exists(hasTestTag("landing-head:timed-out"), unmerged = true) && exists(hasTestTag("landing-card:retry")) }
                assertEquals("Timed out", text("landing-head:right"))
                assertTrue(text("landing-card:detail")!!, text("landing-card:detail")!!.endsWith("stopped at checking · no push recorded"))
                capture("04-landing-timed-out")
                compose.onNodeWithTag("landing-card:retry").performClick()
                await { calls.any { it.startsWith("POST /api/projects/$launch/integration/jobs/j-1/retry") } }
                await { !exists(hasTestTag("landing-head:timed-out"), unmerged = true) }
                capture("05-landing-retried")

                // ⑤ An older server that lists no jobs, its runner silent for 11 minutes: "No report", said once, the clock frozen.
                integration = line(listOf(job("j-1", heartbeat = 660)), listed = false)
                await { text("landing-head:detail") == "No report for 11m" }
                assertEquals("0m 6s", text("landing-head:right"))
                capture("06-landing-no-report")

                // ⑥ Blocked: who is in front of the merge, on the card, in its review and in the conversation's review.
                integration = line(listOf(job("j-sync", state = "QUEUED", title = "Sync the project line with main")), blocking = true)
                promotion = BLOCKED
                // The card can show a moment before the page's next landing read names the new landing: wait for its sentence.
                await { text("project-merge-card:blocked-by") == "Blocked by: $BEHIND" }
                compose.onNodeWithTag("project-merge-card:blocked-by").performScrollTo()
                capture("07-blocked-by-card")
                compose.onNodeWithTag("project-merge-card:details").performScrollTo().performClick()
                await { exists(hasText(BEHIND) and hasAnyAncestor(hasTestTag("project-merge-review:blocked-by")), unmerged = true) }
                capture("08-blocked-by-review")
                compose.onNodeWithTag("project-merge-review:close").performClick(); settle()
                await { !exists(hasTestTag("project-merge-review")) }
                // The landing and merge cards push the coordinator's row below the lazy list's composed rows: scroll the list to it.
                compose.onNodeWithTag("project-sessions-list").performScrollToNode(hasText("Coordinate launch") and hasClickAction())
                compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
                await { exists(hasTestTag("promotion:pr-1:preview"), unmerged = true) }
                compose.onNodeWithTag("promotion:pr-1:preview").performClick()
                await { exists(hasText(BEHIND) and hasAnyAncestor(hasTestTag("promotion:pr-1:blocked-by")), unmerged = true) }
                capture("09-blocked-by-conversation")
                compose.onNodeWithTag("card-review:close").performClick(); settle()

                // ⑦ Aurora's start card: the coordinator's words cut at three lines, so More; the criteria whole, so no Read all; a plan
                // three tasks wide, which the phone cannot draw at 0.7: its levels, and Task graph.
                openStart()
                await { exists(hasTestTag("project-start-request-why")) && exists(hasTestTag("project-start-request-task-graph")) }
                measure("why, long", "project-start-request-why-text")
                criteria.indices.forEach { measure("criterion ${it + 1}", "project-start-request-criterion:$it") }
                assertTrue(layout("project-start-request-why-text").didOverflowHeight)
                assertEquals(StartProjectCopy.more, text("project-start-request-why"))
                assertFalse(exists(hasTestTag("project-start-request-criteria")))
                assertFalse(exists(hasTestTag("project-start-request-plan-graph")))
                capture("10-start-more-no-read-all")
                compose.onNodeWithTag("project-start-request-why").performClick(); settle()
                assertEquals(StartProjectCopy.less, text("project-start-request-why"))
                assertFalse(layout("project-start-request-why-text").didOverflowHeight)
                capture("11-start-why-open")
                compose.onNodeWithTag("project-start-request-task-graph").performScrollTo()
                assertTrue(exists(hasTestTag("project-start-request-level:2")))
                capture("12-start-levels-task-graph")
                compose.onNodeWithTag("project-start-request-task-graph").performClick()
                await { exists(hasTestTag("project-graph-fullscreen")) }
                capture("13-task-graph-fullscreen")
                compose.onNodeWithText("Done").performClick(); settle()
                await { !exists(hasTestTag("project-graph-fullscreen")) }
                // Cancel is at the head of the sheet, scrolled out of view: bring it back first.
                compose.onNodeWithTag("project-start-request-cancel").performScrollTo().performClick(); settle()
                await { !exists(hasTestTag("project-start-request-sheet")) }

                // ⑧ The same card with words that fit — no More — a criterion two lines cut — Read all — and a two-task plan, which the
                // phone draws as the task graph, its head counting tasks only.
                why = SHORT_WHY; criteria = criteria + LONG_CRITERION; plan = NARROW_PLAN
                openStart()
                await { exists(hasTestTag("project-start-request-plan-graph")) && exists(hasTestTag("project-start-request-criteria")) }
                measure("why, short", "project-start-request-why-text")
                criteria.indices.forEach { measure("criterion ${it + 1}", "project-start-request-criterion:$it") }
                assertFalse(layout("project-start-request-why-text").didOverflowHeight)
                assertFalse(exists(hasTestTag("project-start-request-why")))
                assertTrue(layout("project-start-request-criterion:2").didOverflowHeight)
                assertEquals(StartProjectCopy.readAll(3), text("project-start-request-criteria"))
                assertFalse(exists(hasTestTag("project-start-request-task-graph")))
                assertTrue(exists(hasText("PLAN · 2 TASKS") and hasAnyAncestor(hasTestTag("project-start-request-sheet"))))
                compose.onNodeWithTag("project-start-request-criteria").performScrollTo()
                capture("14-start-read-all-no-more")
                compose.onNodeWithTag("project-start-request-plan-graph").performScrollTo()
                capture("15-start-plan-graph")
                // Cancel is at the head of the sheet, scrolled out of view: bring it back first.
                compose.onNodeWithTag("project-start-request-cancel").performScrollTo().performClick(); settle()
                await { !exists(hasTestTag("project-start-request-sheet")) }
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                app.realtime.selectSession(null)
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                File(evidence, "measurements.txt").writeText(measurements.toString())
            }
        }
    }

    // MARK: the fixture

    private fun ago(seconds: Long) = Instant.now().minusSeconds(seconds).toString()
    private fun job(id: String, state: String = "RUNNING", title: String = "Wire the page", timedOut: Boolean = false, heartbeat: Long = 0) =
        Triple(id, state, """{"jobId":"$id","kind":"LAND_TASK","state":"$state","phase":${if (state == "RUNNING") "\"CHECK\"" else "null"},"taskId":"t-$id",
            "taskTitle":"$title","generation":1,"startedAt":"${ago(if (timedOut) 6_630 else 666)}","queuedAt":"${ago(700)}",
            "heartbeatAt":${if (state == "RUNNING") "\"${ago(if (timedOut) 6_620 else heartbeat)}\"" else "null"},"runnerName":"workstation-gpu",
            "timedOut":$timedOut,"limitSeconds":600,"retryable":$timedOut}""")
    /** Launch's integration read: the jobs in flight, their landings on the project branch, and — [blocking] — the reason the lead waits. */
    private fun line(jobs: List<Triple<String, String, String>>, listed: Boolean = true, blocking: Boolean = false): String {
        val lead = Regex("\"(taskTitle|state|startedAt|heartbeatAt|phase)\":(\"[^\"]*\"|null)").findAll(jobs.first().third)
            .associate { it.groupValues[1] to it.groupValues[2] }
        val landTasks = jobs.joinToString(",") { (id, state, json) ->
            val title = Regex("\"taskTitle\":\"([^\"]*)\"").find(json)!!.groupValues[1]
            """{"taskId":"t-$id","taskTitle":"$title","integration":{"state":"PENDING_INTEGRATION","landTask":{"jobId":"$id","state":"$state",
                "phase":null,"targetRef":"refs/heads/project/launch"${if (blocking) ""","blockingReason":{"code":"WAITING_SERIAL_SLOT",
                "summary":"$WAITING"}""" else ""}}}}"""
        }
        return """{"line":"PROJECT_BRANCH","ref":"project/launch","upstreamRef":"main","integratingCount":${jobs.count { it.second == "RUNNING" }},
            "queuedCount":${jobs.count { it.second == "QUEUED" }},"inFlight":{"kind":"LAND_TASK","taskTitle":${lead["taskTitle"]},"state":${lead["state"]},
            "phase":${lead["phase"]},"startedAt":${lead["startedAt"]},"heartbeatAt":${lead["heartbeatAt"]},"waitMs":34000},
            "landTasks":[$landTasks]${if (listed) ""","inFlightJobs":[${jobs.joinToString(",") { it.third }}]""" else ""}}"""
    }
    private fun member(project: String, title: String, role: String) =
        """"projectMembership":{"projectId":"$project","projectTitle":"$title","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, run: String, extra: String, lastTurnAt: String) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"OPEN","agent":{"id":"$alpha","name":"Alpha"},
            "agentId":"$alpha","createdAt":"${ago(36_000)}","lastTurnAt":"$lastTurnAt","pendingApprovals":0,"tags":[],
            "capabilities":{"canComplete":true,"canRestore":false}$extra}"""
    private fun session(id: String) = if (id == coord)
        row(coord, "Coordinate launch", "AWAITING_INPUT", ""","lastAssistantText":"Planning the release","projectId":"$launch",${member(launch, "Launch", "COORDINATOR")}""", ago(1_800))
        else row(worker, "Wire tests", "RUNNING", ""","lastToolUse":"Bash",${member(launch, "Launch", "TASK")}""", ago(120))
    private fun auroraDocument() = """{"id":"$aurora","title":"Aurora","status":"OPEN","goal":"Reminders everywhere.","createdAt":"2026-10-01T00:00:00Z",
        "_count":{"tasks":4},"startedAt":null,"exceptionEscalationSeconds":7200,"acceptanceCriteriaItems":[${criteria.mapIndexed { i, text ->
            """{"id":"c${i + 1}","key":"c${i + 1}","ordinal":${i + 1},"text":"$text","satisfied":false}""" }.joinToString(",")}]}"""
    private fun auroraItems() = """{"needsYou":[],"withCoordinator":[],"startRequest":{"itemId":"start-1","kind":"START_REQUEST","title":"Start this project?",
        "assignee":"OWNER","waitingSince":"${ago(3_360)}","actions":[],"startRequest":{"criteriaDigest":"digest-1","planDigest":"plan-1","why":"$why",
        "settings":{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":"npm test","projectBranchName":"refs/heads/project/aurora"},
        "repository":null,"warnings":[]}}}"""

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a11f-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")?.let { id -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, id) } }
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a11f-fixture-access","refreshToken":"a11f-fixture-refresh","user":{"id":"u1","email":"a11f@example.test","name":"A11f fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a11f@example.test","name":"A11f fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" && project == aurora -> "[]"
                path == "/api/sessions" -> if (view == "open") "[${session(coord)},${session(worker)}]" else "[]"
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(parts[1])
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":1},
                    "taskCounts":{"done":5,"failed":0,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":"2026-10-02T00:00:00Z"},{"id":"$aurora","title":"Aurora","status":"OPEN","createdAt":"2026-10-03T00:00:00Z","buckets":{},
                    "taskCounts":{"done":0,"failed":0,"total":4},"attention":{},"startedAt":null}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z"},
                    {"id":"$aurora","title":"Aurora","status":"OPEN","createdAt":"2026-10-03T00:00:00Z"}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":8},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","integration":{"escalationSeconds":7200},
                    "acceptanceCriteriaItems":[{"id":"c1","key":"c1","ordinal":1,"text":"Notes exist","satisfied":true}]}"""
                parts == listOf("projects", launch, "integration") -> integration
                parts == listOf("projects", launch, "open-items") -> """{"needsYou":[],"withCoordinator":[]}"""
                parts == listOf("projects", launch, "promotions", "current") -> promotion ?: return MockResponse().setResponseCode(200)
                parts == listOf("projects", launch, "promotions", "merged") -> "[]"
                request.method == "POST" && parts.take(4) == listOf("projects", launch, "integration", "jobs") && parts.last() == "retry" -> {
                    integration = line(listOf(job("j-1", state = "QUEUED"))); integration
                }
                parts == listOf("projects", aurora) -> auroraDocument()
                parts == listOf("projects", aurora, "open-items") -> auroraItems()
                parts == listOf("projects", aurora, "dependency-graph") -> plan
                parts == listOf("projects", aurora, "acceptance", "confirmation") ->
                    """{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"digest-1","material":[]}}"""
                parts == listOf("projects", aurora, "integration") -> """{"line":"PROJECT_BRANCH","integratingCount":0,"queuedCount":0,"inFlight":null}"""
                parts == listOf("projects", aurora, "promotions", "current") -> return MockResponse().setResponseCode(200)
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

    // MARK: the journey's hands and eyes

    /** Aurora's sessions page — from the drawer, once Back has returned to a page that offers it — and its coordinator's start card over it. */
    private fun openStart() {
        if (!exists(hasTestTag("project-sessions-review-start"))) {
            repeat(4) { if (!exists(hasContentDescription("Open navigation"))) { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); settle() } }
            compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick(); settle()
            await { exists(drawerRow("Aurora")) }
            compose.onNode(drawerRow("Aurora")).performClick(); settle()
        }
        await { exists(hasTestTag("project-sessions-review-start")) }
        compose.onNodeWithTag("project-sessions-review-start").performClick()
        await { exists(hasTestTag("project-start-request-sheet")) && exists(hasTestTag("project-start-request-confirm")) }
    }
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    /** The drawn text's own layout, read back off its node. */
    private fun layout(tag: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
        return results.single()
    }
    /** One text's layout as the device laid it out: its lines, whether the clamp hid any, and its width against the words' own. */
    private fun measure(what: String, tag: String) {
        val node = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        val layout = layout(tag)
        record(what, "lines=${layout.lineCount} didOverflowHeight=${layout.didOverflowHeight} hasVisualOverflow=${layout.hasVisualOverflow} " +
            "nodeWidthPx=${node.size.width} maxIntrinsicWidthPx=${layout.multiParagraph.intrinsics.maxIntrinsicWidth}")
    }
    private fun record(what: String, line: String) { measurements.append("$what: $line\n") }
    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
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

    private companion object {
        const val WAITING = "Waiting to land: the landing of “Fix the 11 Swift failures” is running on this branch first"
        const val BEHIND = "“Sync the project line with main” is landing on the project line · queued · $WAITING"
        const val BLOCKED = """{"promotionId":"pr-1","state":"BLOCKED","sourceRef":"refs/heads/project/launch","sourceSha":"5e5bfca23aa1",
            "upstreamRef":"refs/heads/main","commitsAhead":7,"filesChanged":10,"taskIds":["t1","t2"],"conflicts":["src/a.go"],"askedAt":null,"merged":null}"""
        const val LONG_WHY = "The plan files four tasks under the three criteria and orders them by what each needs first: the shared contract " +
            "lands before either side builds on it, the server, the web and the Android client then go side by side, and the go-live waits " +
            "for all three. Automatic can stay on, because every landing runs the merge check on the combined tree."
        const val SHORT_WHY = "B, C and D all build on A."
        const val LONG_CRITERION = "Every reminder a person sets on one client fires on every other client they are signed in on, at the " +
            "minute they set, in their own time zone, and is cleared everywhere once it has been seen on any of them."
        const val WIDE_PLAN = """{"marks":[{"kind":"TASK","id":"a","taskId":"a","title":"A · Contract","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true},
            {"kind":"TASK","id":"b","taskId":"b","title":"B · Server","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true},
            {"kind":"TASK","id":"c","taskId":"c","title":"C · Web","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true},
            {"kind":"TASK","id":"d","taskId":"d","title":"D · Android","status":"OPEN","completionCriterion":"OWNER_CONFIRMED","autoRunWhenReady":true}],
            "edges":[{"sourceMarkId":"a","targetMarkId":"b"},{"sourceMarkId":"a","targetMarkId":"c"},{"sourceMarkId":"a","targetMarkId":"d"}],"taskCount":4,"truncated":false}"""
        const val NARROW_PLAN = """{"marks":[{"kind":"TASK","id":"a","taskId":"a","title":"A · Contract","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":true},
            {"kind":"TASK","id":"b","taskId":"b","title":"B · Go-live","status":"OPEN","completionCriterion":"OWNER_CONFIRMED","autoRunWhenReady":true}],
            "edges":[{"sourceMarkId":"a","targetMarkId":"b"}],"taskCount":2,"truncated":false}"""
    }
}
