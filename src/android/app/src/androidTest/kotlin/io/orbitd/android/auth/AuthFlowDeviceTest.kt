package io.orbitd.android.auth

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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
            val requests = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
            var rejected = false
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val path = request.requestUrl!!.encodedPath
                    return when (path) {
                        // The login page also asks the typed instance what it offers; this one predates Google sign-in.
                        "/api/auth/methods" -> MockResponse().setResponseCode(404)
                        "/api/auth/login" -> MockResponse().setBody(Wire.json.encodeToString(fixtureTokens()))
                        "/api/auth/refresh" -> MockResponse().setBody(Wire.json.encodeToString(fixtureTokens(1)))
                        "/api/users/me" -> if (!rejected) { rejected = true; MockResponse().setResponseCode(401) }
                            else MockResponse().setBody(Wire.json.encodeToString(fixtureTokens().user))
                        "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": connected\n\n")
                        "/api/auth/logout" -> MockResponse().setBody("{\"success\":true}")
                        else -> MockResponse().setBody("[]")
                    }
                }
            }
            compose.chooseServer(server.url("/").toString())
            compose.onNodeWithText("Email").performTextReplacement("a03@example.test")
            compose.onNodeWithText("Password").performTextReplacement("a03-device-password")
            compose.onNodeWithText("Sign In").performScrollTo().performClick()
            compose.waitUntil(10_000) { session.state.value is AuthState.SignedIn }
            compose.onNodeWithContentDescription("Open navigation").performClick()
            compose.onNodeWithText("Settings").performScrollTo().performClick()
            // Settings opens on the signed-in account (A13's SettingsHome, from users/me).
            awaitAccount()
            val handle = (session.state.value as AuthState.SignedIn).handle
            runBlocking {
                session.me(handle)
                assertTrue(AndroidCredentialStore(compose.activity).load()!!.credentials == fixtureTokens(1))
            }
            capture("signed-in.png")
            compose.activityRule.scenario.recreate()
            awaitAccount()
            compose.onNodeWithText("Sign out").performScrollTo().performClick()
            compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
            compose.waitUntil(10_000) { session.state.value is AuthState.SignedOut }
            runBlocking { assertNull(AndroidCredentialStore(compose.activity).load()) }
            // Back on the login page with the email this server signed in with (A03c), and never the password.
            compose.onNodeWithText("Welcome back").assertIsDisplayed()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Email") and hasText("a03@example.test")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("Edit profile").assertDoesNotExist()
            capture("signed-out.png")
            assertEquals(1, requests.count { it.path == "/api/auth/refresh" })
            assertTrue(requests.all { it.getHeader("X-Orbit-Client")?.startsWith("android/") == true })
        }
    }

    private fun awaitAccount() {
        compose.waitUntil(10_000) { compose.onAllNodesWithText(fixtureTokens().user.email).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Edit profile").assertIsDisplayed()
    }

    private fun capture(name: String) {
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val directory = compose.activity.getExternalFilesDir("a03-auth")!!
        directory.mkdirs()
        File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
