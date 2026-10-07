package io.orbitd.android.auth

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.me
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.storage.AndroidCredentialStore
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.QueueDispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AuthFlowDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun actualLoginUiHttpRotationAndLogout() {
        reportDeviceProcess()
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(10_000) { session.state.value !is AuthState.Restoring }
        assertTrue("Use a signed-out dedicated debug installation", session.state.value is AuthState.SignedOut)
        MockWebServer().use { server ->
            // The login page also asks the typed instance what it offers; this one predates Google sign-in.
            val queue = QueueDispatcher()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    if (request.path == "/api/auth/methods") MockResponse().setResponseCode(404) else queue.dispatch(request)
            }
            queue.enqueueResponse(MockResponse().setBody(Wire.json.encodeToString(fixtureTokens())))
            queue.enqueueResponse(MockResponse().setResponseCode(401))
            queue.enqueueResponse(MockResponse().setBody(Wire.json.encodeToString(fixtureTokens(1))))
            queue.enqueueResponse(MockResponse().setBody(Wire.json.encodeToString(fixtureTokens().user)))
            queue.enqueueResponse(MockResponse().setBody("{\"success\":true}"))
            compose.onNodeWithText("Instance address").performTextReplacement(server.url("/").toString())
            compose.onNodeWithText("Email").performTextInput("a03@example.test")
            compose.onNodeWithText("Password").performTextInput("a03-device-password")
            compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
            compose.waitUntil(10_000) { session.state.value is AuthState.SignedIn }
            compose.onNodeWithText("Signed in").assertIsDisplayed()
            val handle = (session.state.value as AuthState.SignedIn).handle
            runBlocking {
                session.me(handle)
                assertTrue(AndroidCredentialStore(compose.activity).load()!!.credentials == fixtureTokens(1))
            }
            capture("signed-in.png")
            compose.activityRule.scenario.recreate()
            compose.onNodeWithText("Signed in").assertIsDisplayed()
            compose.onNodeWithText("Sign out").performClick()
            compose.waitUntil(10_000) { session.state.value is AuthState.SignedOut }
            runBlocking { assertNull(AndroidCredentialStore(compose.activity).load()) }
            compose.onNodeWithText("Instance address").assertIsDisplayed()
            compose.onNodeWithText("Signed in").assertDoesNotExist()
            capture("signed-out.png")
            val requests = List(5) { generateSequence { server.takeRequest(5, TimeUnit.SECONDS) }.first { it.path != "/api/auth/methods" } }
            assertEquals(1, requests.count { it.path == "/api/auth/refresh" })
            assertTrue(requests.all { it.getHeader("X-Orbit-Client")?.startsWith("android/") == true })
        }
    }

    private fun capture(name: String) {
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val directory = compose.activity.getExternalFilesDir("a03-auth")!!
        directory.mkdirs()
        File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
