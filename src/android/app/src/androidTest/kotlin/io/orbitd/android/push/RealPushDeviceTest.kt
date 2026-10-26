package io.orbitd.android.push

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A real sign-in for push-fcm-production.sh: the release package signs in to `a10_server` (orbitd.io by default) with
 * the account in a file the script pushes to the device and removes right after, and registers Google's token there.
 * Nothing here sends a message: the script has the server send them. The password reaches only the login form.
 */
@RunWith(AndroidJUnit4::class)
class RealPushDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a10_server") ?: "https://orbitd.io"

    @Test fun signInAndRegister() {
        assertFalse("Run with the default runner: the real application asks Firebase", app is PushTestApplication)
        assertFalse(BuildConfig.DEBUG)
        assertTrue("Firebase client values and Google Play services", app.push.configured)
        // KEY=VALUE lines, optionally quoted; the shell user reads the file the script pushed.
        val login = shell("cat $DIR/login.env").decodeToString().lines().filter { '=' in it }.associate { line ->
            line.substringBefore('=').trim() to line.substringAfter('=').trim().removeSurrounding("'").removeSurrounding("\"")
        }
        val email = login["ORBIT_LOGIN_EMAIL"].orEmpty()
        val password = login["ORBIT_LOGIN_PASSWORD"].orEmpty()
        assertTrue("The login file names ORBIT_LOGIN_EMAIL and ORBIT_LOGIN_PASSWORD", email.isNotBlank() && password.isNotEmpty())
        instrument.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("A fresh installation", app.session.state.value is AuthState.SignedOut)
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement(email)
        compose.onNodeWithText("Password").performTextReplacement(password)
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        // Waits that need the UI go through the compose rule, which drives recomposition (see FcmTokenDeviceTest).
        pump("signed in", 60_000) { app.session.state.value is AuthState.SignedIn }
        var allow: AccessibilityNodeInfo? = null
        instrument.uiAutomation.serviceInfo = instrument.uiAutomation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        pump("system notification permission request", 30_000) { permissionButton()?.also { allow = it } != null }
        capture("real-01-permission-request")
        assertTrue(allow!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        pump("registration with Google's token", 90_000) { app.push.registration.activeBinding() != null }
        val binding = app.push.registration.activeBinding()!!
        Log.i(TAG, "registered server=${binding.server} registrationKey=${binding.registrationKey} tokenSha256=${sha(binding.token)} " +
            "tokenLength=${binding.token.length}")
        capture("real-02-signed-in")
    }

    /** A new process restores the binding; sign-out unregisters it before the session ends. */
    @Test fun signOutAndUnregister() {
        runBlocking { app.session.restore() } // as the messaging service does in a process without an Activity
        val until = SystemClock.elapsedRealtime() + 20_000
        while (app.session.state.value !is AuthState.SignedIn || app.push.registration.activeBinding() == null) {
            if (SystemClock.elapsedRealtime() >= until) fail("No restored binding (auth ${app.session.state.value::class.simpleName})")
            SystemClock.sleep(250)
        }
        val key = app.push.registration.activeBinding()!!.registrationKey
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        assertNull(app.push.registration.activeBinding())
        assertTrue(app.session.state.value is AuthState.SignedOut)
        Log.i(TAG, "signed out; unregistered registrationKey=$key")
    }

    private fun sha(token: String) = MessageDigest.getInstance("SHA-256").digest(token.encodeToByteArray())
        .joinToString("") { "%02x".format(it) }.take(16)

    /** The system dialog is another app's window: read it through the accessibility tree of every window. */
    private fun permissionButton(): AccessibilityNodeInfo? {
        fun find(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
            if (node == null || depth > 30) return null
            if (node.isVisibleToUser && node.viewIdResourceName?.endsWith(":id/permission_allow_button") == true) return node
            for (index in 0 until node.childCount) find(node.getChild(index), depth + 1)?.let { return it }
            return null
        }
        return (instrument.uiAutomation.windows.mapNotNull { it.root } + listOfNotNull(instrument.uiAutomation.rootInActiveWindow))
            .firstNotNullOfOrNull { find(it, 0) }
    }

    private fun pump(what: String, timeoutMillis: Long, condition: () -> Boolean) {
        try { compose.waitUntil(timeoutMillis, condition) } catch (_: ComposeTimeoutException) {
            capture("real-timeout")
            fail("Timed out: $what (auth ${app.session.state.value::class.simpleName}, permitted ${app.push.notifications.permitted()})")
        }
    }

    /** A release package has no run-as, so the shell user writes the screenshots where the script pulls them. */
    private fun capture(label: String) {
        SystemClock.sleep(1_000) // The emulator's software renderer presents frames after the UI state settles.
        shell("screencap -p $DIR/$label.png")
    }
    private fun shell(command: String) =
        ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(command)).use { it.readBytes() }

    private companion object {
        const val DIR = "/data/local/tmp/a10-real"
        const val TAG = "A10Real"
    }
}
