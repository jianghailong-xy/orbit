package io.orbitd.android.tasks

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.core.auth.AuthState
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
 * A-3 on a device, over the test's own controlled HTTP fixture — not a deployment: the task page's Landing section
 * (contract §2.7a; mockups v4 07) in four states — checking, waiting to land, checks failed and landed — the 4 s / 15 s
 * reread while the landing is live and none once it settles, and `Open landing ›` opening the landing session's page.
 * Every step leaves a screenshot in files/al/<theme>, the same quadrant as the board's task-page Landing section.
 */
@RunWith(AndroidJUnit4::class)
class TaskLandingDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("al_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "al/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    /** Every request with its arrival, for the run's record. */
    private val timed = CopyOnWriteArrayList<String>()
    @Volatile private var start = 0L
    /** When each `GET /api/tasks/<id>` was received, in uptime milliseconds: the section's cadence, measured. */
    private val reads = CopyOnWriteArrayList<Long>()
    private val measurements = StringBuilder()
    private val alpha = "34ALWorkspaceAlpha0001"
    private val task = "34ALTaskLanding00001"
    private val landing = "34ALSessionLanding001"
    private val ids = listOf(alpha, task, landing)

    /** The integration row the fixture serves for `/api/tasks/<id>`; the tests set it before opening the page. */
    @Volatile private var integration = ""

    private fun ago(seconds: Long) = Instant.now().minusSeconds(seconds).toString()

    private fun JsonObjectBuilder.str(key: String, value: String?) { put(key, value?.let(::JsonPrimitive) ?: JsonNull) }
    private fun JsonObjectBuilder.num(key: String, value: Long?) { put(key, value?.let { JsonPrimitive(it) } ?: JsonNull) }

    /** A newest LAND_TASK generation, as §2.7a's read model sends it. */
    private fun landTask(state: String = "RUNNING", phase: String? = "CHECK", generation: Int = 3,
        heartbeatAgo: Long = 0, finishedAgo: Long? = null, waitMs: Long = 60_000,
        blockingReason: String? = null, landingSessionId: String? = landing): JsonObject = buildJsonObject {
        put("jobId", "j-1")
        put("state", state)
        str("phase", phase)
        put("generation", "$generation")
        put("queuedAt", ago(420))
        put("startedAt", ago(360))
        put("heartbeatAt", ago(heartbeatAgo))
        str("finishedAt", finishedAgo?.let { ago(it) })
        num("waitMs", waitMs)
        put("targetRef", "refs/heads/project/34a0e97BOc6shsNLJbIuM")
        put("blockingReason", blockingReason?.let { summary ->
            buildJsonObject { put("code", state); put("summary", summary) }
        } ?: JsonNull)
        str("landingSessionId", landingSessionId)
    }

    private fun integration(state: String, landTask: JsonObject) = buildJsonObject {
        put("state", state)
        put("landTask", landTask)
        put("mainBranch", "main")
    }

    private fun setView(state: String = "RUNNING", phase: String? = "CHECK", heartbeatAgo: Long = 0,
        finishedAgo: Long? = null, blockingReason: String? = null, landingSessionId: String? = landing,
        integrationState: String = state) {
        integration = integration(integrationState, landTask(state, phase, heartbeatAgo = heartbeatAgo, finishedAgo = finishedAgo,
            blockingReason = blockingReason, landingSessionId = landingSessionId)).toString()
    }

    @Test fun checkingDrawsTheLandingAndFollowsItEveryFourSeconds() {
        setView("RUNNING", "CHECK")
        journey("checking") {
            openTask()
            awaitLanding()
            assertEquals("Landing", text("task-landing-badge"))
            assertEquals("checking", text("task-landing-step"))
            assertTrue(exists(hasText("generation 3")))
            assertNull("a running attempt has no reason to give", text("task-landing-reason"))
            assertNull(text("task-landing-no-report"))
            for (label in listOf("Target", "Queue wait", "Queued", "Started", "Heartbeat", "Finished")) assertTrue(label, exists(hasText(label)))
            assertTrue(exists(hasText("project/34a0e97BOc6shsNLJbIuM")))
            assertTrue("the way into the landing session", exists(hasTestTag("task-landing-open")))
            record("checking", "badge=${text("task-landing-badge")} | step=${text("task-landing-step")}")
            capture("01-checking")
            tree("01-checking")
            // A landing that RUNS is read again about every 4 s, without any press. Page time is the
            // Compose test clock, which is what the page's coroutine delays run on.
            spendNudge()
            val first = reads.size
            repeat(2) { index ->
                compose.mainClock.advanceTimeBy(4_500)
                await(10_000) { reads.size >= first + index + 1 }
            }
            val count = reads.size - first
            record("running cadence", "$count reads in 9 s of page time; offsets ${offsets()}")
            assertTrue("the running landing is reread every 4 s ($count reads in 9 s of page time)", count >= 2)
        }
    }

    @Test fun waitingToLandSaysWhyAndFollowsItEveryFifteenSeconds() {
        setView("QUEUED", null, blockingReason = "Waiting to land: next for the runner, which claims it on its next heartbeat",
            integrationState = "QUEUED")
        journey("queued") {
            openTask()
            awaitLanding()
            assertEquals("Waiting to land", text("task-landing-badge"))
            assertNull("a queued attempt is on no step", text("task-landing-step"))
            assertEquals("Waiting to land: next for the runner, which claims it on its next heartbeat", text("task-landing-reason"))
            assertTrue(exists(hasText("generation 3")))
            record("queued", "badge=${text("task-landing-badge")} | reason=${text("task-landing-reason")}")
            capture("02-queued")
            tree("02-queued")
            // A queued landing is read on its own 15 s cadence (the unit test holds 15 s against the running 4 s):
            // nothing in the next six seconds of page time, then a read once the quarter minute is up.
            spendNudge()
            val first = reads.size
            compose.mainClock.advanceTimeBy(6_000)
            compose.waitForIdle()
            SystemClock.sleep(600)
            assertEquals("a queued landing is not reread on the 4 s cadence", first, reads.size)
            compose.mainClock.advanceTimeBy(9_500)
            await(10_000) { reads.size > first }
            val afterFirst = reads.size
            // …and the next one is another quarter minute away, not four seconds.
            compose.mainClock.advanceTimeBy(6_000)
            compose.waitForIdle()
            SystemClock.sleep(600)
            assertEquals("the next read is not 4 s away", afterFirst, reads.size)
            compose.mainClock.advanceTimeBy(9_500)
            await(10_000) { reads.size > afterFirst }
            record("queued cadence", "${reads.size - first} reads at quarter-minute steps; offsets ${offsets()}")
            assertTrue("the queued landing is reread every 15 s", reads.size - first >= 2)
        }
    }

    @Test fun checksFailedSaysWhatStoppedItAndThenStopsReading() {
        setView("CHECK_FAILED", "CHECK", heartbeatAgo = 60, integrationState = "CHECK_FAILED",
            blockingReason = "Checks failed on the combined tree: Task acceptance exited 1 (expected 0)")
        journey("check-failed") {
            openTask()
            awaitLanding()
            assertEquals("Landing checks failed", text("task-landing-badge"))
            assertEquals("stopped while checking", text("task-landing-step"))
            assertEquals("Checks failed on the combined tree: Task acceptance exited 1 (expected 0)", text("task-landing-reason"))
            record("checks failed", "badge=${text("task-landing-badge")} | step=${text("task-landing-step")}")
            capture("03-check-failed")
            tree("03-check-failed")
            // A settled landing is read once, not followed.
            spendNudge()
            val count = reads.size
            compose.mainClock.advanceTimeBy(20_000)
            compose.waitForIdle()
            SystemClock.sleep(600)
            assertEquals("a stopped landing is not reread", count, reads.size)
        }
    }

    @Test fun landedSaysLandedAndOffersNoWayInWithoutASession() {
        setView("LANDED", "CHECK", heartbeatAgo = 60, finishedAgo = 30, landingSessionId = null, integrationState = "ON_INTEGRATION_LINE")
        journey("landed") {
            openTask()
            awaitLanding()
            assertEquals("Landed", text("task-landing-badge"))
            assertNull("a landed attempt is on no step", text("task-landing-step"))
            assertNull(text("task-landing-reason"))
            assertNull("a landed attempt needs no receipt sentence", text("task-landing-receipt"))
            assertTrue(exists(hasText("Finished")))
            assertFalse("no session id, no way in", exists(hasTestTag("task-landing-open")))
            record("landed", "badge=${text("task-landing-badge")} | open=${exists(hasTestTag("task-landing-open"))}")
            capture("04-landed")
            tree("04-landed")
            spendNudge()
            val count = reads.size
            compose.mainClock.advanceTimeBy(20_000)
            compose.waitForIdle()
            SystemClock.sleep(600)
            assertEquals("a landed landing is not reread", count, reads.size)
        }
    }

    @Test fun openLandingOpensTheLandingSessionsPage() {
        setView("RUNNING", "CHECK")
        journey("open-landing") {
            openTask()
            awaitLanding()
            assertTrue(exists(hasTestTag("task-landing-open")))
            compose.onNodeWithTag("task-landing-open").performScrollTo().performClick()
            // `SessionDestination` asks the server what the id is before choosing a page; a landing gets its own.
            await { calls.any { it.matches(Regex("GET /api/sessions/[^/?]+")) } }
            await { exists(hasTestTag("landing-page")) }
            // The page's own read draws the header: the destination is a landing page, not the reader.
            await { exists(hasTestTag("landing:title")) }
            record("open landing", "title=${text("landing:title")} | sub=${text("landing:sub")}")
            capture("05-open-landing")
            tree("05-open-landing")
        }
    }

    // MARK: the fixture

    private fun taskDetail() = buildJsonObject {
        put("id", task)
        put("title", "P10 · Wire the landing")
        put("status", "DONE")
        put("createdAt", ago(7_200))
        put("updatedAt", ago(60))
        put("creatorName", "orbit-develop")
        put("autoRunWhenReady", false)
        put("attachments", JsonArray(emptyList()))
        put("sessions", JsonArray(emptyList()))
        put("comments", JsonArray(emptyList()))
        put("dependsOn", JsonArray(emptyList()))
        put("integration", Json.parseToJsonElement(integration))
    }.toString()

    /** The landing session's own read, enough for `SessionDestination` to know it is a landing and for its page to draw. */
    private fun landingDetail() = """{"id":"$landing","title":"Land · P10 · Wire the landing","status":"AWAITING_INPUT",
        "sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":${landingView()}}"""

    private fun landingView(): String {
        val attempt = """{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":3,"phase":"CHECK","round":1,"step":null,"claim":1,
            "runnerName":"wikova","sourceSessionId":"$task","targetRef":"refs/heads/project/34a0e97BOc6shsNLJbIuM",
            "startedAt":"${ago(110)}","heartbeatAt":"${ago(0)}","outputMovedAt":"${ago(6)}","progressProtocol":"v2",
            "check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"},
            "liveness":"LIVE","blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false}"""
        val timeline = """{"sections":[{"title":"Generation 3","jobId":"j-1","kind":"LAND_TASK","generation":3,"state":"RUNNING",
            "entries":[{"kind":"ENQUEUED","at":"${ago(240)}","claim":0,"text":"Task marked done · queued to land"},
                       {"kind":"CLAIMED","at":"${ago(180)}","claim":1,"text":"Claimed by runner wikova · claim 1"}]}],"facts":[]}"""
        return """{"sessionId":"$landing","projectId":"","subject":"TASK","taskId":"$task","promotionId":null,"episode":3,
            "openedAt":"${ago(3600)}","settledAt":null,"checks":[],"currentAttempt":$attempt,"todos":[],"generations":[],"timeline":$timeline}"""
    }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            timed += "${request.method} ${request.path} +${SystemClock.uptimeMillis() - start}ms"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer al-fixture-access", request.getHeader("Authorization"))
            // A link's id arrives canonicalized to its UUID spelling; the fixture's own ids stand for it.
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            if (parts == listOf("tasks", task) && request.method == "GET") reads += SystemClock.uptimeMillis()
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"al-fixture-access","refreshToken":"al-fixture-refresh","user":{"id":"u1","email":"al@example.test","name":"A3 fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"al@example.test","name":"A3 fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" -> "[]"
                path == "/api/events" -> return heartbeatStream()
                parts == listOf("tasks", task) -> taskDetail()
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> landingDetail()
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
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

    private fun identity() {
        fun appBuild(field: String) = Class.forName("io.orbitd.android.BuildConfig", true, app.javaClass.classLoader).getField(field).get(null)
        File(evidence, "identity.txt").writeText("app_sha=${appBuild("SOURCE_SHA")}\napp_dirty=${appBuild("SOURCE_DIRTY")}\n" +
            "test_sha=${BuildConfig.SOURCE_SHA}\ntest_dirty=${BuildConfig.SOURCE_DIRTY}\ntheme=$theme\n" +
            "scope=controlled HTTP fixture (MockWebServer in this test); not a deployed account\n")
    }

    /** One signed-in journey over a fresh controlled fixture; the account is signed out again whatever happens. */
    private fun journey(name: String, block: () -> Unit) {
        try {
            start = SystemClock.uptimeMillis()
            instrumentation.sendStatus(0, android.os.Bundle().apply { putString("al_pid", android.os.Process.myPid().toString()) })
            compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
            assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
            MockWebServer().use { server ->
                server.dispatcher = fixture()
                try {
                    identity()
                    compose.chooseServer(server.url("/").toString())
                    compose.onNodeWithText("Email").performTextReplacement("al@example.test")
                    compose.onNodeWithText("Password").performTextReplacement("al-fixture-password")
                    compose.pressSignIn()
                    compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                    block()
                } finally {
                    runBlocking { app.session.logout() }
                }
            }
            File(evidence, "$name-result.txt").writeText("PASS\n")
        } catch (failure: Throwable) {
            File(evidence, "$name-failure.txt").writeText(failure.stackTraceToString())
            runCatching { capture("$name-failure") }
            throw failure
        } finally {
            File(evidence, "$name-requests.txt").writeText(calls.joinToString("\n"))
            File(evidence, "$name-timeline.txt").writeText(timed.joinToString("\n"))
            File(evidence, "measurements.txt").appendText(measurements.toString())
            calls.clear(); reads.clear(); timed.clear()
        }
    }

    private fun openTask() = compose.activityRule.scenario.onActivity {
        val launchIntent = it.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
            .invoke(it, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("orbit-task:$task"))
                .setClass(it, MainActivity::class.java))
        it.intent = launchIntent
    }

    private fun awaitLanding() {
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("task-detail") and hasScrollAction()).fetchSemanticsNodes().isNotEmpty() }
        await { compose.onAllNodes(hasText("P1", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-landing"))
        await { exists(hasTestTag("task-landing-badge")) }
    }

    /** Runs the link's own one-shot refresh nudge (2 s of page time): the reads after it are the page's. */
    private fun spendNudge() {
        compose.mainClock.advanceTimeBy(2_500)
        compose.waitForIdle()
        SystemClock.sleep(600)
    }
    /** The reads this journey has seen, as milliseconds after the first one. */
    private fun offsets() = reads.joinToString(", ") { "${it - reads.first()}" } + " ms"
    /** The semantics tree as the test saw the state: what the screenshot shows, in words. */
    private fun tree(name: String) {
        runCatching { File(evidence, "$name-tree.txt").writeText(compose.onRoot().printToString(Int.MAX_VALUE)) }
    }
    private fun record(what: String, line: String) { measurements.append("$what: $line\n") }
    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(timeout: Long = 30_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun capture(name: String) {
        compose.waitForIdle()
        SystemClock.sleep(600) // the swiftshader frame lags the UI under load
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
