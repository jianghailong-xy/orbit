package io.orbitd.android.reader

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
 * A-1 on a device, over the test's own controlled HTTP fixture — not a deployment: a link opens a landing session's page
 * (contract §2.9 LS1/LS6; mockups v4 07) — the status card, the server's timeline and the read-only footer, with no
 * composer and no session menu — the page follows the server from checking to timed out, Retry is pressed once and Abandon
 * once, and the fixture's requests show the two routes the page sent. Every step leaves a screenshot in files/a1/<theme>.
 */
@RunWith(AndroidJUnit4::class)
class LandingSessionDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a1_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a1/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A1WorkspaceAlpha0001"
    private val launch = "34A1ProjectLaunch00001"
    private val landing = "34A1SessionLanding0001"
    private val coord = "34A1SessionCoord00001"
    private val ids = listOf(alpha, launch, landing, coord)

    /** The landing view the fixture serves; the journey moves it from checking to timed out and back. */
    @Volatile private var landingView = ""
    @Volatile private var landingLog = """{"jobId":"j-1","entries":[{"claim":1,"round":1,"seq":0,"text":"▶ projects/project-integration-line.spec.ts\n","truncatedBytes":0}],"nextCursor":null}"""

    @Test fun theLandingPageOpensFromALinkAndItsTwoDoorsEachSendTheirRequest() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a1_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        fun appBuild(field: String) = Class.forName("io.orbitd.android.BuildConfig", true, app.javaClass.classLoader).getField(field).get(null)
        File(evidence, "identity.txt").writeText("app_sha=${appBuild("SOURCE_SHA")}\napp_dirty=${appBuild("SOURCE_DIRTY")}\n" +
            "test_sha=${BuildConfig.SOURCE_SHA}\ntest_dirty=${BuildConfig.SOURCE_DIRTY}\ntheme=$theme\n" +
            "scope=controlled HTTP fixture (MockWebServer in this test); not a deployed account\n")
        landingView = view(state = "RUNNING", liveness = "LIVE")
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a1@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a1-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                // The link, as Android delivers one to the running Activity.
                compose.activityRule.scenario.onActivity {
                    val launchIntent = it.intent
                    MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                        .invoke(it, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("orbit-session:$landing"))
                            .setClass(it, MainActivity::class.java))
                    it.intent = launchIntent
                }

                // ① Checking: the landing page, not the reader — no composer, no session menu, no event stream.
                await { exists(hasTestTag("landing-page")) }
                await { text("landing-head:right")?.matches(Regex("1m 5\\ds? of 60m")) == true }
                assertEquals("Land · Wire the page", text("landing:title"))
                assertEquals("Run by Orbit · runner wikova", text("landing:sub"))
                assertTrue(text("landing:budget")!!.startsWith("Task acceptance "))
                assertTrue(text("landing:live")!!.startsWith("Output "))
                assertFalse(exists(hasTestTag("transcript-list")))
                assertFalse(exists(hasContentDescription("Session actions")))
                assertTrue("the landing is never subscribed to its events",
                    calls.none { it.startsWith("GET /api/sessions/$landing/events") })
                record("checking", "head=${text("landing-head:right")} | ${text("landing-head:detail")}")
                capture("01-checking")

                // ② The server judges the claim timed out: the page follows its poll into the amber card (J12's sentence, Retry, Abandon).
                landingView = view(state = "RUNNING", liveness = "LEASE_EXPIRED", timedOut = true, retryable = true, step = 1380, heartbeat = 1380)
                await { exists(hasTestTag("landing:retry")) && exists(hasTestTag("landing:abandon")) }
                assertEquals("No report for 23m · limit 10m", text("landing-head:detail"))
                assertEquals("Nothing was pushed — the runner reports before it pushes, and it never did.", text("landing:push-sentence"))
                record("timed out", "head=${text("landing-head:right")} | ${text("landing-head:detail")}")
                capture("02-timed-out")

                // ③ Retry: J-T9's door. The press is the server's route, and the answer moves the card back to queued.
                compose.onNodeWithTag("landing:retry").performClick()
                await { calls.any { it.startsWith("POST /api/projects/$launch/integration/jobs/j-1/retry") } }
                landingView = view(state = "QUEUED", liveness = null, claim = 0)
                try { await { !exists(hasTestTag("landing:retry")) && text("landing-head:title") == "Landing" } }
                catch (failure: Throwable) {
                    File(evidence, "retry-wait-tree.txt").writeText(runCatching { compose.onRoot().printToString() }.getOrDefault(""))
                    throw failure
                }
                record("retried", "head=${text("landing-head:right")} | ${text("landing-head:detail")}")
                capture("03-retried")

                // ④ Abandon: J-T10's door on a claim the server judged silent again. Its request carries no body.
                landingView = view(state = "RUNNING", liveness = "LEASE_EXPIRED", timedOut = true, retryable = true, step = 1380, heartbeat = 1380)
                await { exists(hasTestTag("landing:abandon")) }
                compose.onNodeWithTag("landing:abandon").performClick()
                await { calls.any { it.startsWith("POST /api/projects/$launch/integration/jobs/j-1/abandon") } }
                capture("04-abandoned")

                // ⑤ The ⋮ menu over the card: the ways to look at the work and the doors, and no Copy Link.
                landingView = view(state = "RUNNING", liveness = "LIVE")
                await { text("landing-head:right")?.matches(Regex("1m 5\\ds? of 60m")) == true }
                await { exists(hasTestTag("landing-more")) }
                compose.onNodeWithTag("landing-more").performClick()
                await { compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
                val menu = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
                    .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
                assertEquals(listOf("Open task", "Open source session", "Open coordinator", "Stop landing"), menu)
                assertFalse(menu.contains("Copy Link"))
                capture("05-menu")
                compose.onNode(hasText("Open task") and hasAnyAncestor(isPopup())).performClick()
                await { calls.any { it.startsWith("GET /api/tasks/t-landing") } }
                capture("06-open-task")
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
    private fun view(kind: String = "LAND_TASK", subject: String = "TASK", taskId: String? = "t-landing", state: String = "RUNNING",
        liveness: String? = "LIVE", timedOut: Boolean = false, retryable: Boolean = false, claim: Int = 1, step: Long = 110,
        heartbeat: Long = 0, promotionId: String? = null): String {
        val attempt = """{"jobId":"j-1","kind":"$kind","state":"$state","generation":1,
            "phase":${if (state == "RUNNING") "\"CHECK\"" else "null"},"round":${if (claim > 0) 1 else "null"},"step":null,"claim":$claim,
            "runnerName":"wikova","sourceSessionId":"$landing","targetRef":"refs/heads/project/launch","startedAt":"${ago(step)}",
            "heartbeatAt":"${ago(heartbeat)}","outputMovedAt":"${ago(6)}","progressProtocol":"v2",
            "check":${if (state == "RUNNING") """{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(step)}"}""" else "null"},
            "liveness":${liveness?.let { "\"$it\"" } ?: "null"},"blockingReason":null,"timedOut":$timedOut,"limitSeconds":600,
            "retryable":$retryable,"pushBoundaryPassed":false}"""
        val timeline = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"$kind","generation":1,"state":"$state",
            "entries":[{"kind":"ENQUEUED","at":"${ago(240)}","claim":0,"text":"Task marked done · queued to land"},
                       {"kind":"CLAIMED","at":"${ago(180)}","claim":1,"text":"Claimed by runner wikova · claim 1"}]}],"facts":[]}"""
        return """{"sessionId":"$landing","projectId":"$launch","subject":"$subject","taskId":${taskId?.let { "\"$it\"" } ?: "null"},
            "promotionId":${promotionId?.let { "\"$it\"" } ?: "null"},"episode":4,"openedAt":"${ago(3600)}","settledAt":null,
            "checks":[],"currentAttempt":$attempt,"todos":[],"generations":[],"timeline":$timeline}"""
    }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a1-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a1-fixture-access","refreshToken":"a1-fixture-refresh","user":{"id":"u1","email":"a1@example.test","name":"A1 fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a1@example.test","name":"A1 fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == "open") "[]" else "[]"
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> landingDetail()
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                parts[0] == "sessions" && parts.size > 3 && parts.last() == "log" -> landingLog
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{},
                    "taskCounts":{"done":1,"failed":0,"total":1},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
                    "startedAt":"2026-10-02T00:00:00Z"}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z"}]"""
                parts == listOf("projects", launch) -> """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
                    "_count":{"tasks":1},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord"}"""
                parts == listOf("projects", launch, "integration") -> """{"line":"PROJECT_BRANCH","ref":"project/launch","upstreamRef":"main",
                    "integratingCount":1,"queuedCount":0,"inFlight":{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","startedAt":"${ago(110)}",
                    "heartbeatAt":"${ago(0)}"},"inFlightJobs":[{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK",
                    "startedAt":"${ago(110)}","heartbeatAt":"${ago(0)}","stepStartedAt":"${ago(110)}","typicalMs":null,
                    "landingSessionId":"$landing","retryable":false}]}"""
                parts == listOf("projects", launch, "coordinator", "status") -> """{"state":"LIVE","coordination":{"session":{"id":"$coord"}}}"""
                parts == listOf("projects", launch, "promotions", "current") -> return MockResponse().setResponseCode(200)
                parts == listOf("projects", launch, "open-items") -> """{"needsYou":[],"withCoordinator":[]}"""
                parts == listOf("tasks", "t-landing") -> """{"id":"t-landing","title":"Wire the page","status":"DONE"}"""
                request.method == "POST" && parts.take(4) == listOf("projects", launch, "integration", "jobs") -> "{}"
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

    private fun landingDetail() = """{"id":"$landing","title":"Land · Wire the page","status":"AWAITING_INPUT","sessionKind":"LANDING",
        "workspace":null,"assignedRunner":null,"tags":[],"landing":$landingView}"""

    // A finite response reconnects and re-reads the lists while the journey looks at them: hold it open.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    // MARK: the journey's hands and eyes

    private val measurements = StringBuilder()
    private fun record(what: String, line: String) { measurements.append("$what: $line\n") }
    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
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
