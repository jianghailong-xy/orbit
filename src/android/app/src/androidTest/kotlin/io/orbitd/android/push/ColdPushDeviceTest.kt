package io.orbitd.android.push

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith

/** Separate processes against the persistent push-cold-fixture.py (host owns ui.lock, the fixture and
 * its adb reverse). The host selects one method per process: prepare, force-stop, restoreAndApprove,
 * then signedOutColdLinkOpensAfterLogin; trayLogin precedes the host's cold tray tap (ColdTrayEntryTest);
 * permissionPrompt runs after the host revokes the permission and resets push storage.
 * Controlled transport and token source only: never FCM delivery evidence. */
@RunWith(AndroidJUnit4::class)
class ColdPushDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val name = TestName()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a10_server") ?: "http://127.0.0.1:18770"
    private val output get() = File(app.filesDir, "a10-push").apply { mkdirs() }
    private val sessionId = "34ZaIKKTQq8IdW0pn90xH"
    private val activities = CopyOnWriteArrayList<MainActivity>()
    @Volatile private var resumed: Activity? = null
    private val started = CopyOnWriteArrayList<Activity>()
    private var signOutAfter = false
    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, state: Bundle?) { if (activity is MainActivity) activities.addIfAbsent(activity) }
        override fun onActivityResumed(activity: Activity) { resumed = activity }
        override fun onActivityPaused(activity: Activity) { if (resumed === activity) resumed = null }
        override fun onActivityDestroyed(activity: Activity) { activities.remove(activity); started.remove(activity) }
        override fun onActivityStarted(activity: Activity) { started.addIfAbsent(activity) }
        override fun onActivityStopped(activity: Activity) { started.remove(activity) }
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
    }

    @Before fun observe() {
        check(app is PushTestApplication) { "Use PushTestRunner" }
        instrument.runOnMainSync { app.registerActivityLifecycleCallbacks(lifecycle) }
        instrument.sendStatus(0, Bundle().apply { putString("a10_pid", Process.myPid().toString()) })
    }

    @After fun close() {
        try { if (signOutAfter) runBlocking { app.push.beforeSignOut(); app.session.logout() } }
        finally {
            instrument.runOnMainSync { activities.forEach { it.finish() } }
            await("activities finished") { activities.isEmpty() }
            instrument.runOnMainSync { app.unregisterActivityLifecycleCallbacks(lifecycle) }
        }
    }

    @Test fun prepare() = seed("cold-seed.json")

    /** Signs in and stays signed in for the host's cold tray tap (ColdTrayEntryTest posts the entry). */
    @Test fun trayLogin() {
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin()
    }

    @Test fun restoreAndApprove() {
        signOutAfter = true
        val seed = Wire.json.parseToJsonElement(File(output, "cold-seed.json").readText()).jsonObject
        assertNotEquals("The host must terminate the seed process", seed.getValue("pid").jsonPrimitive.int, Process.myPid())
        assertEquals(BuildConfig.SOURCE_SHA, seed.getValue("sha").jsonPrimitive.content)
        assertTrue("No Activity may exist before the notification route", activities.isEmpty())
        // The exact ACTION_VIEW the tray PendingIntent carries, as this new process's first Activity.
        launch(Intent(Intent.ACTION_VIEW, Uri.parse(seed.getValue("link").jsonPrimitive.content), app, MainActivity::class.java))
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.push.registration.activeBinding() != null }
        awaitCard()
        assertTrue(ObjectId.same(sessionId, app.realtime.state.value.session?.id))
        assertEquals(seed.getValue("registrationKey").jsonPrimitive.content, app.push.registration.activeBinding()!!.registrationKey)
        val restored = http("/__stats").getValue("push").jsonObject
        assertEquals(seed.getValue("installationId"), restored["installationId"])
        assertEquals("Process restoration must not rotate the binding", 1, restored.getValue("registerCount").jsonPrimitive.int)
        val data = seed.getValue("message").jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertTrue("Event history must survive process death", app.push.notifications.hasSeen(PushMessage.parse(data)!!))
        capture("cold-actionable-card")
        approve()
        File(output, "cold-restore-result.txt").writeText("PASS\npid=${Process.myPid()}\nsha=${BuildConfig.SOURCE_SHA}\n" +
            "New process; first Activity is the notification ACTION_VIEW; encrypted auth, binding and event history restored; " +
            "real card and HTTP approval. Controlled fixture, not FCM.\n")
        capture("cold-approval-recorded")
    }

    /** After restoreAndApprove signed out: the notification route reaches a new, signed-out process,
     * survives the login screen and opens once authentication succeeds. */
    @Test fun signedOutColdLinkOpensAfterLogin() {
        signOutAfter = true
        val seed = Wire.json.parseToJsonElement(File(output, "cold-seed.json").readText()).jsonObject
        assertTrue("No Activity may exist before the notification route", activities.isEmpty())
        launch(Intent(Intent.ACTION_VIEW, Uri.parse(seed.getValue("link").jsonPrimitive.content), app, MainActivity::class.java))
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedOut }
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Welcome back").fetchSemanticsNodes().isNotEmpty() }
        assertNull(app.realtime.state.value.session)
        capture("cold-signed-out-login")
        resetAndLogin()
        awaitCard()
        assertTrue(ObjectId.same(sessionId, app.realtime.state.value.session?.id))
        File(output, "signed-out-cold-result.txt").writeText("PASS\npid=${Process.myPid()}\n" +
            "New signed-out process received the notification ACTION_VIEW, showed login, then opened the session card.\n")
        capture("cold-login-then-session")
    }

    /** Host: pm revoke + clear user-set/user-fixed flags + remove no_backup/push before this process. */
    @Test fun permissionPrompt() {
        signOutAfter = true
        assertTrue("Android 13+ only", Build.VERSION.SDK_INT >= 33)
        assertEquals(PackageManager.PERMISSION_DENIED, app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin()
        val deny = awaitPermissionButton()
        capture("permission-prompt-after-sign-in")
        assertTrue("Deny must be a real click on the system dialog", deny.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        await("dialog dismissed") { resumed is MainActivity }
        assertEquals(PackageManager.PERMISSION_DENIED, app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        assertFalse("Asked once per installation", app.push.claimPermissionPrompt())
        capture("permission-denied-app-usable")

        open("orbit-session:$sessionId")
        awaitCard()
        home()
        assertFalse(app.push.notifications.allowed())
        runBlocking { app.push.receive(alert("A10 denied approval")) }
        assertTrue("Nothing can be shown without the permission", app.push.notifications.active().isEmpty())
        launch(Intent(Intent.ACTION_MAIN, null, app, MainActivity::class.java).addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        awaitCard()
        approve()

        // A second sign-in on this installation must not ask again.
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        resetAndLogin()
        SystemClock.sleep(3_000)
        assertNull("No second system request", findPermissionButton())
        assertTrue(resumed is MainActivity)
        File(output, "permission-prompt-result.txt").writeText("PASS\npid=${Process.myPid()}\napi=${Build.VERSION.SDK_INT}\n" +
            "First signed-in foreground showed the system POST_NOTIFICATIONS request; Don't allow was clicked; no background " +
            "notification; real SessionReader approval succeeded over controlled HTTP; second sign-in did not ask again.\n")
        capture("permission-second-sign-in")
    }

    /** Host: pm clear, a regular file where the push directory goes, permission revoked with its flags
     * cleared. Nothing in push storage can be written; asking must neither crash nor block the app. */
    @Test fun permissionPromptSurvivesUnwritablePushStorage() {
        signOutAfter = true
        assertTrue("Android 13+ only", Build.VERSION.SDK_INT >= 33)
        assertTrue("Host must block the push directory", File(app.noBackupFilesDir, "push").isFile)
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin(binding = false)
        val deny = awaitPermissionButton()
        capture("unwritable-storage-permission-request")
        assertTrue(deny.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        await("dialog dismissed") { resumed is MainActivity }
        SystemClock.sleep(2_000) // The answer's write fails off the main thread; the process must stay up.
        assertTrue(resumed is MainActivity)
        assertFalse("Asked once in this process", app.push.claimPermissionPrompt())
        assertTrue(File(app.noBackupFilesDir, "push").isFile)
        File(output, "unwritable-storage-result.txt").writeText("PASS\npid=${Process.myPid()}\n" +
            "Push storage unwritable: sign-in showed the system request, Don't allow was clicked, the app stayed up.\n")
        capture("unwritable-storage-app-alive")
    }

    private fun seed(file: String) {
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin()
        home()
        val data = alert("A10 cold approval")
        runBlocking { app.push.receive(data) }
        await("tray entry") { app.push.notifications.active().size == 1 }
        val stats = http("/__stats")
        val push = stats.getValue("push").jsonObject
        assertEquals(1, push.getValue("registerCount").jsonPrimitive.int)
        File(output, file).writeText(buildJsonObject {
            put("pid", Process.myPid()); put("sha", BuildConfig.SOURCE_SHA); put("dirty", BuildConfig.SOURCE_DIRTY)
            put("registrationKey", app.push.registration.activeBinding()!!.registrationKey)
            put("installationId", push.getValue("installationId"))
            put("link", PushMessage.parse(data)!!.link!!)
            put("title", PushMessage.parse(data)!!.payload.title!!)
            put("message", buildJsonObject { data.forEach { (key, value) -> put(key, value) } })
        }.toString())
        capture(file.removeSuffix(".json"))
        // Retain encrypted credentials, binding and event history for the next process.
    }

    private fun resetAndLogin(binding: Boolean = true) {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        http("/__push_reset", "{}")
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a10@example.test")
        compose.onNodeWithText("Password").performTextReplacement("controlled-password")
        compose.pressSignIn()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh &&
            (!binding || app.push.registration.activeBinding() != null) }
    }
    private fun approve() {
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(10_000) { http("/__stats")["pending"]?.jsonPrimitive?.boolean == false }
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Allowed · recorded by the server", substring = true).fetchSemanticsNodes().isNotEmpty() }
        val after = http("/__stats")
        val decision = after.getValue("journal").jsonArray.last().jsonObject
        assertEquals("POST", decision.getValue("method").jsonPrimitive.content)
        assertEquals("/api/sessions/$sessionId/approvals/a1/decision", decision.getValue("path").jsonPrimitive.content)
        assertEquals(buildJsonObject { put("behavior", "allow") }, decision["body"])
        assertEquals("ALLOWED", after.getValue("final").jsonObject.getValue("status").jsonPrimitive.content)
        File(output, "${name.methodName}-stats.json").writeText(after.toString())
    }
    private fun launch(intent: Intent) {
        instrument.runOnMainSync { app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        await("Activity resumed") { resumed is MainActivity }
    }
    private fun open(link: String) {
        instrument.runOnMainSync { (resumed as MainActivity).startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link), app, MainActivity::class.java)) }
        compose.waitUntil(10_000) { ObjectId.same(sessionId, app.realtime.state.value.session?.id) }
    }
    private fun home() {
        assertTrue(instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME))
        // Stopped, not merely paused: only then does the controller treat an alert as background.
        await("background") { resumed == null && started.isEmpty() }
        instrument.waitForIdleSync()
    }
    private fun awaitCard() = compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("approval:a1:ALLOW") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    private fun alert(title: String) = mapOf("version" to "1", "type" to "alert", "registrationKey" to app.push.registration.activeBinding()!!.registrationKey,
        "eventId" to UUID.randomUUID().toString(), "notificationKey" to "approval-${ObjectId.canonical(sessionId)!!}", "sentAt" to "2026-10-07T00:00:00Z",
        "payload" to buildJsonObject { put("kind", "approval"); put("category", "ORBIT_APPROVAL"); put("sessionID", ObjectId.canonical(sessionId)!!)
            put("threadId", ObjectId.canonical(sessionId)!!)
            put("title", title); put("body", "Controlled pending approval for cold navigation.") }.toString())
    private fun findPermissionButton(): AccessibilityNodeInfo? {
        val service = instrument.uiAutomation.serviceInfo
        service.flags = service.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        instrument.uiAutomation.serviceInfo = service
        fun find(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
            if (node == null || depth > 30) return null
            if (node.isVisibleToUser && (node.viewIdResourceName?.endsWith(":id/permission_deny_button") == true ||
                    node.text?.toString()?.matches(Regex("Don.t allow", RegexOption.IGNORE_CASE)) == true)) return node
            for (index in 0 until node.childCount) find(node.getChild(index), depth + 1)?.let { return it }
            return null
        }
        return (instrument.uiAutomation.windows.mapNotNull { it.root } + listOfNotNull(instrument.uiAutomation.rootInActiveWindow))
            .firstNotNullOfOrNull { find(it, 0) }
    }
    private fun awaitPermissionButton(): AccessibilityNodeInfo {
        var button: AccessibilityNodeInfo? = null
        await("system permission request") { findPermissionButton().also { button = it } != null }
        return button!!
    }
    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.encodeToByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun await(what: String, timeoutMillis: Long = 15_000, check: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeoutMillis
        while (!check()) {
            if (SystemClock.elapsedRealtime() >= until) { capture("${name.methodName}-timeout"); fail("Timed out: $what") }
            SystemClock.sleep(100)
        }
    }
    private fun capture(label: String) {
        SystemClock.sleep(1_000) // The emulator's software renderer presents frames after the UI state settles.
        instrument.uiAutomation.takeScreenshot()?.let { image -> File(output, "$label.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
    }
}
