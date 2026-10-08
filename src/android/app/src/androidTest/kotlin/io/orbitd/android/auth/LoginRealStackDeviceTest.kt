package io.orbitd.android.auth

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
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
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.storage.AndroidEmailStore
import io.orbitd.android.storage.AndroidInstanceStore
import java.io.File
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A03c's login page against a real Orbit server: the A11 isolated stack (scripts/a11-stack: its own apiserver and database
 * at a main SHA, on loopback), with a bootstrapped admin and Google sign-in turned on with a placeholder client. Run by
 * tasks-projects-stack-device-test.sh with A11_TEST=io.orbitd.android.auth.LoginRealStackDeviceTest; its arguments
 * (base64): server, ownerEmail, ownerPassword. Screenshots go where that script collects them.
 */
@RunWith(AndroidJUnit4::class)
class LoginRealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = compose.activity.application as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) =
        String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))

    @Test fun theStacksAnswersOnTheLoginPage() {
        instrumentation.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        val server = arg("server")
        val email = arg("ownerEmail")
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=A03c login page on the isolated stack\n")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        val canonical = ServerAddress.parse(server, allowLoopbackHttp = true).value
        val context = compose.activity
        val launchIntent = compose.activity.intent

        // The stack's own auth/methods: Google on, and open to new accounts.
        compose.chooseServer(server)
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Continue with Google").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(text(R.string.google_signup_hint)).assertExists()
        capture("stack-methods")

        // A03-2. An email the server cannot read is its 400, which reads as a wrong email or password (iOS 40a70be24) —
        // before, as a server error.
        signIn("not-an-email", "a03c-any-password")
        awaitText(text(R.string.auth_credentials_error))
        capture("stack-400")
        // A server out of reach (nothing listens on the device's port 9) says so.
        compose.chooseServer("http://127.0.0.1:9")
        signIn(email, "a03c-any-password")
        awaitText(text(R.string.auth_network_error))
        capture("stack-unreachable")
        // The stack's 401 for a wrong password; and none of these attempts is remembered (A03-1).
        compose.chooseServer(server)
        signIn(email, "a03c-wrong-password")
        awaitText(text(R.string.auth_credentials_error))
        runBlocking {
            assertNotEquals(canonical, AndroidInstanceStore(context).load())
            assertNull(AndroidEmailStore(context).load(canonical))
        }
        capture("stack-401")

        // A03-3. The stack's /start, asked with a challenge it cannot take, sends the app back with GOOGLE_BAD_REQUEST, and the
        // page says iOS's sentence for it. The answer comes back through the real redirect activity, as from a browser; the
        // browser itself is left out. A second press while that sign-in is open opens nothing (iOS fbe1c83af).
        var opened = 0
        val auth = ViewModelProvider(compose.activity)[AuthViewModel::class.java]
        instrumentation.runOnMainSync {
            auth.continueWithGoogle(server) { url ->
                opened++
                thread { answer(Regex("code_challenge=[^&]+").replace(url, "code_challenge=not-a-challenge")) }
                true
            }
            auth.continueWithGoogle(server) { opened++; true }
        }
        assertEquals(1, opened)
        awaitText(text(R.string.auth_google_bad_request))
        assertEquals(false, auth.googleBusy.value)
        // MainActivity keeps the newest intent; ActivityScenario follows its activity by the launch intent.
        instrumentation.runOnMainSync { compose.activity.intent = launchIntent }
        capture("stack-google-bad-request")

        // A03-1. The right password signs in; the stack's address and this email are remembered, and signing out comes back
        // to both.
        signIn(email, arg("ownerPassword"))
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn }
        runBlocking {
            assertEquals(canonical, AndroidInstanceStore(context).load())
            assertEquals(email, AndroidEmailStore(context).load(canonical))
        }
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Sign out").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Email") and hasText(email)).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Welcome back").assertIsDisplayed()
        capture("stack-remembered")
    }

    private fun text(id: Int) = compose.activity.getString(id)

    private fun signIn(email: String, password: String) {
        compose.onNodeWithText("Email").performTextReplacement(email)
        compose.onNodeWithText("Password").performTextReplacement(password)
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
    }

    private fun awaitText(text: String) = compose.waitUntil(20_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    /** What the stack answers [url] with, opened as a browser opens it: its redirect, to this app. */
    private fun answer(url: String) {
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build()
        val location = client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            assertEquals(302, response.code)
            requireNotNull(response.header("Location"))
        }
        File(output, "google-start-answer.txt").writeText(location.replace(Regex("state=[^&]+"), "state=<the sign-in's>") + "\n")
        assertTrue(location, location.startsWith("orbit://auth/google?error=GOOGLE_BAD_REQUEST&"))
        app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(location)).addCategory(Intent.CATEGORY_BROWSABLE)
            .setPackage(app.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        // The emulator's screenshot can lag the UI under load: let the frame settle first.
        SystemClock.sleep(900)
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
