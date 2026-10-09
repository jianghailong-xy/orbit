package io.orbitd.android.auth

import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.storage.AndroidEmailStore
import io.orbitd.android.storage.AndroidInstanceStore
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private const val EMAIL = "a03c@example.test"
private const val PASSWORD = "a03c-device-password"
private const val WRONG_PASSWORD = "a03c-wrong-password"

/**
 * iOS fdeb033ad's login page on a device, run once with the system light and once dark (`-e a03c_phase light|dark`; the
 * script sets the system's night mode before each process). Each run picks a fresh loopback fixture in the Server dialog,
 * is refused once, signs in, signs out, and saves screenshots; the dark run first checks that the light run's sign-in was
 * remembered across processes: its server, and that server's email.
 */
@RunWith(AndroidJUnit4::class)
class LoginPageDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val phase = InstrumentationRegistry.getArguments().getString("a03c_phase", "light")

    @Test fun theLoginPageServerDialogRefusalAndTheRememberedEmail() {
        reportDeviceProcess()
        val app = compose.activity.application as OrbitApplication
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Use a signed-out dedicated debug installation", app.session.state.value is AuthState.SignedOut)
        val night = compose.activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        assertEquals("the system's night mode is this phase's", if (phase == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO, night)
        if (phase == "dark") awaitEmail(EMAIL)
        MockWebServer().use { server ->
            val requests = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
            server.dispatcher = fixture(requests)
            // Loopback HTTP, which only a debug build accepts, as the A03 fixtures do.
            val address = server.url("/").toString()
            val canonical = ServerAddress.parse(address, allowLoopbackHttp = true).value

            // Three taps on the logo, as a person makes them: the Server dialog, on the page's server.
            tapScreen(compose.onNodeWithContentDescription("Orbit"), times = 3)
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Server address").fetchSemanticsNodes().isNotEmpty() }
            capture("server")
            compose.onNodeWithText("Server address").performTextReplacement("http://remote.example")
            compose.onNodeWithText("Save").performClick()
            compose.onNodeWithText("Enter a valid server address.").assertIsDisplayed()
            capture("server-invalid")
            compose.onNodeWithText("Server address").performTextReplacement(address)
            compose.onNodeWithText("Save").performClick()
            // This fixture offers Google, and new accounts through it; it has no email remembered yet.
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Continue with Google").fetchSemanticsNodes().isNotEmpty() }
            awaitEmail("you@example.com")
            awaitIme(false)
            capture("login")

            // Typing: the brand folds into one row above the keyboard.
            tapScreen(compose.onNodeWithText("Email"))
            compose.onNodeWithText("Email").performTextReplacement(EMAIL)
            tapScreen(compose.onNodeWithText("Password"))
            compose.onNodeWithText("Password").performTextReplacement(WRONG_PASSWORD)
            awaitIme(true)
            compose.onNodeWithContentDescription("Orbit").assertWidthIsEqualTo(40.dp)
            capture("typing")

            // A refused password reads as one, and nothing of it is remembered.
            compose.onNodeWithText("Sign In").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Incorrect email or password.").fetchSemanticsNodes().isNotEmpty() }
            val context = compose.activity
            runBlocking {
                assertNotEquals(canonical, AndroidInstanceStore(context).load())
                assertNull(AndroidEmailStore(context).load(canonical))
            }
            awaitIme(false)
            capture("refused")

            // The right password signs in and remembers this server and its email; signing out comes back to both.
            compose.onNodeWithText("Password").performTextReplacement(PASSWORD)
            compose.onNodeWithText("Sign In").performScrollTo().performClick()
            compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn }
            runBlocking {
                assertEquals(canonical, AndroidInstanceStore(context).load())
                assertEquals(EMAIL, AndroidEmailStore(context).load(canonical))
            }
            compose.onNodeWithContentDescription("Open navigation").performClick()
            compose.onNodeWithText("Settings").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Sign out").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Sign out").performScrollTo().performClick()
            compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
            compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
            awaitEmail(EMAIL)
            compose.onNodeWithText("Welcome back").assertIsDisplayed()
            awaitIme(false)
            capture("remembered")

            // The email record is encrypted, and holds no password.
            val record = File(context.noBackupFilesDir, "orbit/emails.bin").readBytes().decodeToString()
            for (secret in listOf(EMAIL, PASSWORD, WRONG_PASSWORD)) assertFalse(secret, record.contains(secret))
            assertTrue(requests.all { it.getHeader("X-Orbit-Client")?.startsWith("android/") == true })
        }
    }

    private fun awaitEmail(shown: String) =
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Email") and hasText(shown)).fetchSemanticsNodes().isNotEmpty() }

    private fun fixture(requests: MutableList<RecordedRequest>) = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            requests += request
            val json = MockResponse().setHeader("Content-Type", "application/json")
            return when (val path = request.requestUrl!!.encodedPath) {
                "/api/auth/methods" -> json.setBody("""{"password":true,"google":true,"googleSignup":true}""")
                "/api/auth/login" -> {
                    val body = request.body.readUtf8()
                    if (PASSWORD in body) json.setBody(Wire.json.encodeToString(TOKENS))
                    else json.setResponseCode(401).setBody("""{"statusCode":401,"message":"Invalid credentials"}""")
                }
                "/api/users/me" -> json.setBody(Wire.json.encodeToString(TOKENS.user))
                "/api/auth/logout" -> json.setBody("""{"success":true}""")
                // Held open, so the signed-in shell does not reconnect in a loop.
                "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(60), 13).throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)
                else -> json.setBody(if (path.endsWith("/events/page")) """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""" else "[]")
            }
        }
    }

    private fun awaitIme(visible: Boolean) {
        compose.waitUntil(8_000) {
            ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == visible
        }
    }

    /** Real touches through the system's input, as the gesture needs: [times] taps at the node's centre. */
    private fun tapScreen(node: SemanticsNodeInteraction, times: Int = 1) {
        compose.waitForIdle()
        val bounds = node.fetchSemanticsNode().boundsInWindow
        val location = IntArray(2)
        compose.activity.window.decorView.getLocationOnScreen(location)
        val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coordinates = MotionEvent.PointerCoords().apply {
            x = location[0] + bounds.center.x; y = location[1] + bounds.center.y; pressure = 1f; size = 1f
        }
        repeat(times) {
            val down = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, arrayOf(pointer), arrayOf(coordinates),
                    0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
                assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true))
                event.recycle()
                if (action == MotionEvent.ACTION_DOWN) SystemClock.sleep(40)
            }
            SystemClock.sleep(80)
        }
        compose.waitForIdle()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        // The emulator's screenshot can lag the UI under load: let the frame settle first.
        SystemClock.sleep(900)
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        val directory = compose.activity.getExternalFilesDir("a03c-login")!!.also { it.mkdirs() }
        File(directory, "$name-$phase.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private companion object {
        val TOKENS = LoginResponse("a03c-device-access", "a03c-device-refresh", User("a03c-fixture-user", EMAIL, "A03c fixture"))
    }
}
