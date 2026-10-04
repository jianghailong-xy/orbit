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
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
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
    private val app get() = compose.activity.application as OrbitApplication
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
        compose.activity.getExternalFilesDir("a05-directory")!!.apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        MockWebServer().use { server ->
            server.dispatcher = fixtureDispatcher()
            try {
                compose.onNodeWithText("Instance address").performTextReplacement(server.url("/").toString())
                compose.onNodeWithText("Email").performTextInput("a05@example.test")
                compose.onNodeWithText("Password").performTextInput("a05-fixture-password")
                tap(compose.onNodeWithText("Password"), requireAboveIme = false)
                awaitIme(true)
                val signIn = compose.onAllNodesWithText("Sign in")[1]
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
                tap(compose.onNodeWithText("Search sessions"), false)
                awaitIme(true)
                compose.onNodeWithText("Search sessions").performTextInput("Review")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Same dataset across light and dark").fetchSemanticsNodes().isNotEmpty() }
                val hit = compose.onNodeWithText("Review navigation")
                hit.performScrollTo()
                capture("directory-ime")
                tap(hit, true)
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Session options").fetchSemanticsNodes().isNotEmpty() }
                awaitIme(false)
                key(KeyEvent.KEYCODE_BACK)
                compose.waitUntil(5_000) { compose.onAllNodesWithText("Review").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Review").assertIsDisplayed() // search and folder source survived
                compose.onNodeWithText("Clear").performClick()
                compose.onNodeWithContentDescription("Options for Review navigation").performScrollTo().performClick()
                compose.onNodeWithText("Complete", useUnmergedTree = true).performScrollTo().performClick()
                compose.waitUntil(10_000) { completed && !app.realtime.state.value.directoryRefreshing }
                directoryScrollTo("Completed")
                compose.onNodeWithText("Completed").performClick()
                directoryScrollTo("Review navigation")
                capture("completed")
                key(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithText("Research").assertIsDisplayed()
                compose.onNodeWithContentDescription("Open navigation").performClick()
                compose.onNodeWithText("Settings").performScrollTo().performClick()
                compose.onNodeWithText("Signed in").assertIsDisplayed()
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
            } catch (failure: Throwable) {
                capture("failure")
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                app.realtime.selectSession(null)
                File(compose.activity.getExternalFilesDir("a05-directory"), "requests.txt").writeText(apiCalls.joinToString("\n"))
            }
        }
    }

    private fun fixtureDispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            apiCalls += "${request.method} ${request.path}"
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05-fixture-access", request.getHeader("Authorization"))
            if (path == "/api/workspaces" && forbiddenDirectory) return MockResponse().setResponseCode(403).setBody("{}")
            val session = """{"id":"$sessionId","title":"Review navigation","status":"ENDED","runState":"SUCCEEDED","lifecycleState":"${if (completed) "COMPLETED" else "OPEN"}","agent":{"id":"$workspaceId","name":"Field notes"},"folderId":"$folderId","createdAt":"2026-10-01T08:00:00Z","capabilities":{"canComplete":${!completed},"canRestore":$completed},"tags":[],"pendingApprovals":0,"lastAssistantText":"Same dataset across light and dark"}"""
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"a05-fixture-access","refreshToken":"a05-fixture-refresh","user":{"id":"fixture-user","email":"a05@example.test","name":"Directory fixture"}}"""
                "/api/users/me" -> """{"id":"fixture-user","email":"a05@example.test","name":"Directory fixture"}"""
                "/api/workspaces" -> """[{"id":"$workspaceId","name":"Field notes","runnerId":"runner","enabled":true}]"""
                "/api/runners" -> """[{"id":"runner","name":"Fixture runner","online":true}]"""
                "/api/session-folders" -> """[{"id":"$folderId","workspaceId":"$workspaceId","name":"Research"}]"""
                "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == if (completed) "completed" else "open") "[$session]" else "[]"
                "/api/sessions/search" -> """{"q":"Review","contentSearched":true,"total":1,"hits":[{"id":"$sessionId","title":"Review navigation","status":"ENDED","agent":{"id":"$workspaceId","name":"Field notes"},"snippet":"Same dataset across light and dark","matchField":"message"}]}"""
                "/api/sessions/$sessionId", "/api/sessions/01a0cca7-8609-70ed-a0e2-d4b55b832b60" -> session
                "/api/sessions/$sessionId/complete" -> { completed = true; "{}" }
                "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": connected\n\n").setSocketPolicy(SocketPolicy.KEEP_OPEN)
                else -> when {
                    path.endsWith("/events/page") -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                    path.endsWith("/events") -> return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": connected\n\n")
                    path.endsWith("/logout") -> "{}"
                    else -> "[]"
                }
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }

    private fun directoryScrollTo(text: String) {
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText(text))
        compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("directory-list"))).assertIsDisplayed()
    }

    private fun awaitIme(visible: Boolean) = compose.waitUntil(8_000) {
        ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == visible
    }
    private fun tap(node: SemanticsNodeInteraction, requireAboveIme: Boolean) {
        val bounds = node.fetchSemanticsNode().boundsInWindow
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
        val x = location[0] + bounds.center.x; val y = location[1] + bounds.center.y
        val time = SystemClock.uptimeMillis()
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val event = MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, x, y, 0)
            assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true)); event.recycle()
        }
        compose.waitForIdle()
    }
    private fun key(code: Int) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(500, 5_000)
        instrumentation.sendKeyDownUpSync(code)
        compose.waitForIdle()
    }
    private fun capture(name: String) {
        val directory = compose.activity.getExternalFilesDir("a05-directory")!!.also { it.mkdirs() }
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
