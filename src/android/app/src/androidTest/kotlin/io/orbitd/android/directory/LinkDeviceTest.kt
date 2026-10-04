package io.orbitd.android.directory

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.realtime.FailureReason
import io.orbitd.android.navigation.ObjectId
import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Cold ACTION_VIEW, saved pending destination, login, and warm ACTION_VIEW through Android. */
@RunWith(AndroidJUnit4::class)
class LinkDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun coldPendingLinkRecreationLoginWarmLinkAndSystemBack() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val coldKind = InstrumentationRegistry.getArguments().getString("a05_cold_kind") ?: "session"
        require(coldKind in setOf("session", "task"))
        val coldTitle = if (coldKind == "task") "Linked task" else "Linked session"
        val app = instrumentation.targetContext.applicationContext as OrbitApplication
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        val evidence = File(app.filesDir, "a05-links").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        fun intent(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        MockWebServer().use { server ->
            val outage = java.util.concurrent.atomic.AtomicBoolean(false)
            val requests = java.util.concurrent.CopyOnWriteArrayList<Pair<String?, String>>()
            val firstId = ObjectId.canonical("34TcwNgAIo6tGUiIKjqnQ")!!
            val secondId = ObjectId.canonical("34Tcl0kralZrY8opuLJU4")!!
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    val token = request.getHeader("Authorization")
                    requests += token to path
                    if (outage.get()) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertTrue(token in listOf("Bearer a05-fixture-access", "Bearer a05-fixture-access-2"))
                    val body = when {
                        path == "/api/auth/login" -> {
                            val suffix = if (request.body.readUtf8().contains("second@example.test")) "-2" else ""
                            """{"accessToken":"a05-fixture-access$suffix","refreshToken":"a05-fixture-refresh$suffix","user":{"id":"link-user$suffix","email":"a05@example.test","name":"Links fixture"}}"""
                        }
                        path.startsWith("/api/tasks/") -> """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked task"}"""
                        path.startsWith("/api/wiki/entries/") -> """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked wiki"}"""
                        path.endsWith("/events/page") -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                        path.endsWith("/events") -> return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": connected\n\n")
                        path.startsWith("/api/sessions/") -> """{"id":"${path.substringAfterLast('/')}","title":"${if (token?.endsWith("-2") == true) "Second session" else "Linked session"}","status":"ENDED","lifecycleState":"OPEN"}"""
                        path == "/api/auth/logout" -> "{}"
                        else -> "[]"
                    }
                    return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                }
            }
            val launchIntent = intent("orbit-$coldKind:34TcwNgAIo6tGUiIKjqnQ")
            ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
                try {
                    compose.onNodeWithText("Email").assertIsDisplayed()
                    scenario.recreate()
                    compose.onNodeWithText("Instance address").performTextReplacement(server.url("/").toString())
                    compose.onNodeWithText("Email").performTextInput("a05@example.test")
                    compose.onNodeWithText("Password").performTextInput("a05-fixture-password")
                    compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
                    compose.waitUntil(10_000) { compose.onAllNodesWithText(coldTitle).fetchSemanticsNodes().isNotEmpty() }
                    compose.onNodeWithText(coldTitle).assertIsDisplayed()
                    if (coldKind == "session") compose.waitUntil(10_000) { app.realtime.state.value.session?.id == firstId }
                    fun back() {
                        var focused = false
                        compose.waitUntil(5_000) {
                            scenario.onActivity { focused = it.window.decorView.hasWindowFocus() }
                            focused
                        }
                        val toolbarBack = compose.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().size
                        val lifecycle = scenario.state
                        scenario.onActivity {
                            val insets = androidx.core.view.ViewCompat.getRootWindowInsets(it.window.decorView)
                            File(evidence, "back-trace.txt").appendText("beforeBack activity=${it.lifecycle.currentState} scenarioMonitor=$lifecycle focus=$focused callbacks=${it.onBackPressedDispatcher.hasEnabledCallbacks()} ime=${insets?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())} toolbarBack=$toolbarBack\n")
                        }
                        compose.waitForIdle()
                        instrumentation.waitForIdleSync()
                        instrumentation.uiAutomation.waitForIdle(500, 5_000)
                        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                        compose.waitForIdle()
                    }
                    compose.onNodeWithContentDescription("Back").assertIsDisplayed()
                    back()
                    compose.onNodeWithText(coldTitle).assertDoesNotExist()
                    compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                    compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
                    app.startActivity(intent("orbit-wiki:34TcwNgAIo6tGUiIKjqnQ"))
                    compose.waitUntil(10_000) { compose.onAllNodesWithText("Linked wiki").fetchSemanticsNodes().isNotEmpty() }
                    val bitmap = instrumentation.uiAutomation.takeScreenshot()
                    File(evidence, "warm-wiki.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    back()
                    compose.onNodeWithText("Linked wiki").assertDoesNotExist()
                    compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                    compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
                    app.startActivity(intent("orbit-session:34TcwNgAIo6tGUiIKjqnQ"))
                    compose.waitUntil(10_000) { app.realtime.state.value.session?.id == firstId }
                    // Hold the UI collector while auth completes: it must handle a direct A → B observation.
                    scenario.onActivity { runBlocking {
                        app.session.login(ServerAddress.parse(server.url("/").toString(), true), "second@example.test", "a05-fixture-password")
                    } }
                    val secondHandle = (app.session.state.value as AuthState.SignedIn).handle
                    compose.waitUntil(10_000) { app.realtime.state.value.handle === secondHandle && app.realtime.state.value.directoryFresh }
                    compose.onNodeWithText("Linked session").assertDoesNotExist()
                    compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                    assertNull(app.realtime.state.value.session)
                    app.startActivity(intent("orbit-session:34Tcl0kralZrY8opuLJU4"))
                    compose.waitUntil(10_000) { app.realtime.state.value.session?.id == secondId && compose.onAllNodesWithText("Second session").fetchSemanticsNodes().isNotEmpty() }
                    assertFalse("Old selection must never issue a request under the new account", requests.any { it.first == "Bearer a05-fixture-access-2" && it.second.contains(firstId) })
                    back()
                    compose.onNodeWithText("Second session").assertDoesNotExist()
                    outage.set(true)
                    compose.onNodeWithContentDescription("Refresh directory").performClick()
                    compose.waitUntil(15_000) { app.realtime.state.value.directoryError?.reason == FailureReason.NETWORK }
                    assertFalse(app.realtime.state.value.directoryFresh)
                    outage.set(false)
                    compose.onNodeWithContentDescription("Refresh directory").performClick()
                    compose.waitUntil(10_000) { app.realtime.state.value.directoryFresh }
                    compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
                    File(evidence, "requests.txt").writeText(requests.joinToString("\n") { (token, path) -> "${if (token?.endsWith("-2") == true) "B" else "A"} $path" })
                    File(evidence, "result.txt").writeText("Cold $coldKind ACTION_VIEW → unsigned recreation → login → $coldTitle → system Back; warm wiki → system Back; rapid A → B resets route/selection and explicit B link wins; socket outage → directory NETWORK/stale → refresh recovery: PASS\nControlled HTTP fixture, not a physical/deployed-account or transport-switch result.\n")
                } catch (failure: Throwable) {
                    val screenshot = instrumentation.uiAutomation.takeScreenshot()
                    File(evidence, "failure.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    screenshot.recycle()
                    File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                    throw failure
                } finally {
                    runBlocking { app.session.logout() }
                    // ActivityScenario only tracks lifecycle events matching its launch intent.
                    // Restore that test monitor identity after all warm-link assertions.
                    if (scenario.state != androidx.lifecycle.Lifecycle.State.DESTROYED) scenario.onActivity { it.intent = launchIntent }
                }
            }
        }
    }
}
