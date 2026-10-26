package io.orbitd.android.push

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Looper
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
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Firebase on the Google APIs emulator image (Google Play services, no Play Store). push-fcm-emulator.sh runs it
 * with the default runner against a release-package APK built with the five public client values, so
 * OrbitApplication's own FirebaseTokenSource asks Google for the token and the SDK calls our service's onNewToken.
 * The fixture only records registrations. Nothing is sent: sending needs the backend's service account. The first
 * method leaves the account signed in for the script's receive-path step; the second signs out.
 */
@RunWith(AndroidJUnit4::class)
class FcmTokenDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a10_server") ?: "http://127.0.0.1:18770"

    @Test fun googleIssuesTheTokenAndARotatedTokenIsRegisteredAgain() {
        assertFalse("Run with the default runner: the real application asks Firebase", app is PushTestApplication)
        assertFalse(BuildConfig.DEBUG)
        assertEquals(BuildConfig.FIREBASE_ANDROID_PACKAGE, app.packageName)
        assertTrue("Firebase client values and Google Play services", app.push.configured)
        shell("mkdir -p $SHOTS")
        instrument.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        http("/__push_reset", "{}")
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a10@example.test")
        compose.onNodeWithText("Password").performTextReplacement("controlled-password")
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        // Waits that need the UI go through the compose rule, which drives recomposition; a plain wait would leave
        // PushNoticeHost's effect, and with it the permission request, unrun (bgj_f5f2ecea7621, bgj_3547f4483992).
        // The configured build asks once after the first sign-in (owner decision 34bbkPvI56b7ZUi8cJjX4).
        var allow: AccessibilityNodeInfo? = null
        instrument.uiAutomation.serviceInfo = instrument.uiAutomation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        pump("system notification permission request", 30_000) { permissionButton()?.also { allow = it } != null }
        capture("fcm-permission-request")
        assertTrue(allow!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        // Google's token comes over the network; the registration carries it to the server.
        pump("registration with Google's token", 90_000) { app.push.registration.activeBinding() != null }
        val first = tokens()
        assertTrue("Every registered token has the FCM shape", first.all { it.getValue("fcmShape").jsonPrimitive.boolean })
        assertEquals("One token before rotation", 1, first.map { it.getValue("sha256") }.toSet().size)
        assertEquals(sha(Tasks.await(FirebaseMessaging.getInstance().token, 60, TimeUnit.SECONDS)),
            first.last().getValue("sha256").jsonPrimitive.content)
        capture("fcm-signed-in")

        // Rotation at Google: the deleted token is gone; asking again issues another, which the SDK hands to onNewToken.
        val before = app.push.registration.activeBinding()!!
        Tasks.await(FirebaseMessaging.getInstance().deleteToken(), 60, TimeUnit.SECONDS)
        val rotated = sha(Tasks.await(FirebaseMessaging.getInstance().token, 60, TimeUnit.SECONDS))
        pump("registration with the rotated token", 60_000) {
            app.push.registration.activeBinding()?.registrationKey.let { it != null && it != before.registrationKey } &&
                tokens().last().getValue("sha256").jsonPrimitive.content == rotated
        }
        val after = tokens()
        assertNotEquals(first.last().getValue("sha256"), after.last().getValue("sha256"))
        assertTrue(after.all { it.getValue("fcmShape").jsonPrimitive.boolean })
    }

    /** A new process restores the binding of the rotated token; sign-out unregisters it before the session ends. */
    @Test fun signOutUnregistersTheRestoredBinding() {
        assertFalse(app is PushTestApplication)
        runBlocking { app.session.restore() } // as the messaging service does in a process without an Activity
        val binding = await("restored binding", 20_000) {
            app.push.registration.activeBinding().takeIf { app.session.state.value is AuthState.SignedIn }
        }
        assertEquals(sha(binding.token), tokens().last().getValue("sha256").jsonPrimitive.content)
        val unregistered = http("/__stats").getValue("push").jsonObject.getValue("unregisterCount").jsonPrimitive.int
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        assertEquals(unregistered + 1, http("/__stats").getValue("push").jsonObject.getValue("unregisterCount").jsonPrimitive.int)
        assertNull(app.push.registration.activeBinding())
    }

    private fun tokens() = http("/__stats").getValue("push").jsonObject.getValue("tokens").jsonArray.map { it.jsonObject }
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

    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.encodeToByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }

    /** For a process without an Activity (no composition to drive). */
    private fun <T : Any> await(what: String, timeoutMillis: Long, value: () -> T?): T {
        val until = SystemClock.elapsedRealtime() + timeoutMillis
        while (true) {
            value()?.let { return it }
            if (SystemClock.elapsedRealtime() >= until) timedOut(what)
            SystemClock.sleep(250)
        }
    }
    /** While MainActivity is up: waiting through the compose rule keeps recomposition and effects running. */
    private fun pump(what: String, timeoutMillis: Long, condition: () -> Boolean) {
        try { compose.waitUntil(timeoutMillis, condition) } catch (_: ComposeTimeoutException) { timedOut(what) }
    }
    private fun timedOut(what: String): Nothing {
        capture("fcm-timeout")
        shell("dumpsys activity activities").decodeToString().lines()
            .filter { "io.orbitd" in it || "ResumedActivity" in it }.forEach { Log.i("A10Fcm", it.trim()) }
        Looper.getMainLooper().thread.stackTrace.forEach { Log.i("A10Fcm", "main at $it") }
        fail("Timed out: $what (auth ${app.session.state.value::class.simpleName}, permitted ${app.push.notifications.permitted()})")
        throw AssertionError(what)
    }

    /** A release package has no run-as, so the shell user writes the screenshots where the host pulls them. */
    private fun capture(label: String) {
        SystemClock.sleep(1_000) // The emulator's software renderer presents frames after the UI state settles.
        shell("screencap -p $SHOTS/$label.png")
    }
    private fun shell(command: String) =
        ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(command)).use { it.readBytes() }

    private companion object { const val SHOTS = "/data/local/tmp/a10-fcm" }
}
