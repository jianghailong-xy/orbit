package io.orbitd.android.management

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Evidence frames for task 34jpFWQkUfxoS2HX9X7N1 (Android: Remove Default, its removed state and Use again), on the shared emulator
 * through the real product shell over controlled HTTP — a MockWebServer inside the instrumentation, as ManagementDeviceTest — so the
 * server's answers are the ones scripted here ([state]), not a deployed one's. The runner wikova's Codex page: Default's Remove… and the
 * web's question; the removed state with Work and Personal remaining, then Work alone; an added account's question while Default is
 * removed; and Use again bringing Default back. Kept in the evidence directory and compiled into the androidTest APK by kit.gradle;
 * `-e theme dark` takes the dark frames.
 */
@RunWith(AndroidJUnit4::class)
class RemovedDefaultShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("theme") ?: "light"
    private val calls = CopyOnWriteArrayList<String>()
    /** What GET /runners serves for Codex: Default in use beside Work and Personal; removed from Orbit with both remaining; with Work alone. */
    private enum class State { IN_USE, REMOVED_TWO, REMOVED_ONE }
    @Volatile private var state = State.IN_USE
    private val runnerId = "34TcwNgAIo6tGUiIKjqnQ"
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val now get() = Instant.now()

    @Test fun removeDefaultItsRemovedStateAndUseAgain() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "rmd@example.test", "controlled-fixture") }
            compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
            compose.activityRule.scenario.onActivity { activity ->
                val original = activity.intent
                MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                    .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit://runner/${ObjectId.canonical(runnerId)}")).setClass(activity, MainActivity::class.java))
                activity.intent = original
            }
            await("Rotate Token…")
            click(hasText("Codex") and hasClickAction())
            await("Personal")
            // Default offers Remove… while Work and Personal are there, behind the web's question.
            click(hasContentDescription("More for Default"))
            click(hasText("Remove…") and hasClickAction())
            await("Orbit stops using it on wikova.")
            capture("confirm-remove-default")
            press("Remove")
            await("Default · ~/.codex isn’t used by Orbit")
            capture("removed-two")
            // An added account's question while Default is removed: its workspaces run on Automatic.
            click(hasContentDescription("More for Personal"))
            click(hasText("Remove…") and hasClickAction())
            await("Workspaces set to this account run on Automatic.")
            capture("remove-added-while-removed")
            press("Cancel")
            // Personal gone from the machine: Work remains alone, its own row with NEXT, then Default's line.
            state = State.REMOVED_ONE
            compose.waitUntil(30_000) { compose.onAllNodesWithText("Personal").fetchSemanticsNodes().isEmpty() }
            await("NEXT")
            capture("removed-one")
            click(hasText("Use again") and hasClickAction())
            compose.waitUntil(30_000) { compose.onAllNodes(hasContentDescription("More for Default")).fetchSemanticsNodes().isNotEmpty() }
            capture("used-again")
            assertEquals(calls.toString(), 1, calls.count { it.startsWith("DELETE ") && runnersOwn(it.substringAfter(' '), "/accounts/codex/default") })
            assertEquals(calls.toString(), 1, calls.count { it.startsWith("POST ") && runnersOwn(it.substringAfter(' '), "/accounts/codex/default/restore") })
        }
    }

    private fun await(text: String) = compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(10_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    /** A dialog's button, through its semantics: injected touches fail while a dialog settles. */
    private fun press(button: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasText(button) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(button) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        // Semantics can be current a frame before the display is: let the frame reach the screen.
        android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "default-removal").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label-$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    private fun user() = """{"id":"fixture-user","name":"Fixture","email":"rmd@example.test","role":"MEMBER","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}}"""
    private fun window(used: Int) = """{"provider":"codex","primary":{"utilization":$used,"windowDurationMins":300,"resetsAt":"${now.plusSeconds(9000)}"}}"""
    private val default = """{"id":"default","home":"/home/ci/.codex","auth":"yes"}"""
    private val work = """{"id":"3fa91c2e","name":"Work","home":"/home/ci/.orbit/codex-accounts/3fa91c2e","auth":"yes"}"""
    private val personal = """{"id":"7c21de40","name":"Personal","home":"/home/ci/.orbit/codex-accounts/7c21de40","auth":"no"}"""
    /** Codex as the server serves it in each state (usedRunnerEngines): with Default removed, the accounts that remain and the marker,
     * and Default's windows gone from the quota — one remaining account's becoming the snapshot's own. */
    private fun codex() = when (state) {
        State.IN_USE -> """{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[$default,$work,$personal]}"""
        State.REMOVED_TWO -> """{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[$work,$personal],
            "removedDefault":{"home":"/home/ci/.codex","fingerprintPrefix":"cxa1_2b7e9013"}}"""
        State.REMOVED_ONE -> """{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[$work],
            "removedDefault":{"home":"/home/ci/.codex","fingerprintPrefix":"cxa1_2b7e9013"}}"""
    }
    private fun codexUsage() = when (state) {
        State.IN_USE -> """{"provider":"codex","primary":{"utilization":62,"windowDurationMins":300,"resetsAt":"${now.plusSeconds(5400)}"},
            "accounts":{"3fa91c2e":${window(8)},"7c21de40":${window(30)}}}"""
        State.REMOVED_TWO -> """{"provider":"codex","accounts":{"3fa91c2e":${window(8)},"7c21de40":${window(30)}}}"""
        State.REMOVED_ONE -> """{"provider":"codex","primary":{"utilization":8,"windowDurationMins":300,"resetsAt":"${now.plusSeconds(9000)}"},
            "accounts":{"3fa91c2e":${window(8)}}}"""
    }
    private fun runner() = """{"id":"$runnerId","name":"wikova","displayName":"wikova","hostname":"wikova-01","version":"0.1.235","online":true,
        "status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":4,"activeSessions":0,"runsAsRoot":false,"selfUpdate":null,"minFreeDiskMb":null,
        "reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z","capabilities":["codex-account-remove/v1","codex-account-move/v1","os:linux"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes"},${codex()}],
        "planUsage":{"claude":{"fiveHour":{"utilization":14,"resetsAt":"${now.plusSeconds(7200)}"}},"codex":${codexUsage()}},"install":null}"""
    private fun workspace() = """{"id":"$workspaceId","name":"orbit","runnerId":"$runnerId","enabled":true,"workDir":"/home/ci/orbit","lastProvider":"codex",
        "effort":"","modelRouting":false,"env":{},"position":0,"createdAt":"2026-09-01T10:00:00Z"}"""

    /** Whether [path] is this runner's [route], its id spelled either way. */
    private fun runnersOwn(path: String, route: String) = path.startsWith("/api/runners/") && path.endsWith(route) &&
        ObjectId.same(path.removePrefix("/api/runners/").removeSuffix(route), runnerId)

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
            fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            return when {
                path == "/dl/version.json" -> json("""{"version":"0.1.235"}""")
                path == "/api/auth/methods" -> MockResponse().setResponseCode(404)
                path == "/api/auth/login" -> json("""{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}""")
                path == "/api/users/me" -> json(user())
                path == "/api/runners" -> json("[${runner()}]")
                path == "/api/workspaces" -> json("[${workspace()}]")
                // The runner's own routes, by either spelling of its id: the deep link opens it by its UUID.
                runnersOwn(path, "/login") -> json("""{"status":null,"engine":null,"userCode":null,"url":null,"message":null,"account":null}""")
                // Default's removal is Orbit's own record: answered at once, and the runner is then served without it.
                runnersOwn(path, "/accounts/codex/default") && request.method == "DELETE" -> {
                    state = State.REMOVED_TWO
                    json("""{"engine":"codex","account":"default","status":"done","message":null}""")
                }
                runnersOwn(path, "/accounts/codex/default/restore") && request.method == "POST" -> { state = State.IN_USE; json("""{"ok":true}""") }
                path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                request.method == "GET" -> json("[]")
                else -> json("{}")
            }
        }
    }
}
