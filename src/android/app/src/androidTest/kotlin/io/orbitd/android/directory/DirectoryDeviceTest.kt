package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Controlled HTTP evidence, not a deployed account or physical-device acceptance.
 * Clicks go through UiAutomation's system input injection, with IME geometry checked first. */
@RunWith(AndroidJUnit4::class)
class DirectoryDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val apiCalls = CopyOnWriteArrayList<String>()
    private val sessionId = "34TcwNgAIo6tGUiIKjqnQ"
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val folderId = "347en66xizlGSG9a6Nej5"
    @Volatile private var completed = false
    @Volatile private var forbiddenDirectory = false

    @Test fun keyboardDirectoryFoldersSearchAndSystemBack() {
        val report = android.os.Bundle().apply { putString("a05_pid", android.os.Process.myPid().toString()) }
        instrumentation.sendStatus(0, report)
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        File(app.filesDir, "a05-directory").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        MockWebServer().use { server ->
            server.dispatcher = fixtureDispatcher()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("a05@example.test")
                compose.onNodeWithText("Password").performTextReplacement("a05-fixture-password")
                tap(compose.onNodeWithText("Password"), requireAboveIme = false)
                awaitIme(true)
                val signIn = compose.onNodeWithText("Sign In")
                signIn.performScrollTo()
                capture("login-ime")
                tap(signIn, requireAboveIme = true)
                compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                compose.onNodeWithTag("workspace:$workspaceId").performClick()
                directoryScrollTo("Research")
                compose.onNodeWithText("Review navigation").assertDoesNotExist() // filed only once, inside its folder
                compose.onNodeWithText("Research").performClick()
                directoryScrollTo("Review navigation")
                capture("folder")
                compose.activityRule.scenario.recreate()
                compose.waitUntil(5_000) { compose.activity.window.decorView.hasWindowFocus() }
                instrumentation.waitForIdleSync()
                instrumentation.uiAutomation.waitForIdle(500, 5_000)
                compose.onNodeWithText("Review navigation").assertIsDisplayed()
                tap(compose.onNode(hasSetTextAction()), false)
                awaitIme(true)
                compose.onNodeWithText("Search sessions").performTextInput("Review")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Same dataset across light and dark").fetchSemanticsNodes().isNotEmpty() }
                val hit = compose.onNodeWithText("Review navigation")
                hit.performScrollTo()
                capture("directory-ime")
                key(KeyEvent.KEYCODE_BACK)
                awaitIme(false)
                compose.onNodeWithText("Review").assertIsDisplayed() // IME Back must keep the folder/search route.
                instrumentation.uiAutomation.waitForIdle(500, 5_000)
                tap(compose.onNode(hasSetTextAction()), false)
                awaitIme(true)
                hit.performScrollTo()
                tap(hit, true)
                compose.waitUntil(10_000) { compose.onAllNodes(hasContentDescription("Session actions") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                awaitIme(false)
                key(KeyEvent.KEYCODE_BACK)
                compose.waitUntil(5_000) { compose.onAllNodesWithText("Review").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Review").assertIsDisplayed() // search and folder source survived
                compose.onNodeWithText("Clear").performClick()
                compose.onNodeWithContentDescription("Options for Review navigation").performScrollTo().performClick()
                compose.onNodeWithText("Complete", useUnmergedTree = true).performScrollTo().performClick()
                compose.waitUntil(10_000) {
                    val live = app.realtime.state.value
                    completed && live.directoryFresh && !live.directoryRefreshing &&
                        live.directory?.sessions?.get("completed")?.any { it["id"]?.jsonPrimitive?.content == sessionId } == true
                }
                // The outcome is the app's toast (A05-4): "Session completed" with Undo, a card under the bar for six seconds.
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("Session completed") and hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isNotEmpty() }
                capture("completed-toast")
                compose.mainClock.advanceTimeBy(6_500)
                compose.waitUntil(10_000) { compose.onAllNodes(hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isEmpty() }
                directoryScrollTo("Completed")
                compose.onNodeWithText("Completed").performClick()
                directoryScrollTo("Review navigation")
                capture("completed")
                key(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithText("Research").assertIsDisplayed()
                val width = compose.activity.window.decorView.width
                val touchY = compose.activity.window.decorView.height * 3 / 4
                val density = compose.activity.resources.displayMetrics.density
                val edge = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)!!.getInsets(WindowInsetsCompat.Type.systemGestures()).left
                val start = maxOf((64 * density).toInt(), edge + (32 * density).toInt())
                val end = width * 9 / 10
                val trace = File(File(app.filesDir, "a05-directory"), "back-trace.txt")
                trace.appendText("drawer-swipe system_edge=$edge from=$start,$touchY to=$end,$touchY\n")
                val downTime = SystemClock.uptimeMillis()
                val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
                // Native MOVE events must allow the Compose test clock to process each frame.
                // A blocking shell swipe leaves that clock paused for the whole gesture.
                for (step in 0..20) {
                    val action = when (step) { 0 -> MotionEvent.ACTION_DOWN; 20 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
                    val coordinates = MotionEvent.PointerCoords().apply {
                        this.x = start + (end - start) * step / 20f
                        y = touchY.toFloat(); pressure = 1f; size = 1f
                    }
                    trace.appendText("drawer-event step=$step x=${coordinates.x} y=${coordinates.y}\n")
                    val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 1, arrayOf(pointer), arrayOf(coordinates),
                        0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                    assertTrue("Drawer event $step must reach the system input dispatcher", instrumentation.uiAutomation.injectInputEvent(event, true))
                    event.recycle()
                    compose.mainClock.advanceTimeByFrame()
                    instrumentation.waitForIdleSync()
                    SystemClock.sleep(20)
                    if (step == 19) {
                        capture("drawer-drag")
                        File(File(app.filesDir, "a05-directory"), "drawer-drag.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
                    }
                }
                compose.waitForIdle()
                instrumentation.uiAutomation.waitForIdle(500, 5_000)
                compose.onNodeWithText("Settings").performScrollTo().assertIsDisplayed()
                capture("drawer-swipe")
                key(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithText("Settings").assertIsNotDisplayed()
                compose.onNodeWithText("Research").assertIsDisplayed()
                compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                compose.onNodeWithContentDescription("Open navigation").performClick()
                compose.onNodeWithText("Settings").performScrollTo().performClick()
                // Settings opens on the account it is signed in as (A13's page has no "Signed in" line).
                compose.onNodeWithText("Directory fixture").assertIsDisplayed()
                compose.onNodeWithText("Build information").performScrollTo().performClick()
                compose.onNodeWithText("Source SHA").performScrollTo().assertIsDisplayed()
                capture("build")
                key(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithText("Directory fixture").assertIsDisplayed()
                compose.onNodeWithContentDescription("Back").assertIsDisplayed()
                key(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithText("Research").assertIsDisplayed()
                assertTrue(apiCalls.contains("POST /api/sessions/$sessionId/complete"))
                assertTrue(apiCalls.any { it.contains("/api/sessions/search?") && it.contains("q=Review") })
                capture("directory")
                forbiddenDirectory = true
                compose.onNodeWithContentDescription("Refresh directory").performClick()
                compose.waitUntil(10_000) { app.realtime.state.value.directoryError?.httpStatus == 403 }
                directoryScrollTo("You don't have permission to load this directory.")
                capture("permission")
                directoryScrollTo("New folder")
                compose.onNode(hasText("New folder") and hasAnyAncestor(hasTestTag("directory-list"))).assertIsNotEnabled()
                forbiddenDirectory = false
                compose.onNodeWithContentDescription("Refresh directory").performClick()
                compose.waitUntil(10_000) { app.realtime.state.value.directoryFresh }
                compose.activityRule.scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                compose.waitUntil(5_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
                instrumentation.uiAutomation.waitForIdle(500, 5_000)
                directoryScrollTo("Research")
                capture("landscape")
                compose.activityRule.scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
                compose.waitUntil(5_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT }
                compose.waitUntil(5_000) { compose.activity.window.decorView.hasWindowFocus() }
                instrumentation.waitForIdleSync()
                instrumentation.uiAutomation.waitForIdle(500, 5_000)
                tap(compose.onNode(hasSetTextAction()), false)
                awaitIme(true)
                compose.onNodeWithText("Search sessions").performTextInput("Review")
                capture("root-ime")
                key(KeyEvent.KEYCODE_BACK)
                awaitIme(false)
                compose.onNodeWithText("Review").assertIsDisplayed()
                compose.onNodeWithContentDescription("Back").assertDoesNotExist()
                capture("root-ime-hidden")
                key(KeyEvent.KEYCODE_BACK)
                val deadline = SystemClock.uptimeMillis() + 5_000
                while (compose.activityRule.scenario.state.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
                assertFalse("Root Back must leave the Activity after the IME was dismissed", compose.activityRule.scenario.state.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))
                File(File(app.filesDir, "a05-directory"), "back-trace.txt").appendText("root-afterBack=${compose.activityRule.scenario.state}\n")
            } catch (failure: Throwable) {
                File(File(app.filesDir, "a05-directory"), "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                app.realtime.selectSession(null)
                File(File(app.filesDir, "a05-directory"), "requests.txt").writeText(apiCalls.joinToString("\n"))
            }
        }
    }

    private fun fixtureDispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            apiCalls += "${request.method} ${request.path}"
            // The login page asks the typed instance what it offers, with no credential; this one predates Google sign-in.
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05-fixture-access", request.getHeader("Authorization"))
            if (path == "/api/workspaces" && forbiddenDirectory) return MockResponse().setResponseCode(403).setBody("{}")
            val session = """{"id":"$sessionId","title":"Review navigation","status":"ENDED","runState":"SUCCEEDED","lifecycleState":"${if (completed) "COMPLETED" else "OPEN"}","agent":{"id":"$workspaceId","name":"Field notes"},"folderId":"$folderId","createdAt":"2026-10-01T08:00:00Z","capabilities":{"canComplete":${!completed},"canRestore":$completed},"tags":[],"pendingApprovals":0,"lastAssistantText":"Same dataset across light and dark"}"""
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"a05-fixture-access","refreshToken":"a05-fixture-refresh","user":{"id":"fixture-user","email":"a05@example.test","name":"Directory fixture"}}"""
                "/api/users/me" -> """{"id":"fixture-user","email":"a05@example.test","name":"Directory fixture"}"""
                // Never reordered: the server sends an explicit null position.
                "/api/workspaces" -> """[{"id":"$workspaceId","name":"Field notes","runnerId":"runner","enabled":true,"position":null}]"""
                "/api/runners" -> """[{"id":"runner","name":"Fixture runner","online":true}]"""
                "/api/session-folders" -> """[{"id":"$folderId","workspaceId":"$workspaceId","name":"Research"}]"""
                "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == if (completed) "completed" else "open") "[$session]" else "[]"
                "/api/sessions/search" -> """{"q":"Review","contentSearched":true,"total":1,"hits":[{"id":"$sessionId","title":"Review navigation","status":"ENDED","agent":{"id":"$workspaceId","name":"Field notes"},"snippet":"Same dataset across light and dark","matchField":"message"}]}"""
                "/api/sessions/$sessionId", "/api/sessions/01a0cca7-8609-70ed-a0e2-d4b55b832b60" -> session
                "/api/sessions/$sessionId/complete" -> { completed = true; "{}" }
                "/api/events" -> return heartbeatStream()
                else -> when {
                    path.endsWith("/events/page") -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                    path.endsWith("/events") -> return heartbeatStream()
                    path.endsWith("/logout") -> "{}"
                    else -> "[]"
                }
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }

    // A finite response repeatedly reconnects and changes the list during visibility assertions.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(120), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    private fun directoryScrollTo(text: String) {
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText(text))
        compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("directory-list"))).assertIsDisplayed()
    }

    private fun awaitIme(visible: Boolean) {
        compose.waitUntil(8_000) {
            ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == visible
        }
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(500, 5_000)
    }
    private fun tap(node: SemanticsNodeInteraction, requireAboveIme: Boolean) {
        compose.waitForIdle()
        node.assertIsDisplayed()
        val bounds = node.fetchSemanticsNode().boundsInWindow
        assertTrue("Touch target must have non-empty visible bounds: $bounds", bounds.width > 0 && bounds.height > 0)
        val location = IntArray(2)
        compose.activity.window.decorView.getLocationOnScreen(location)
        val ime = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)!!
        if (requireAboveIme) {
            assertTrue("IME must really be shown", ime.isVisible(WindowInsetsCompat.Type.ime()))
            val imeTop = compose.activity.window.decorView.height - ime.getInsets(WindowInsetsCompat.Type.ime()).bottom
            assertTrue("Button must be wholly above the keyboard: $bounds / $imeTop", bounds.top >= 0 && bounds.bottom <= imeTop)
            instrumentation.sendStatus(0, android.os.Bundle().apply {
                putString("a05_ime_geometry", "node=$bounds imeTop=$imeTop screenHeight=${compose.activity.window.decorView.height}")
            })
        }
        val touchX = location[0] + bounds.center.x; val touchY = location[1] + bounds.center.y
        val time = SystemClock.uptimeMillis()
        val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coordinates = MotionEvent.PointerCoords().apply { x = touchX; y = touchY; pressure = 1f; size = 1f }
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val event = MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, 1, arrayOf(pointer), arrayOf(coordinates),
                0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
            assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true)); event.recycle()
            if (action == MotionEvent.ACTION_DOWN) SystemClock.sleep(50)
        }
        compose.waitForIdle()
    }
    private fun key(code: Int) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(500, 5_000)
        val state = compose.activityRule.scenario.state
        var detail = "key=$code state=$state"
        if (state != androidx.lifecycle.Lifecycle.State.DESTROYED) compose.activityRule.scenario.onActivity {
            detail += " activity=${it.lifecycle.currentState} focus=${it.window.decorView.hasWindowFocus()} callbacks=${it.onBackPressedDispatcher.hasEnabledCallbacks()} ime=${ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime())}"
        }
        File(File(app.filesDir, "a05-directory"), "back-trace.txt").appendText(detail + "\n")
        if (code == KeyEvent.KEYCODE_BACK) sendBackInput(compose.activity, File(File(app.filesDir, "a05-directory"), "back-trace.txt"))
        else instrumentation.sendKeyDownUpSync(code)
        compose.waitForIdle()
    }
    private fun capture(name: String) {
        val directory = File(app.filesDir, "a05-directory").also { it.mkdirs() }
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
