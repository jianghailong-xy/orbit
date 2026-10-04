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
        val app = instrumentation.targetContext.applicationContext as OrbitApplication
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        val evidence = app.getExternalFilesDir("a05-links")!!.apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        fun intent(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer a05-fixture-access", request.getHeader("Authorization"))
                    val body = when {
                        path == "/api/auth/login" -> """{"accessToken":"a05-fixture-access","refreshToken":"a05-fixture-refresh","user":{"id":"link-user","email":"a05@example.test","name":"Links fixture"}}"""
                        path.startsWith("/api/tasks/") -> """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked task"}"""
                        path.startsWith("/api/wiki/entries/") -> """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked wiki"}"""
                        path == "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": connected\n\n")
                        path == "/api/auth/logout" -> "{}"
                        else -> "[]"
                    }
                    return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                }
            }
            val launchIntent = intent("orbit-task:34TcwNgAIo6tGUiIKjqnQ")
            ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
                try {
                    compose.onNodeWithText("Email").assertIsDisplayed()
                    scenario.recreate()
                    compose.onNodeWithText("Instance address").performTextReplacement(server.url("/").toString())
                    compose.onNodeWithText("Email").performTextInput("a05@example.test")
                    compose.onNodeWithText("Password").performTextInput("a05-fixture-password")
                    compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
                    compose.waitUntil(10_000) { compose.onAllNodesWithText("Linked task").fetchSemanticsNodes().isNotEmpty() }
                    compose.onNodeWithText("Linked task").assertIsDisplayed()
                    fun back() {
                        instrumentation.uiAutomation.waitForIdle(500, 5_000)
                        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                        compose.waitForIdle()
                    }
                    back()
                    compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
                    app.startActivity(intent("orbit-wiki:34TcwNgAIo6tGUiIKjqnQ"))
                    compose.waitUntil(10_000) { compose.onAllNodesWithText("Linked wiki").fetchSemanticsNodes().isNotEmpty() }
                    val bitmap = instrumentation.uiAutomation.takeScreenshot()
                    File(evidence, "warm-wiki.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    back()
                    compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
                    File(evidence, "result.txt").writeText("Cold task ACTION_VIEW → unsigned recreation → authenticated task → system Back; warm wiki ACTION_VIEW → system Back: PASS\nControlled HTTP fixture, not a physical/deployed-account result.\n")
                } finally {
                    runBlocking { app.session.logout() }
                    // ActivityScenario only tracks lifecycle events matching its launch intent.
                    // Restore that test monitor identity after all warm-link assertions.
                    scenario.onActivity { it.intent = launchIntent }
                }
            }
        }
    }
}
