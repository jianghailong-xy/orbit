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
import io.orbitd.android.auth.pressSignIn
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
 * A05f on a device, over a controlled HTTP fixture (not a deployment): the drawer's open projects as M2's iOS draws them
 * (`CompactShell.projectRows`, `projectRow`, `projectsRow`). The server lists four open projects newest first; the drawer heads them
 * "Projects" and their number, puts the two waiting on you first, longest wait first, then the most recently active — Launch, whose
 * coordinator's turn is under way in the Open list, before Docs, quiet for two days (`ProjectAttention.drawerProjects`). Launch has
 * nothing waiting and carries the running spinner (`drawerMark`, `coordinatorPulses`), which stops when the drawer closes; the
 * Projects row counts the two projects waiting on you (`needsYouCount`). The theme is the device's (the script runs it light and
 * dark); the screenshots land in files/a05f/<theme>.
 */
@RunWith(AndroidJUnit4::class)
class DrawerProjectsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("a05f_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "a05f/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val alpha = "34A05fWorkspaceAlpha01"
    private val launch = "34A05fProjectLaunch001"; private val review = "34A05fProjectReview001"
    private val release = "34A05fProjectRelease01"; private val docs = "34A05fProjectDocs00001"
    private val coord = "34A05fSessionCoord0001"; private val plain = "34A05fSessionPlain0002"
    private val ids = listOf(alpha, launch, review, release, docs, coord, plain)

    @Test fun theDrawersProjectsAreHeadedOrderedMarkedAndCounted() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a05f_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a05f@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a05f-fixture-password")
                compose.pressSignIn()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                openDrawer()
                await { exists(drawerRow("Docs")) && exists(hasTestTag("drawer-project-running:$launch"), unmerged = true) }
                assertTrue(exists(hasTestTag("drawer-group:Projects") and hasText("Projects") and hasText("4")))
                assertEquals(listOf("Review", "Release", "Launch", "Docs"), projectRows())
                assertTrue(exists(drawerRow("Review") and hasContentDescription("2 waiting for you")))
                assertTrue(exists(drawerRow("Release") and hasContentDescription("1 waiting for you")))
                assertTrue(exists(drawerRow("Launch") and hasContentDescription("Running")))
                assertFalse(exists(hasTestTag("drawer-project-running:$docs"), unmerged = true))
                assertFalse(exists(hasTestTag("drawer-project-needs-you:$docs"), unmerged = true))
                assertTrue(exists(drawerRow("Projects") and hasContentDescription("2 waiting on you")))
                // The spinner in this capture is its first frame: while the test clock advances itself, compose-ui-test holds every
                // infinite animation there ("Infinite animations are disabled on tests").
                capture("01-drawer")

                // Closed, the drawer stays composed: the spinner goes with it, and comes back when it opens again.
                compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                settle()
                await { !exists(hasTestTag("drawer-project-running:$launch"), unmerged = true) }
                assertTrue(exists(hasTestTag("drawer-project-needs-you:$review"), unmerged = true))
                // Opened again on a test clock moved on by hand, the spinner comes up turning, and is captured mid-turn.
                compose.mainClock.autoAdvance = false
                try {
                    compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
                    compose.mainClock.advanceTimeBy(1_500)
                    assertTrue(exists(hasTestTag("drawer-project-running:$launch"), unmerged = true))
                    capture("02-drawer-reopened")
                } finally {
                    compose.mainClock.autoAdvance = true
                }
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun session(id: String, title: String, extra: String, lastTurnAt: String) =
        """{"id":"$id","title":"$title","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN","agent":{"id":"$alpha","name":"Alpha"},
            "agentId":"$alpha","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":0,"tags":[],
            "capabilities":{"canComplete":true,"canRestore":false}$extra}"""
    /** Launch's coordinator, a turn under way: the Open list draws its spinner. */
    private val coordinator get() = session(coord, "Coordinate launch", ""","engineTurnActive":true,"lastAssistantText":"Wiring the page",
        "projectId":"$launch","projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"COORDINATOR"}""", ago(1))
    private val open get() = "[$coordinator,${session(plain, "Plain notes", ""","lastAssistantText":"Notes kept"""", ago(5))}]"
    private fun project(id: String, title: String, created: String, extra: String) =
        """{"id":"$id","title":"$title","status":"OPEN","goal":"Ship it.","createdAt":"$created","_count":{"tasks":2},"integration":null$extra}"""
    /** Newest first, as `GET /projects` answers — the order the drawer does not keep. Launch's own snapshot says its coordinator is
     * idle; the Open list's turn under way outranks it, as on iOS. */
    private val projects get() = listOf(
        project(docs, "Docs", "2026-10-04T00:00:00Z", ""","buckets":{"running":0,"ready":1},"lastActivityAt":"${ago(2 * 24 * 60)}","attention":{"ownerItems":[]}"""),
        project(release, "Release", "2026-10-03T00:00:00Z", ""","buckets":{"running":0,"ready":0},"attention":{"ownerItems":[],"startRequest":{"waitingSince":"${ago(60)}"}}"""),
        project(launch, "Launch", "2026-10-02T00:00:00Z", ""","buckets":{"running":0,"ready":1},"lastActivityAt":"${ago(3 * 24 * 60)}",
            "coordinatorActivity":{"working":false,"lastTurnAt":"${ago(3 * 24 * 60)}"},"attention":{"ownerItems":[]}"""),
        project(review, "Review", "2026-10-01T00:00:00Z", ""","buckets":{"running":0,"ready":0},"lastActivityAt":"${ago(5 * 24 * 60)}",
            "attention":{"ownerItems":[{"kind":"COORDINATOR_QUESTION","count":2,"oldestWaitingSince":"${ago(180)}"}]}"""),
    ).joinToString(",", "[", "]")

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05f-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it, part) } ?: part }
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"a05f-fixture-access","refreshToken":"a05f-fixture-refresh","user":{"id":"u1","email":"a05f@example.test","name":"A05f fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"a05f@example.test","name":"A05f fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/sessions" && request.requestUrl!!.queryParameter("projectId") != null -> if (view == "open") "[$coordinator]" else "[]"
                path == "/api/sessions" -> if (view == "open") open else "[]"
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects" -> projects
                parts[0] == "projects" && parts.size == 2 && parts[1] == "sidebar" -> "[]"
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

    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    /** The drawer's project rows, top to bottom. */
    private fun projectRows() = compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.map { it.text }?.firstOrNull { it in setOf("Launch", "Review", "Release", "Docs") } }
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
